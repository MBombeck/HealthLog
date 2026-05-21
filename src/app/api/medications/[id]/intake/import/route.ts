import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
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
    const medication = await prisma.medication.findUnique({ where: { id } });
    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

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
      return apiError(`Invalid format: ${parsed.error.issues[0].message}`, 422);
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
