/**
 * Weekly on-host data backup and the nightly off-host backup handler.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { type Job, type JobWithMetadata } from "pg-boss";
import { jobBudget, jobDeadline } from "@/lib/jobs/job-budget";
import { recordError } from "@/lib/jobs/worker-status";
import {
  BackupBlobTooLargeError,
  BackupBusyError,
} from "@/lib/export/backup-blob";
import { writeAccountCopy } from "@/lib/export/account-copy";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  OffhostBackupNotConfiguredError,
  runOffhostBackup,
} from "@/lib/jobs/offhost-backup";
import { getWorkerPrisma } from "./shared";
import { reportJobProgress } from "@/lib/jobs/job-observer";
import {
  markBackupAttemptFinished,
  markBackupAttemptStarted,
  orderInterruptedLast,
  readAccountsToTakeLast,
} from "@/lib/jobs/backup-pass-attempts";
import { DATA_BACKUP_QUEUE } from "@/lib/jobs/data-backup-policy";

/**
 * The nightly whole-database dump (`database-backup`).
 *
 * One `pg_dump` in a child process, so it is not in the heavy lane: the heap
 * holds a part of the upload at a time, not the database. `pg_dump` is stopped
 * at three quarters of the job's expiry (`jobDeadline`), so a dump that hangs
 * on a lock ends as a failed run with its reason rather than an expired job.
 * A skipped run (switched off, nowhere to put it) completes; the admin page
 * and the boot summary carry why.
 */
export async function handleDatabaseBackup(
  jobs: Job<Record<string, never>>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.database_backup", async () => {
    const { runDatabaseBackup } = await import("@/lib/database-backup/run");
    const report = await runDatabaseBackup(getWorkerPrisma(), {
      deadline: jobs[0] ? jobDeadline(jobs[0]) : undefined,
    });
    const did = {
      database_backup_status: report.status,
      database_backup_local: report.local,
      database_backup_offhost: report.offhost,
      database_backup_bytes: report.dumpBytes ?? 0,
      database_backup_removed: report.removed,
    };
    return report.status === "failed"
      ? jobFailed("database dump failed", report.error ?? undefined, did)
      : jobDone(did);
  });
}

export interface DataBackupPayload {
  triggeredAt: string;
}

export interface OffhostBackupPayload {
  triggeredAt: string;
}

