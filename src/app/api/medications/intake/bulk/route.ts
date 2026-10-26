/**
 * `POST /api/medications/intake/bulk` — iOS SyncMode bulk backfill
 * for medication intake events.
 *
 * Mirrors the mood-entries bulk endpoint shape so the iOS sync
 * engine reuses the same retry / cursor plumbing for both.
 *
 * Body:
 *   { entries: BulkIntakeEntry[] }    — capped at 500 per call.
 *
 * Each entry:
 *   {
 *     medicationId,          — required (existing Medication row)
 *     scheduledFor,          — ISO timestamp (offset); defaults to now()
 *     takenAt?,              — ISO timestamp; omit + skipped=false = pending
 *     skipped?,              — boolean; default false
 *     idempotencyKey?,       — Medication.intake_events.idempotency_key
 *                              (existing UNIQUE column; serves as the
 *                              per-entry dedup hint)
 *     forceSlotInstant?,     — ISO timestamp; pins a taken entry onto a
 *                              named real scheduled slot (server-validated
 *                              against the band anchors)
 *     source?,               — "APPLE_HEALTH" only (v1.28 HealthKit dose
 *                              import); absent keeps the default "API".
 *                              Requires externalId and a medication
 *                              mirrored from Apple Health.
 *     externalId?,           — HK dose-event UUID (max 128); drives the
 *                              idempotent re-sync dedup (first-write-wins
 *                              per Apple dose)
 *   }
 *
 * Top level also takes `syncTrigger?` (foreground | background | push |
 * manual, v1.42.4), diagnostic only: it dates the `MEDICATION_DOSE` entry of
 * the Apple Health per-type arrival record and changes no row.
 *
 * Response (always 200): processed / inserted / duplicates / skipped /
 * entries[] mirroring the measurements + workouts batch envelope.
 *
 * Locked contract — see `.planning/v15-ios-handoff/06-ios-responsibilities.md`
 * §"Cumulative metrics" sibling section for the SyncMode rationale.
 */
import { auditLog } from "@/lib/auth/audit";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, isScopedCredential, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { HEALTHKIT_REQUEST_SYNC_TRIGGERS } from "@/lib/integrations/healthkit-type-sync";
import {
  boundedTakenAtSchema,
  injectionSiteEnum,
} from "@/lib/validations/medication";
import { isoDateTime } from "@/lib/validations/datetime";
import { ingestBulkIntake } from "@/lib/medications/intake-bulk/ingest";

