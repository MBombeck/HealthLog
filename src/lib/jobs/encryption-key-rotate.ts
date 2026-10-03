/**
 * v1.23 — admin-triggered encryption-key rotation, on pg-boss.
 *
 * Re-encrypts every registered encrypted column to the configured ACTIVE key
 * id, reusing the canonical column registry via `rotateCorpus()`. The admin
 * panel triggers it, and it is the documented primary path; the CLI
 * (`scripts/rotate-encryption-key.ts`) does the same from a source checkout.
 * pg-boss is the right home because the standalone production image strips
 * `tsx`, so a button that ran the CLI inside the container would fail.
 *
 * SAFETY (security-review surface):
 *  - ACTIVE-KEY-ONLY + NEVER ADDS / DROPS A KEY: `rotateCorpus()` only ever
 *    writes the active key and never touches the env key map. Dropping a key
 *    stays an operator env + redeploy act.
 *  - IDEMPOTENT: rows already on the active key are skipped, so re-running (or
 *    the singleton coalescing a duplicate trigger) re-encrypts nothing.
 *  - FAIL-CLOSED per row: a row under a no-longer-configured key is counted as
 *    an error and left untouched, never dropped.
 *
 * On-demand only — no cron. The admin POST enqueues with a fixed singletonKey
 * so two concurrent triggers collapse into one run. Completion is recorded both
 * as a background wide-event and an `admin.encryption.rotate.completed` audit
 * entry that the status view reads to show the last run.
 */
import { type Job } from "pg-boss";
import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { jobBudget } from "@/lib/jobs/job-budget";
import { auditLog } from "@/lib/auth/audit";
import {
  rotateCorpus,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { getWorkerPrisma } from "@/lib/jobs/reminder/shared";
import {
  retireCanariesWithoutData,
  type CanaryClient,
} from "@/lib/crypto/canary";

export const ENCRYPTION_KEY_ROTATE_QUEUE = "encryption-key-rotate";
export const ENCRYPTION_KEY_ROTATE_CONCURRENCY = 1;
/** Fixed key so duplicate admin triggers coalesce into one queued run. */
export const ENCRYPTION_KEY_ROTATE_SINGLETON = "encryption-key-rotate";

/**
 * The job's expiry: twelve hours. The pass re-encrypts every encrypted column
 * on the instance and outlasted pg-boss's fifteen-minute default, which
 * retried it beside itself. The pass stops at three quarters of this
 * (`jobBudget`) and holds a lock (`lockedPass`); the admin route's send
 * carries it.
 */
export const ENCRYPTION_KEY_ROTATE_EXPIRE_SECONDS = 12 * 60 * 60;

export interface EncryptionKeyRotatePayload {
  /** The admin who triggered the run (for the audit trail). */
  requestedByUserId?: string;
  enqueuedAt?: string;
}

export async function runEncryptionKeyRotation(
  shouldStop: () => boolean = () => false,
): Promise<{
  activeKeyId: string;
  totalScanned: number;
  totalRotated: number;
  totalErrors: number;
  totalDropped: number;
  stoppedEarly: boolean;
  /** Key ids whose boot key-check record this run removed. */
  retiredKeyIds: string[];
}> {
  const prisma = getWorkerPrisma();
  const out = await rotateCorpus(prisma as unknown as CorpusClient, shouldStop);
  // A complete, error-free pass: remove the boot key check's record of every
  // other key id that no longer holds a value in any registered column, so
  // its key can leave ENCRYPTION_KEYS and the id can never refuse a later,
  // different key. The existence check walks every column itself.
  const retiredKeyIds =
    !out.stoppedEarly && out.totalErrors === 0
      ? (await retireCanariesWithoutData(prisma as unknown as CanaryClient))
          .removed
      : [];
  return {
    activeKeyId: out.activeKeyId,
    totalScanned: out.totalScanned,
    totalRotated: out.totalRotated,
    totalErrors: out.totalErrors,
    totalDropped: out.totalDropped,
    stoppedEarly: out.stoppedEarly,
    retiredKeyIds,
  };
}

export async function handleEncryptionKeyRotate(
  jobs: Job<EncryptionKeyRotatePayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.encryption_key_rotate", async (evt) => {
    const requestedBy = jobs[0]?.data?.requestedByUserId ?? null;
    try {
      // A whole-corpus pass: it stops between rows once the job's budget is
      // spent, and says so in the audit row, so the operator runs it again
      // to finish (rows already rotated are skipped).
      const result = await runEncryptionKeyRotation(jobBudget(jobs));
      evt.addMeta("rotate_active_key_id", result.activeKeyId);
      evt.addMeta("rotate_scanned", result.totalScanned);
      evt.addMeta("rotate_rotated", result.totalRotated);
      evt.addMeta("rotate_errors", result.totalErrors);
      evt.addMeta("rotate_dropped", result.totalDropped);
      await auditLog("admin.encryption.rotate.completed", {
        userId: requestedBy,
        details: {
          activeKeyId: result.activeKeyId,
          scanned: result.totalScanned,
          rotated: result.totalRotated,
          errors: result.totalErrors,
          dropped: result.totalDropped,
          retiredKeyIds: result.retiredKeyIds,
        },
      });
      // Per-row errors are the fail-closed skip of a row under a key the
      // deployment no longer configures. The pass still ran, so they ride out
      // as a count rather than failing (and retrying) the whole corpus.
      return jobDone({
        rotate_scanned: result.totalScanned,
        rotate_rotated: result.totalRotated,
        rotate_errors: result.totalErrors,
        rotate_dropped: result.totalDropped,
      });
    } catch (err) {
      evt.addWarning(`encryption-key-rotate failed: ${err}`);
      await auditLog("admin.encryption.rotate.failed", {
        userId: requestedBy,
        details: { message: err instanceof Error ? err.message : String(err) },
      });
      // Re-throw so pg-boss records the failure (the run is idempotent, so a
      // retry is safe).
      throw err;
    }
  });
}