export async function handleOffhostBackup(
  jobs: JobWithMetadata<OffhostBackupPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.offhost_backup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      // A retry of this job carries the same creation time, so it resumes
      // after the accounts an earlier attempt uploaded, and the run stops
      // between accounts before the job's expiry would cut one off.
      const report = await runOffhostBackup(p, undefined, new Date(), {
        runStartedAt: jobs[0]?.createdOn,
        shouldStop: jobBudget(jobs),
      });
      evt.addMeta("offhost_backup_uploaded", report.uploaded);
      evt.addMeta("offhost_backup_failed", report.failed);
      evt.addMeta("offhost_backup_total_users", report.totalUsers);
      evt.addMeta("offhost_backup_endpoint", report.config.endpoint);
      evt.addMeta("offhost_backup_bucket", report.config.bucket);
      // The uploaded size is the one number that says whether this pass is
      // heading back towards the wall it hit before: it tracks the record.
      evt.addMeta(
        "offhost_backup_largest_object_bytes",
        report.largestObjectBytes,
      );
      // Per-user failure detail is also emitted as warnings inside
      // runOffhostBackup; echo a structured digest for at-a-glance triage.
      if (report.failures.length > 0) {
        evt.addMeta(
          "offhost_backup_failures",
          JSON.stringify(report.failures.slice(0, 10)),
        );
      }

      const did = {
        offhost_backup_already_uploaded: report.alreadyUploaded,
        stopped_early: report.stoppedEarly,
        offhost_backup_uploaded: report.uploaded,
        offhost_backup_failed: report.failed,
        offhost_backup_total_users: report.totalUsers,
        offhost_backup_oversized: report.oversized,
      };

      // A run that uploaded nothing for anybody put nothing off-host, and
      // `ok: true` about that is how a bucket stays empty while the job page
      // reads healthy — the same rule the weekly pass already carries. Wrong
      // credentials, a bucket that does not exist and a target that refuses
      // the signature all land here, because they fail every account rather
      // than one. Per-account failures still ride out as counts when SOME
      // account got a copy: that is the fan-out rule, and retrying the whole
      // cohort over one object would re-upload everybody's.
      // Out of budget before every account: fail, so pg-boss retries the job,
      // and the retry resumes after the accounts this attempt uploaded.
      if (report.stoppedEarly) {
        return jobFailed(
          "stopped before every account was uploaded; the retry resumes",
          undefined,
          did,
        );
      }

      if (
        report.totalUsers > 0 &&
        report.uploaded + report.alreadyUploaded === 0
      ) {
        // The SDK's own words, not a stack: `runJob` puts the cause message in
        // the reported meta, and "SignatureDoesNotMatch" is the sentence an
        // operator can act on.
        return jobFailed(
          "no account could be uploaded",
          report.failures[0]?.message,
          did,
        );
      }

      // Per-user upload failures ride out as `offhost_backup_failed`: the run
      // itself uploaded what it could, and failing the queue over one user's
      // object would re-upload the whole cohort on every retry.
      return jobDone(did);
    } catch (err) {
      // Not configured ⇒ skip silently with a warning, not an error: most
      // self-hosts never set the S3 credentials, and a nightly failed job on
      // every one of them buries the runs that genuinely could not upload.
      evt.addWarning(`offhost-backup skipped/failed: ${err}`);
      if (err instanceof OffhostBackupNotConfiguredError) {
        return jobDone({ offhost_backup_configured: false });
      }
      return jobFailed("offhost backup failed", err);
    }
  });
}

/**
 * The weekly on-host copy of every account.
 *
 * The pass serialises each account's whole record, so on a large instance it
 * can outlast its job. It walks the accounts whose weekly copy is oldest
 * first and stops between accounts once the job's budget is spent
 * (`jobBudget`), reporting `stopped_early`. The accounts it did not reach have
 * the oldest copies, so they lead the next pass (the weekly cron or the
 * admin's "run now"), and every pass makes progress where it matters most.
 * The binding holds a lock (`lockedPass`), so a retry never runs beside it.
 */
