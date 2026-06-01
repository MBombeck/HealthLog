import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import {
  recomputeMedicationComplianceForDay,
  dayKeyForScheduledFor,
} from "@/lib/rollups/medication-compliance-rollups";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const importEntrySchema = z.object({
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  uhrzeit: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  zaehler: z.union([z.number().int(), z.string()]).optional(),
});

const importSchema = z.array(importEntrySchema).min(1).max(1000);

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.5.5 C-E3-3 — route ownership through the shared helper so the
    // 404 leak shape stays identical across every `[id]/**` handler.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;

    // Support both direct arrays and object-with-array payloads
    const payload = Array.isArray(body)
      ? body
      : typeof body === "object" && body !== null
        ? Object.values(body).find((value) => Array.isArray(value))
        : null;

    const parsed = importSchema.safeParse(payload);
    if (!parsed.success) {
      // v1.4.43 W6 — CSV import; preserve the `Invalid format:` prefix
      // semantics for the existing client-side branch by setting the
      // `errorCode: "medication.intake.import.invalid_format"` meta.
      // The client UI can now branch on `meta.errorCode` while every
      // Zod issue is also surfaced under `details.issues`. Bulk-import
      // path → audit breadcrumb keyed
      // `medications.intake.import.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "medications.intake.import.validation-failed" },
        meta: { issue_count: issues.length, medication_id: id },
      });
      // v1.4.49 — strip `message` from the audit-ledger row; CSV
      // imports carry caller-provided strings that Zod may echo.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "medications.intake.import.validation-failed",
            details: JSON.stringify({
              issues: auditIssues,
              medicationId: id,
            }),
          },
        })
        .catch(() => {
          /* swallow — 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "medication.intake.import.invalid_format",
      });
    }

    const entries = parsed.data;
    let imported = 0;
    let skippedDuplicates = 0;
    let skippedInvalid = 0;
    // v1.4.39 W-MED — collect distinct day-keys touched by the import
    // so the rollup pass fires once per day rather than once per row.
    const touchedDays = new Set<string>();

    for (const entry of entries) {
      // Parse as local datetime first; if invalid, fall back to CET offset.
      let takenAt = new Date(`${entry.datum}T${entry.uhrzeit}`);
      if (isNaN(takenAt.getTime())) {
        takenAt = new Date(`${entry.datum}T${entry.uhrzeit}+01:00`);
      }
      if (isNaN(takenAt.getTime())) {
        skippedInvalid++;
        continue;
      }

      // Prefer explicit counter; otherwise use timestamp-based dedup key.
      const idempotencyKey = entry.zaehler
        ? `import-${id}-${String(entry.zaehler)}`
        : `import-${id}-${takenAt.getTime()}`;

      const existing = await prisma.medicationIntakeEvent.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        skippedDuplicates++;
        continue;
      }

      await prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: id,
          scheduledFor: takenAt,
          takenAt,
          skipped: false,
          source: "IMPORT",
          idempotencyKey,
        },
      });
      imported++;
      touchedDays.add(dayKeyForScheduledFor(takenAt, user.timezone));
    }

    // v1.4.39 W-MED — fold the touched days into rollup rows after the
    // insert loop completes. Best-effort: a populator failure logs but
    // never rolls back the imported events.
    for (const dayKey of touchedDays) {
      try {
        await recomputeMedicationComplianceForDay(
          user.id,
          id,
          dayKey,
          user.timezone,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        annotate({
          meta: {
            medication_compliance_rollup_import_failed: true,
            medication_compliance_rollup_import_error: message,
            medication_compliance_rollup_day: dayKey,
          },
        });
      }
    }

    await auditLog("medication.intake.import", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        imported,
        skippedDuplicates,
        skippedInvalid,
        total: entries.length,
      },
    });

    annotate({
      action: {
        name: "medication.intake.import",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        imported,
        skippedDuplicates,
        skippedInvalid,
        total: entries.length,
      },
    });

    return apiSuccess({ imported, skippedDuplicates, skippedInvalid }, 201);
  },
);