const MAX_ENTRIES_PER_BATCH = 500;
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkEntrySchema = z
  .object({
    medicationId: z.string().min(1),
    scheduledFor: isoDateTime()
      .transform((s) => new Date(s))
      .optional(),
    // v1.16.9 — shared plausibility bounds (no future beyond clock skew,
    // 5-year floor), matching the single-intake create + edit paths.
    takenAt: boundedTakenAtSchema.optional(),
    skipped: z.boolean().optional().default(false),
    // Persisted to the `@unique` `idempotency_key` column and matched by
    // equality forever, so it is an identity and carries the same
    // stability floor. Checked per entry for the same reason as
    // `externalId` above.
    // @external-id-checked-per-entry: src/lib/medications/intake-bulk/entry.ts
    idempotencyKey: z.string().min(1).max(128).optional(),
    // v1.8.5 — optional per-entry injection site. Validated against the
    // medication's effective allowed set; a disallowed site marks the
    // entry skipped (`injection_site_not_allowed`) without failing the
    // whole batch, matching the bulk endpoint's per-entry contract.
    injectionSite: injectionSiteEnum.optional(),
    // v1.15.20 — late-take "attribute anyway" pin, mirroring the single
    // intake route: pin a taken entry onto a named real scheduled slot
    // instead of the default window-band attribution. Validated server-side
    // against the band anchors; an instant that is not a slot marks the
    // entry skipped (`force_slot_invalid`) per the bulk per-entry contract.
    // Ignored on non-taken entries (a pending echo / skip carries no take
    // to attribute).
    forceSlotInstant: isoDateTime()
      .transform((s) => new Date(s))
      .optional(),
    // v1.16.4 — per-entry dose override, mirroring the single intake
    // route: free text (max 50 chars, like `Medication.dose`), persisted
    // only on a taken entry. Absent = the configured medication dose
    // applies.
    doseTaken: z.string().trim().min(1).max(50).optional(),
    // v1.28 — Apple Health dose-event import (iOS 26+ HealthKit
    // Medications API). Only the APPLE_HEALTH literal is accepted — the
    // other IntakeSource values stay server-owned; absent keeps today's
    // default ("API"). Must carry `externalId` (refine below), and may
    // only target a medication mirrored from Apple Health (route-level
    // 422). logStatus mapping is client-side: iOS ships taken/skipped
    // shaped like every other entry.
    source: z.literal("APPLE_HEALTH").optional(),
    // v1.28 — the HealthKit `HKMedicationDoseEvent` UUID. Drives the
    // idempotent re-sync: an entry whose `(userId, externalId)` already
    // exists live reports `duplicate` (first-write-wins per Apple dose).
    // Stability is enforced per entry in the loop below, not at the
    // field: a schema-level refusal would fail the whole batch on one
    // bad row.
    // @external-id-checked-per-entry: src/lib/medications/intake-bulk/entry.ts
    externalId: z.string().trim().min(1).max(128).optional(),
  })
  .refine(
    // v1.28 — both-or-neither: an Apple entry without its dose-event UUID
    // cannot dedup, and a bare externalId without the source label has no
    // defined provenance.
    (e) => (e.source === "APPLE_HEALTH") === (e.externalId !== undefined),
    {
      message: "source APPLE_HEALTH and externalId must be supplied together",
      path: ["externalId"],
    },
  );

const bulkPayloadSchema = z.object({
  entries: z.array(bulkEntrySchema).min(1).max(MAX_ENTRIES_PER_BATCH),
  // v1.42.4 — what woke the phone for this sync, the same diagnostic-only
  // field `POST /api/measurements/batch` takes. It changes no row; it only
  // feeds the `MEDICATION_DOSE` arrival record below.
  // v1.43 (ios #77) — `backfill` for a history catch-up: it moves only the
  // dose entry's `lastBackfillAt`, never the live stamps or the checkpoint.
  syncTrigger: z.enum(HEALTHKIT_REQUEST_SYNC_TRIGGERS).optional(),
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulk));

async function postBulk(request: NextRequest): Promise<Response> {
  // Metered by this route's own bulk bucket below, not the shared per-account
  // write bucket: the native client syncs through here in bursts (see
  // `meterAccountWrite`).
  const auth = await requireAuth(undefined, { writeBucket: "own" });
  const { user } = auth;
  // A narrow, single-purpose credential (a bridge, an ingest token) is no
  // Apple Health sync, so it never writes the dose arrival record. The bare
  // `requireAuth()` refuses such a credential today; the check keeps the
  // record honest should this route ever declare a scope.
  const scoped = isScopedCredential(auth);

  const rl = await checkRateLimit(
    `medications:intake:bulk:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 2 * 1024 * 1024,
  });
  if (jsonError) return jsonError;

  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_ENTRIES_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_ENTRIES_PER_BATCH}-entry limit`,
      422,
      { errorCode: "medications.intake.bulk.too_large" },
    );
  }

  const parsed = bulkPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    // Bulk intake ingest; preserve the existing
    // `medications.intake.bulk.invalid` errorCode meta so the iOS
    // Sync engine's retry classifier still branches on it. Audit
    // breadcrumb keyed `medications.intake.bulk.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.bulk.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // Strip `message` from the audit-ledger row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    auditLog("medications.intake.bulk.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "medications.intake.bulk.invalid",
    });
  }

  const { entries, syncTrigger } = parsed.data;

  const outcome = await ingestBulkIntake({
    user,
    scoped,
    entries,
    syncTrigger,
    ipAddress: getClientIp(request),
    originDeviceToken: request.headers.get("x-device-id"),
  });
  if (outcome.kind === "refused") {
    return apiError(outcome.message, 422, { errorCode: outcome.errorCode });
  }
  return apiSuccess(outcome.body);
}
