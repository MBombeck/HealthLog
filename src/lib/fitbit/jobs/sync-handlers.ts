/**
 * Fitbit hourly poll-cohort sync and OAuth-state cleanup handlers.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { recordError } from "@/lib/jobs/worker-status";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { runFitbitPollCohort } from "@/lib/fitbit/sync";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { cleanupExpiredFitbitOAuthStates } from "./oauth-state-cleanup";
import { getWorkerPrisma } from "@/lib/jobs/reminder/shared";
import { isFitbitRetired } from "@/lib/fitbit/retirement";
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";

/**
 * v1.12.0 — Fitbit poll-sync payload. Poll-only (no webhook at launch): the
 * single hourly cron tick carries no `userId`, so the handler iterates every
 * Fitbit connection and re-syncs each via `syncUserFitbit`. One user's
 * parked-at-reauth state never starves the rest of the cohort.
 */
export interface FitbitSyncPayload {
  userId?: string;
}

export async function handleFitbitSync(
  jobs: Job<FitbitSyncPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.fitbit_sync", async (evt) => {
    // Google turned the Web API off (`@/lib/fitbit/retirement`): the cron
    // tick reads no connection and calls nothing.
    if (isFitbitRetired()) {
      evt.setBackground({
        task_name: "job.fitbit_sync",
        result: { retired: true },
      });
      return jobDone({
        total: 0,
        users_synced: 0,
        users_failed: 0,
        measurements_imported: 0,
      });
    }
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) targets.push({ userId: job.data.userId });
      }
      if (targets.length === 0) {
        const connections = await prisma.fitbitConnection.findMany({
          where: OWNED_BY_ACTIVE_ACCOUNT,
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) {
        return jobDone({
          total: 0,
          users_synced: 0,
          users_failed: 0,
          measurements_imported: 0,
        });
      }

      // Fan the cohort out with bounded concurrency + per-user error isolation:
      // one slow Google response can't stall the whole cohort, and a single
      // user's failure is warned without aborting the pass.
      let usersFailed = 0;
      const { usersSynced, measurementsImported } = await runFitbitPollCohort(
        targets.map((t) => t.userId),
        {
          onUserError: (userId, err) => {
            usersFailed++;
            evt.addWarning(`job.fitbit_sync failed for user ${userId}: ${err}`);
          },
          // v1.18.1 — a fresh reading landed; resolve the user's Vorsorge
          // reminders eventfully. Fire-and-forget; the cron is the net.
          onUserSynced: (userId, imported) => {
            if (imported > 0) {
              fireAndForget(() => enqueueReminderSatisfy(userId), {
                action: "reminder.satisfy.enqueue",
              });
            }
          },
        },
      );

      evt.setBackground({
        task_name: "job.fitbit_sync",
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
      // The pass is the unit of success: a revoked grant belongs on that user's
      // integration ledger, not in a queue failure that retries every account.
      return jobDone({
        total: targets.length,
        users_synced: usersSynced,
        users_failed: usersFailed,
        measurements_imported: measurementsImported,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

export interface FitbitOAuthStateCleanupPayload {
  triggeredAt?: string;
}

export async function handleFitbitOAuthStateCleanup(
  jobs: Job<FitbitOAuthStateCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.fitbit_oauth_state_cleanup", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const deleted = await cleanupExpiredFitbitOAuthStates(p);
      evt.addMeta("fitbit_oauth_state_cleanup_deleted", deleted);
      return jobDone({ deleted });
    } catch (err) {
      evt.addWarning(`fitbit-oauth-state-cleanup failed: ${err}`);
      return jobFailed("fitbit oauth state cleanup failed", err);
    }
  });
}
