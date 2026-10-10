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

      // Fan the cohort out with bounded concurrency + per-user error isolation:
      // one slow Google response can't stall the whole cohort, and a single
      // user's failure is warned without aborting the pass.
      const limit = pLimit(GOOGLE_HEALTH_POLL_CONCURRENCY);
      const verdicts = await Promise.all(
        targets.map(({ userId }) =>
          limit(async (): Promise<IntegrationUserVerdict> => {
            if (await isGoogleHealthParked(userId)) {
              return { status: "parked", imported: 0 };
            }

            try {
              const result = await syncUserGoogleHealth(userId);
              // Another run of this account (its backfill, a manual sync)
              // holds the account; this tick leaves it to that run.
              if (result.busy) return { status: "skipped", imported: 0 };
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
                fireAndForget(enqueueReminderSatisfy(userId), {
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
