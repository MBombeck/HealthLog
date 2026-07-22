import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma, toJson } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  MEDICATION_INTAKE_IMPORT_QUEUE,
  MEDICATION_INTAKE_IMPORT_SEND_OPTIONS,
  MEDICATION_INTAKE_IMPORT_STALE_AFTER_MS,
  type MedicationImportPayload,
  type MedicationImportProgress,
} from "@/lib/jobs/medication-intake-import";
import { annotate } from "@/lib/logging/context";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";

const importEntrySchema = z.object({
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  uhrzeit: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  zaehler: z.union([z.number().int(), z.string()]).optional(),
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

const validatedImportEntrySchema = importEntrySchema.refine(
  ({ datum, uhrzeit }) => isValidImportTimestamp(datum, uhrzeit),
  { message: "Invalid date or time" },
);

const validatedImportSchema = z
  .array(validatedImportEntrySchema)
  .min(1)
  .max(1000);

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.5.5 C-E3-3 — route ownership through the shared helper so the
    // 404 leak shape stays identical across every `[id]/**` handler.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 1024 * 1024,
    });

    if (jsonError) return jsonError;

    // Support both direct arrays and object-with-array payloads
    const payload = Array.isArray(body)
      ? body
      : typeof body === "object" && body !== null
        ? Object.values(body).find((value) => Array.isArray(value))
        : null;

    const parsed = validatedImportSchema.safeParse(payload);
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
    const normalized: MedicationImportPayload = {
      entries: entries.map((entry) => {
        const takenAt = new Date(`${entry.datum}T${entry.uhrzeit}`);
        const idempotencyKey = entry.zaehler
          ? `import-${id}-${String(entry.zaehler)}`
          : `import-${id}-${takenAt.getTime()}`;
        return { takenAt: takenAt.toISOString(), idempotencyKey };
      }),
    };
    const progress: MedicationImportProgress = {
      processed: 0,
      total: normalized.entries.length,
      imported: 0,
      skippedDuplicates: 0,
      touchedDays: [],
      rollupProcessed: 0,
    };
    const admission = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "medications"
        WHERE "id" = ${id}
          AND "user_id" = ${user.id}
        FOR UPDATE
      `;
      const now = new Date();
      const staleBefore = new Date(
        now.getTime() - MEDICATION_INTAKE_IMPORT_STALE_AFTER_MS,
      );
      await tx.medicationIntakeImportJob.updateMany({
        where: {
          userId: user.id,
          medicationId: id,
          status: { in: ["queued", "running"] },
          OR: [
            { heartbeatAt: { lt: staleBefore } },
            {
              heartbeatAt: null,
              startedAt: { lt: staleBefore },
            },
            {
              heartbeatAt: null,
              startedAt: null,
              createdAt: { lt: staleBefore },
            },
          ],
        },
        data: {
          status: "failed",
          failureReason: "Medication intake import abandoned",
          heartbeatAt: now,
          completedAt: now,
        },
      });
      const activeJob = await tx.medicationIntakeImportJob.findFirst({
        where: {
          userId: user.id,
          medicationId: id,
          status: { in: ["queued", "running"] },
        },
        select: { id: true },
      });
      if (activeJob) return { active: true as const };

      const importJob = await tx.medicationIntakeImportJob.create({
        data: {
          userId: user.id,
          medicationId: id,
          status: "queued",
          payload: toJson(normalized),
          progress: toJson(progress),
        },
      });
      return { active: false as const, importJob };
    });
    if (admission.active) {
      return apiError("Medication intake import already in progress", 409);
    }
    const { importJob } = admission;

    let bossJobId: string | null = null;
    try {
      const boss = getGlobalBoss();
      if (!boss) throw new Error("worker unavailable");
      bossJobId = await boss.send(
        MEDICATION_INTAKE_IMPORT_QUEUE,
        { jobId: importJob.id },
        MEDICATION_INTAKE_IMPORT_SEND_OPTIONS,
      );
      if (!bossJobId) throw new Error("queue rejected job");
      await prisma.medicationIntakeImportJob.update({
        where: { id: importJob.id },
        data: { pgBossJobId: bossJobId },
      });
    } catch {
      const completedAt = new Date();
      await prisma.medicationIntakeImportJob.update({
        where: { id: importJob.id },
        data: {
          status: "failed",
          failureReason: "Background worker enqueue failed",
          heartbeatAt: completedAt,
          completedAt,
        },
      });
      await auditLog("medication.intake.import.kickoff.denied", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: {
          jobId: importJob.id,
          medicationId: id,
          reason: "enqueue_failed",
        },
      });
      return apiError("Background worker is not available", 503);
    }

    await auditLog("medication.intake.import.kickoff", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        jobId: importJob.id,
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
        job_id: importJob.id,
        total: normalized.entries.length,
      },
    });

    return apiSuccess(
      {
        jobId: importJob.id,
        status: "queued" as const,
        statusUrl: `/api/medications/${id}/intake/import/${importJob.id}/status`,
      },
      202,
    );
  },
);
