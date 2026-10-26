import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import {
  type MedicationImportPayload,
  type MedicationImportProgress,
} from "@/lib/jobs/medication-intake-import";
import { annotate } from "@/lib/logging/context";
import { admitIntakeImportJob } from "@/lib/medications/intake-import-admission";
import { buildMedicationImportEntries } from "@/lib/medications/intake-import-payload";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { isPlausibleEntryInstant } from "@/lib/validations/entry-instant";

// The entry shape carried a third field, `zaehler`, and the replay key was
// built from it whenever it was present. That reads as a per-row counter,
// which is what the example beside this dialog showed — but the field was
// optional, its uniqueness was never stated and never checked, and nothing
// told anyone it carried identity. A submission that repeated one value down
// the column collapsed a month of history onto one key: the first row
// imported, every later one lost the `(userId, idempotencyKey)` unique and
// came back reported as a duplicate of a dose it had nothing to do with.
//
// The reported file repeated `1.0` because it was modelled on the example this
// dialog itself displayed, which counted upward and explained nothing. So the
// fault was never in the submission; it was in a field that decided identity
// while presenting itself as a quantity.
//
// `zaehler` is gone from the contract rather than accepted-and-ignored. A
// payload that still carries it imports unchanged — `z.object` drops
// unrecognised keys — it simply no longer decides anything. The key now comes
// from the instant (`buildMedicationImportEntries`), which is also the grain
// the database already enforces: the live-row unique on
// `(user_id, medication_id, scheduled_for, source)` makes an imported dose
// unique per instant whatever the key says, so a re-import of a file first
// imported under the old key still dedups.
const importEntrySchema = z.object({
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  uhrzeit: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
});

function isValidImportTimestamp(datum: string, uhrzeit: string): boolean {
  const [year, month, day] = datum.split("-").map(Number);
  const [hour, minute, second] = uhrzeit.split(":").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day &&
    value.getUTCHours() === hour &&
    value.getUTCMinutes() === minute &&
    value.getUTCSeconds() === second
  );
}

const validatedImportEntrySchema = importEntrySchema
  .refine(({ datum, uhrzeit }) => isValidImportTimestamp(datum, uhrzeit), {
    message: "Invalid date or time",
  })
  // The `\d{4}-\d{2}-\d{2}` regex above has no upper bound, so a `2999-12-31`
  // row would enqueue a future "taken" intake that then feeds compliance and
  // the dose-history ledger through the worker. The single and bulk intake
  // twins bound this through `boundedTakenAtSchema`; this path did not. The
  // past side stays open (no `maxAgeMs`, only the 1900 floor) because
  // importing years of history is the whole point of this route, so only the
  // future bound applies.
  .refine(
    ({ datum, uhrzeit }) =>
      isPlausibleEntryInstant(new Date(`${datum}T${uhrzeit}`)),
    { message: "Timestamp is not a plausible capture time" },
  );

const validatedImportSchema = z
  .array(validatedImportEntrySchema)
  .min(1)
  .max(1000);

// Mirrors the bulk intake twin's budget. The heavy find + create +
// inventory-consume loop now runs in the background worker, but the admission
// transaction still does per-request DB work (a `FOR UPDATE` lock plus a stale
// -job sweep), so the same limiter the bulk twin carries keeps a rapid-fire
// caller from hammering it.
const IMPORT_RATE_LIMIT_MAX = 60;
const IMPORT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. The import is additive with duplicates skipped, every
    // written row tombstones, and the provenance it stamps (`IMPORT`) stays
    // true under delegation because it describes where the data came from and
    // not who typed it. C9: the enqueued job outlives this request, so the
    // kickoff audit row below joins it by `jobId`.
    const { user, actor } = await requireRecordAuth("manage", "medications");

    const { id } = await params;
    // v1.5.5 — route ownership through the shared helper so the
    // 404 leak shape stays identical across every `[id]` handler.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    // v1.37.0 — C1: keyed on the ACTOR, so a manager burns their own
    // allowance and cannot collect a fresh one by switching records.
    const rl = await checkRateLimit(
      `medications:intake:import:${actor.id}`,
      IMPORT_RATE_LIMIT_MAX,
      IMPORT_RATE_LIMIT_WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many import submissions, try again later", 429);
    }

    // v1.4.43 — CSV import; preserve the `Invalid format:` prefix
    // semantics for the existing client-side branch by setting the
    // `errorCode: "medication.intake.import.invalid_format"` meta.
    // The client UI can now branch on `meta.errorCode` while every
    // Zod issue is also surfaced under `details.issues`. Bulk-import
    // path → audit breadcrumb keyed
    // `medications.intake.import.validation-failed`.
    const parsed = await parseJsonBody(request, validatedImportSchema, {
      maxBytes: 1024 * 1024,
      // Support both direct arrays and object-with-array payloads
      input: (body) =>
        Array.isArray(body)
          ? body
          : typeof body === "object" && body !== null
            ? Object.values(body).find((value) => Array.isArray(value))
            : null,
      action: "medications.intake.import.validation-failed",
      countIssues: true,
      meta: { medication_id: id },
      errorCode: "medication.intake.import.invalid_format",
      onInvalid: (error) => {
        // v1.4.49 — strip `message` from the audit-ledger row; CSV
        // imports carry caller-provided strings that Zod may echo.
        const auditIssues = sanitiseZodIssues(error.issues, {
          stripValuesFromMessage: true,
        });
        // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
        // .create`, because that helper is the only writer that stamps
        // `actorUserId`. Filed under the resolved record either way; without
        // the stamp a manager's malformed payload would read as the owner's own.
        void auditLog("medications.intake.import.validation-failed", {
          userId: user.id,
          details: {
            issues: auditIssues,
            medicationId: id,
          },
        }).catch(() => {
          /* swallow — 422 response is the contract */
        });
      },
    });
    if (!parsed.ok) return parsed.error;

    const entries = parsed.data;
    const normalized: MedicationImportPayload = {
      entries: buildMedicationImportEntries(id, entries),
    };
    const progress: MedicationImportProgress = {
      processed: 0,
      total: normalized.entries.length,
      imported: 0,
      skippedByReason: {},
      skipDetails: [],
      skippedDetailsOmitted: 0,
      touchedDays: [],
      rollupProcessed: 0,
    };
    const admission = await admitIntakeImportJob({
      recordUserId: user.id,
      actorUserId: actor.id,
      medicationId: id,
      payload: normalized,
      progress,
      ipAddress: getClientIp(request),
    });
    if (!admission.admitted) {
      return apiError("Medication intake import already in progress", 409);
    }
    if (!admission.enqueued) {
      return apiError("Background worker is not available", 503);
    }
    const { jobId, bossJobId } = admission;

    await auditLog("medication.intake.import.kickoff", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        jobId,
        bossJobId,
        medicationId: id,
        total: normalized.entries.length,
      },
    });
    annotate({
      action: {
        name: "medication.intake.import.kickoff",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        job_id: jobId,
        total: normalized.entries.length,
      },
    });

    return apiSuccess(
      {
        jobId,
        status: "queued" as const,
        statusUrl: `/api/medications/${id}/intake/import/${jobId}/status`,
      },
      202,
    );
  },
);
