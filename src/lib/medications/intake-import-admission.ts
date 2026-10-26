/**
 * The one admission path for an intake-import job.
 *
 * Two routes queue this work — the per-medication import under
 * `/api/medications/[id]/…` and the account-wide dose-history import — and both
 * have to do the same five things in the same order: take a row lock so two
 * submissions cannot race past each other, fail out any job the worker
 * abandoned, refuse if one is genuinely still running, write the job row, and
 * hand it to pg-boss with a fallback that marks the row failed when the queue
 * is not there. Written twice, those five steps drift: one route grows a
 * staleness clause the other does not, and the difference only shows up as an
 * import that hangs forever on one surface and not the other.
 *
 * `readMedicationIntakeImportJob` took the read half of this pair out of the
 * routes for the same reason. This is the write half.
 *
 * The only real difference between the two callers is scope, and it is one
 * argument: `medicationId` narrows the lock, the active-job check and the job
 * row to a single medication, `null` means the whole account. Everything the
 * caller still owns — the 409 wording, the success envelope, the kickoff audit
 * line — stays at the call site, because those are the parts the two surfaces
 * legitimately say differently.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  MEDICATION_INTAKE_IMPORT_SEND_OPTIONS,
  MEDICATION_INTAKE_IMPORT_STALE_AFTER_MS,
  type MedicationImportPayload,
  type MedicationImportProgress,
} from "@/lib/jobs/medication-intake-import";
import { MEDICATION_INTAKE_IMPORT_QUEUE } from "@/lib/jobs/medication-intake-import-queue";
import { auditLog } from "@/lib/auth/audit";
import { prisma, toJson } from "@/lib/db";

export interface IntakeImportAdmissionInput {
  recordUserId: string;
  actorUserId: string;
  /** `null` = the account-wide dose-history import. */
  medicationId: string | null;
  payload: MedicationImportPayload;
  progress: MedicationImportProgress;
  /** Threaded onto the enqueue-failure audit row; `null` when unresolved. */
  ipAddress: string | null;
}

export type IntakeImportAdmission =
  /** An import for this scope is already queued or running. */
  | { admitted: false }
  /**
   * The job row exists but the queue would not take it, so the row is already
   * marked failed and the audit line is written. The caller answers 503.
   */
  | { admitted: true; enqueued: false; jobId: string }
  | { admitted: true; enqueued: true; jobId: string; bossJobId: string };

/**
 * Claim the import slot for one scope and hand the job to the worker.
 *
 * The lock is taken on the row the scope belongs to — the medication for a
 * per-medication import, the account for the dose-history import — so two
 * submissions serialise against each other without blocking an unrelated one.
 */
export async function admitIntakeImportJob({
  recordUserId,
  actorUserId,
  medicationId,
  payload,
  progress,
  ipAddress,
}: IntakeImportAdmissionInput): Promise<IntakeImportAdmission> {
  const admission = await prisma.$transaction(async (tx) => {
    if (medicationId === null) {
      await tx.$queryRaw`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${recordUserId}
        FOR UPDATE
      `;
    } else {
      await tx.$queryRaw`
        SELECT "id"
        FROM "medications"
        WHERE "id" = ${medicationId}
          AND "user_id" = ${recordUserId}
        FOR UPDATE
      `;
    }

    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - MEDICATION_INTAKE_IMPORT_STALE_AFTER_MS,
    );
    // A worker that died mid-run leaves a row that says "running" forever, and
    // the active-job check below would then refuse every later submission. The
    // three clauses cover the three points a run can stop at: after a
    // heartbeat, after the start, and before either.
    await tx.medicationIntakeImportJob.updateMany({
      where: {
        recordUserId,
        medicationId,
        status: { in: ["queued", "running"] },
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          { heartbeatAt: null, startedAt: { lt: staleBefore } },
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
        recordUserId,
        medicationId,
        status: { in: ["queued", "running"] },
      },
      select: { id: true },
    });
    if (activeJob) return { active: true as const };

    const importJob = await tx.medicationIntakeImportJob.create({
      data: {
        recordUserId,
        actorUserId,
        medicationId,
        status: "queued",
        payload: toJson(payload),
        progress: toJson(progress),
      },
    });
    return { active: false as const, importJob };
  });

  if (admission.active) return { admitted: false };
  const jobId = admission.importJob.id;

  try {
    const boss = getGlobalBoss();
    if (!boss) throw new Error("worker unavailable");
    const bossJobId = await boss.send(
      MEDICATION_INTAKE_IMPORT_QUEUE,
      { jobId },
      MEDICATION_INTAKE_IMPORT_SEND_OPTIONS,
    );
    if (!bossJobId) throw new Error("queue rejected job");
    await prisma.medicationIntakeImportJob.update({
      where: { id: jobId },
      data: { pgBossJobId: bossJobId },
    });
    return { admitted: true, enqueued: true, jobId, bossJobId };
  } catch {
    // The row is already written, so leaving it queued would park the scope
    // behind a job nobody will ever pick up. Fail it here and the next
    // submission is admitted immediately.
    const completedAt = new Date();
    await prisma.medicationIntakeImportJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        failureReason: "Background worker enqueue failed",
        heartbeatAt: completedAt,
        completedAt,
      },
    });
    // An audit row, unlike the upload refusals of the export imports, which
    // are signals: this one is shown to the record's owner in the activity
    // feed (`record-activity/activity-verb.ts`) as an import that was
    // admitted and never ran, and it carries the delegate who started it.
    await auditLog("medication.intake.import.kickoff.denied", {
      userId: recordUserId,
      actorUserId,
      ipAddress,
      details: {
        jobId,
        ...(medicationId === null ? {} : { medicationId }),
        reason: "enqueue_failed",
      },
    });
    return { admitted: true, enqueued: false, jobId };
  }
}
