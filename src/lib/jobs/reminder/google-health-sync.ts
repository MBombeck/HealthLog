/**
 * Google Health hourly poll-cohort sync and OAuth-state cleanup handlers.
 *
 * Extracted alongside the Fitbit handlers; register-integration-sync.ts owns the
 * queue names, cron schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import pLimit from "p-limit";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { recordError } from "@/lib/jobs/worker-status";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  GOOGLE_HEALTH_POLL_CONCURRENCY,
  isGoogleHealthParked,
  syncUserGoogleHealth,
} from "@/lib/google-health/sync";
import { GOOGLE_HEALTH_POLL_LOCK_WAIT_MS } from "@/lib/google-health/sync-lock";
import { jobBudget, jobDeadline } from "@/lib/jobs/job-budget";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { cleanupExpiredGoogleHealthOAuthStates } from "@/lib/jobs/google-health-oauth-state-cleanup";
import {
  foldIntegrationCohortOutcomes,
  type IntegrationUserVerdict,
} from "./poll-cohort";
import { getWorkerPrisma } from "./shared";

/**
 * v1.26.0 — Google Health poll-sync payload. Poll-only (no webhook — Pub/Sub is
 * deferred): the single hourly cron tick carries no `userId`, so the handler
 * iterates every Google Health connection and re-syncs each via
 * `syncUserGoogleHealth`. One user's parked-at-reauth state never starves the
 * rest of the cohort.
 */
export interface GoogleHealthSyncPayload {
  userId?: string;
}

export async function handleGoogleHealthSync(
  jobs: Job<GoogleHealthSyncPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.google_health_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) targets.push({ userId: job.data.userId });
      }
      if (targets.length === 0) {
        const connections = await prisma.googleHealthConnection.findMany({
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) {
        return foldIntegrationCohortOutcomes({
          provider: "google_health",
          verdicts: [],
        });
      }

      // The job's own expiry bounds the pass (`jobBudget`). An account that
      // waited for its backfill slice gets what is left of it, not a fresh
      // hour: the lock wait is capped at the time remaining, the sync stops
      // its walks once the budget is spent and leaves the rest of its window
      // to the next hour (the cycle is not stamped), and an account reached
      // only after the budget is gone is left for the next hour untouched.
      // Before, a tick could run on past its expiry, and pg-boss then marked
      // it failed and retried it beside the run still going.
      const shouldStop = jobBudget(jobs);
      const deadline = Math.min(
        ...jobs.map((job) => jobDeadline(job) ?? Number.POSITIVE_INFINITY),
      );
      // Fan the cohort out with bounded concurrency + per-user error isolation:
      // one slow Google response can't stall the whole cohort, and a single
      // user's failure is warned without aborting the pass.
      const limit = pLimit(GOOGLE_HEALTH_POLL_CONCURRENCY);
      const verdicts = await Promise.all(
        targets.map(({ userId }) =>
          limit(async (): Promise<IntegrationUserVerdict> => {
            if (shouldStop()) return { status: "skipped", imported: 0 };
            if (await isGoogleHealthParked(userId)) {
              return { status: "parked", imported: 0 };
            }

            try {
              // A backfill holds the account for one slice at a time, so
              // the tick waits for the slice to end rather than skipping the
              // account for as long as the whole import runs.
              const result = await syncUserGoogleHealth(userId, {
                waitForLockMs: Math.max(
                  0,
                  Math.min(
                    GOOGLE_HEALTH_POLL_LOCK_WAIT_MS,
                    deadline - Date.now(),
                  ),
                ),
                shouldStop,
              });
              // Another run of this account (its backfill, a manual sync)
              // still held the account after the wait; this tick leaves it
              // to that run.
              if (result.busy) return { status: "skipped", imported: 0 };
              // Stopped on the job's budget: the rest of the window is the
              // next hour's, which is not a failure to retry.
              if (result.failed && shouldStop()) {
                if (result.imported > 0) {
                  fireAndForget(() => enqueueReminderSatisfy(userId), {
                    action: "reminder.satisfy.enqueue",
                  });
                }
                return {
                  status: result.imported > 0 ? "partial" : "skipped",
                  imported: result.imported,
                  retryable: false,
                };
              }
              const parked =
                result.failed &&
                result.imported === 0 &&
                (await isGoogleHealthParked(userId));
              const status = parked
                ? "parked"
                : result.failed
                  ? result.imported > 0
                    ? "partial"
                    : "failed"
                  : "complete";

              if (result.imported > 0) {
                fireAndForget(() => enqueueReminderSatisfy(userId), {
                  action: "reminder.satisfy.enqueue",
                });
              }

              return {
                status,
                imported: result.imported,
                retryable: result.failed && !parked,
              };
            } catch {
              evt.addWarning(
                "job.google_health_sync failed for one cohort member",
              );
              return { status: "failed", imported: 0, retryable: true };
            }
          }),
        ),
      );
      const outcome = foldIntegrationCohortOutcomes({
        provider: "google_health",
        verdicts,
      });

      evt.setBackground({
        task_name: "job.google_health_sync",
        result: outcome.did,
      });
      // The pass is the unit of success: a revoked grant belongs on that user's
      // integration ledger, not in a queue failure that retries every account.
      return outcome;
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

export interface GoogleHealthOAuthStateCleanupPayload {
  triggeredAt?: string;
}

export async function handleGoogleHealthOAuthStateCleanup(
  jobs: Job<GoogleHealthOAuthStateCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent(
    "job.google_health_oauth_state_cleanup",
    async (evt) => {
      const p = getWorkerPrisma();
      try {
        const deleted = await cleanupExpiredGoogleHealthOAuthStates(p);
        evt.addMeta("google_health_oauth_state_cleanup_deleted", deleted);
        return jobDone({ deleted });
      } catch (err) {
        evt.addWarning("google-health-oauth-state-cleanup failed");
        return jobFailed("google_health_oauth_state_cleanup_failed", err);
      }
    },
  );
}