export async function handleDataBackup(
  jobs: Job<DataBackupPayload>[],
): Promise<JobOutcome> {
  const shouldStop = jobBudget(jobs);
  return withBackgroundEvent("job.data_backup", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const [accounts, copies, interrupted] = await Promise.all([
        prisma.user.findMany({
          where: ACTIVE_ACCOUNT,
          select: { id: true, username: true },
        }),
        // account-deletion: copy ages, read against the filtered accounts beside it.
        prisma.dataBackup.findMany({
          where: { type: "WEEKLY_AUTO" },
          select: { userId: true, createdAt: true },
        }),
        readAccountsToTakeLast(prisma, DATA_BACKUP_QUEUE),
      ]);
      const copiedAt = new Map(
        copies.map((copy) => [copy.userId, copy.createdAt.getTime()]),
      );
      // No copy yet sorts first, then the oldest copy. An account whose last
      // attempt never came back goes behind all of them: it is the one with
      // the oldest copy, so it would lead every retry, and a record that
      // killed the process once would keep every account after it from a
      // copy. Only until a later run has started on another account, so a
      // pass that stops on its budget still reaches it the run after
      // (`backup-pass-attempts.ts`).
      const users = orderInterruptedLast(
        [...accounts].sort(
          (a, b) => (copiedAt.get(a.id) ?? -1) - (copiedAt.get(b.id) ?? -1),
        ),
        interrupted,
      );
      if (interrupted.size > 0) {
        evt.addMeta("data_backup_interrupted_accounts", interrupted.size);
      }
      let stoppedEarly = false;

      let backed = 0;
      let usersFailed = 0;
      let oversized = 0;
      let skippedRestoring = 0;
      let largestBlobBytes = 0;
      // Kept for the failure report: without it the run that failed for
      // everybody names no reason at all, which is the shape this pass spent
      // six weeks in.
      let lastError: unknown;
      for (const user of users) {
        if (shouldStop()) {
          stoppedEarly = true;
          break;
        }
        reportJobProgress({
          backup_user: user.id,
          backup_users_done: backed + usersFailed + skippedRestoring,
          backup_users_total: users.length,
        });
        await markBackupAttemptStarted(prisma, DATA_BACKUP_QUEUE, user.id);
        try {
          // The shared account-copy writer (`writeAccountCopy`): streamed,
          // compressed, encrypted and stored a piece at a time, so nothing of
          // the record exists as a whole in this process (#1031). The copy a
          // data wipe takes first goes through the same writer.
          const { bytes: storedBytes } = await writeAccountCopy(
            prisma,
            user.id,
            "WEEKLY_AUTO",
          );
          largestBlobBytes = Math.max(largestBlobBytes, storedBytes);
          backed++;
        } catch (err) {
          // A restore of this account's current copy is queued or running.
          // Replacing the copy would pull it out from under the restore, so
          // the account keeps it and the next run tries again. Not a failure.
          if (err instanceof BackupBusyError) {
            skippedRestoring++;
            evt.addWarning(
              `Skipped user ${user.id}: a restore of the current copy is queued or running`,
            );
            continue;
          }
          // One user's payload failing is that user's problem, not the pass's:
          // it rides out as a count so the weekly run is not retried for the
          // whole cohort.
          //
          // A copy over the stored-copy limit (`BACKUP_MAX_STORED_MB`) lands
          // here too, counted as oversized, with the setting to raise named
          // in the message.
          usersFailed++;
          lastError = err;
          if (err instanceof BackupBlobTooLargeError) oversized++;
          evt.addWarning(`Failed for user ${user.id}: ${err}`);
        } finally {
          // Past this account, whatever the outcome: only a process that died
          // under it leaves the start without a finish.
          await markBackupAttemptFinished(prisma, DATA_BACKUP_QUEUE, user.id);
        }
      }

      // The stored size is the one number that says whether this pass is
      // heading back towards the wall it hit before: it tracks the record.
      evt.addMeta("data_backup_largest_blob_bytes", largestBlobBytes);
      // How many accounts' copies passed the stored-copy limit. Non-zero
      // means raising `BACKUP_MAX_STORED_MB`, not a retry.
      evt.addMeta("data_backup_records_oversized", oversized);
      evt.setBackground({
        task_name: "job.data_backup",
        result: { backed, total: users.length, failed: usersFailed },
      });

      const did = {
        backed,
        total: users.length,
        users_failed: usersFailed,
        records_oversized: oversized,
        users_skipped_restoring: skippedRestoring,
        stopped_early: stoppedEarly,
      };

      // A pass that wrote nothing for anybody protected nobody, and saying
      // `ok: true` about it is how an instance goes a month and a half without
      // a usable copy while every surface reads healthy. Per-account failures
      // still ride out as counts when SOME account got a copy — that is the
      // fan-out rule, and that account's own row ages on the backups page —
      // but zero out of a non-empty cohort is the pass failing rather than a
      // leg of it, so pg-boss records a failed run and the backups page reads
      // it back through `readLastQueueRun`. An account skipped because its
      // copy is being restored still has that copy, so it does not count.
      if (users.length > 0 && backed === 0 && usersFailed > 0) {
        return jobFailed("no account could be backed up", lastError, did);
      }

      return jobDone(did);
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
