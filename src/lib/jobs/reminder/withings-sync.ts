/**
 * Withings fallback measure sync plus the hourly activity / sleep v2 sync handlers.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { type Job } from "pg-boss";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { recordError, recordWithingsSync } from "@/lib/jobs/worker-status";
import { type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { isReauthRequired } from "@/lib/integrations/status";
import {
  retryDueWithingsWebhookSubscriptions,
  syncUserMeasurements,
} from "@/lib/withings/sync";
import { syncUserActivity } from "@/lib/withings/sync-activity";
import { releasePlanGatedWithingsParks } from "@/lib/withings/api-plan";
import { syncUserSleep } from "@/lib/withings/sync-sleep";
import { syncUserEcg } from "@/lib/withings/sync-ecg";
import type { WithingsEcgSyncPayload } from "@/lib/jobs/withings-ecg-queue";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import {
  foldIntegrationCohortOutcomes,
  type IntegrationUserVerdict,
} from "./poll-cohort";
import { getWorkerPrisma } from "./shared";
export type { WithingsEcgSyncPayload } from "@/lib/jobs/withings-ecg-queue";

export interface WithingsSyncPayload {
  triggeredAt: string;
}

/**
 * v1.4.25 — payload for the activity-sync queue. When enqueued
 * by the webhook handler, `userId` is set so the worker syncs only
 * that user; when enqueued by the cron schedule, `userId` is absent
 * and the worker iterates every connection (safety-net behaviour).
 */
export interface WithingsActivitySyncPayload {
  triggeredAt: string;
  userId?: string;
}

/**
 * v1.4.25 — payload for the sleep-sync queue. Same shape and
 * webhook-vs-cron semantics as the activity payload.
 */
export interface WithingsSleepSyncPayload {
  triggeredAt: string;
  userId?: string;
}

/**
 * Fallback polling for Withings data.
 * Runs periodically in case webhook delivery is delayed or unavailable.
 */
export async function handleWithingsFallbackSync(
  jobs: Job<WithingsSyncPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.withings_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      recordWithingsSync();
      // The subscription repair is an auxiliary leg, not the pass this queue is
      // named for. Failing the job on it would skip the fallback sync that every
      // user relies on when a webhook goes missing, so it rides out as a fact.
      let subscriptionRepairFailed = false;
      try {
        await retryDueWithingsWebhookSubscriptions();
      } catch {
        subscriptionRepairFailed = true;
        evt.addWarning(
          "Withings subscription repair failed; continuing fallback sync",
        );
      }
      // Connections an earlier build parked at `error_reauth` over a Withings
      // API-plan refusal (277) are lifted first, so this pass and the activity,
      // sleep and ECG legs read again. Best-effort: a failure here leaves the
      // rows parked until the next tick, it never blocks the pass.
      try {
        await releasePlanGatedWithingsParks();
      } catch {
        evt.addWarning("Withings plan-park release failed; continuing");
      }
      const connections = await prisma.withingsConnection.findMany({
        where: OWNED_BY_ACTIVE_ACCOUNT,
        select: { userId: true },
      });

      if (connections.length === 0) {
        return foldIntegrationCohortOutcomes({
          provider: "withings",
          verdicts: [],
          downstreamFailures: subscriptionRepairFailed ? 1 : 0,
        });
      }

      const verdicts: IntegrationUserVerdict[] = [];

      for (const connection of connections) {
        if (await isReauthRequired(connection.userId, "withings")) {
          verdicts.push({ status: "parked", imported: 0 });
          continue;
        }

        try {
          const result = await syncUserMeasurements(connection.userId);
          const parked =
            result.failed &&
            result.imported === 0 &&
            (await isReauthRequired(connection.userId, "withings"));
          verdicts.push({
            status: parked
              ? "parked"
              : result.failed
                ? result.imported > 0
                  ? "partial"
                  : "failed"
                : "complete",
            imported: result.imported,
            retryable: result.failed && !parked,
          });
          // v1.18.1 — a fresh reading landed; resolve this user's Vorsorge
          // reminders eventfully. Fire-and-forget; the cron is the net.
          if (result.imported > 0) {
            fireAndForget(() => enqueueReminderSatisfy(connection.userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch {
          verdicts.push({ status: "failed", imported: 0, retryable: true });
          evt.addWarning("Fallback sync failed for one cohort member");
        }
      }

      const outcome = foldIntegrationCohortOutcomes({
        provider: "withings",
        verdicts,
        downstreamFailures: subscriptionRepairFailed ? 1 : 0,
      });
      evt.setBackground({
        task_name: "job.withings_sync",
        result: outcome.did,
      });
      return outcome;
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * ECG sync handler. Two enqueue paths feed this queue, mirroring the
 * activity / sleep handlers:
 *
 *   1. Webhook (appli=54) — payload carries `userId` (+ the source
 *      `startdate`/`enddate` window); the handler runs `syncUserEcg` for that
 *      one user over the windowed range.
 *   2. Cron (`withings-ecg-sync` at :41) — payload has no `userId`, the handler
 *      iterates every Withings connection and runs `syncUserEcg` over its
 *      default trailing 30-day window. This is the catch-net that lets a
 *      watch-only account (no scale, appli 54 unsubscribed) pull its ECG strips
 *      without a webhook.
 *
 * Per-user failures are warned and the cohort carries on so one user's
 * parked-at-reauth state (or a transient device outage) never starves the rest;
 * the ECG leaf records its own classified failure on the shared `withings`
 * ledger, so honesty is preserved without rejecting the whole batch.
 */
export async function handleWithingsEcgSync(
  jobs: Job<WithingsEcgSyncPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.withings_ecg_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{
        userId: string;
        startdate?: number;
        enddate?: number;
      }> = [];
      for (const job of jobs) {
        if (job.data?.userId) {
          targets.push({
            userId: job.data.userId,
            startdate: job.data.startdate,
            enddate: job.data.enddate,
          });
        }
      }
      // No user-specific enqueue → cron fallback iterating every connection.
      if (targets.length === 0) {
        const connections = await prisma.withingsConnection.findMany({
          where: OWNED_BY_ACTIVE_ACCOUNT,
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) {
        return foldIntegrationCohortOutcomes({
          provider: "withings",
          verdicts: [],
        });
      }

      const verdicts: IntegrationUserVerdict[] = [];
      for (const { userId, startdate, enddate } of targets) {
        if (await isReauthRequired(userId, "withings")) {
          verdicts.push({ status: "parked", imported: 0 });
          continue;
        }

        try {
          const options =
            startdate === undefined && enddate === undefined
              ? {}
              : { startdate, enddate };
          const imported = await syncUserEcg(userId, options);
          const parked =
            imported === 0 && (await isReauthRequired(userId, "withings"));
          verdicts.push({
            status: parked ? "parked" : "complete",
            imported,
          });
        } catch {
          verdicts.push({ status: "failed", imported: 0, retryable: true });
          evt.addWarning("Withings ECG sync failed for one cohort member");
        }
      }

      const outcome = foldIntegrationCohortOutcomes({
        provider: "withings",
        verdicts,
      });
      evt.setBackground({
        task_name: "job.withings_ecg_sync",
        result: outcome.did,
      });
      return outcome;
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.4.25 — activity-sync handler.
 *
 * Two enqueue paths feed this queue:
 *
 *   1. Webhook (appli=16) — payload carries `userId`, the handler
 *      runs `syncUserActivity` for that one user.
 *   2. Cron (`withings-activity-sync` at :00 every hour) — payload
 *      has no `userId`, the handler iterates every Withings
 *      connection and re-syncs each. Catches the 1 % of webhook
 *      deliveries Withings drops.
 *
 * Sync failures per-user are logged as warnings; the queue carries on
 * so one user's parked-at-reauth state doesn't starve every other
 * connection on the cron tick.
 */
export async function handleWithingsActivitySync(
  jobs: Job<WithingsActivitySyncPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.withings_activity_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) {
          targets.push({ userId: job.data.userId });
        }
      }
      // No user-specific enqueue → cron fallback iterating everyone.
      if (targets.length === 0) {
        const connections = await prisma.withingsConnection.findMany({
          where: OWNED_BY_ACTIVE_ACCOUNT,
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) {
        return foldIntegrationCohortOutcomes({
          provider: "withings",
          verdicts: [],
        });
      }

      const verdicts: IntegrationUserVerdict[] = [];
      for (const { userId } of targets) {
        if (await isReauthRequired(userId, "withings")) {
          verdicts.push({ status: "parked", imported: 0 });
          continue;
        }

        try {
          const imported = await syncUserActivity(userId);
          const parked =
            imported === 0 && (await isReauthRequired(userId, "withings"));
          verdicts.push({
            status: parked ? "parked" : "complete",
            imported,
          });
          if (imported > 0) {
            fireAndForget(() => enqueueReminderSatisfy(userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch {
          verdicts.push({ status: "failed", imported: 0, retryable: true });
          evt.addWarning("Withings activity sync failed for one cohort member");
        }
      }

      const outcome = foldIntegrationCohortOutcomes({
        provider: "withings",
        verdicts,
      });
      evt.setBackground({
        task_name: "job.withings_activity_sync",
        result: outcome.did,
      });
      return outcome;
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.4.25 — sleep-sync handler. Same enqueue semantics as the
 * activity handler: per-user when the webhook fires, full-iteration
 * when the cron ticks.
 */
export async function handleWithingsSleepSync(
  jobs: Job<WithingsSleepSyncPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.withings_sleep_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) {
          targets.push({ userId: job.data.userId });
        }
      }
      if (targets.length === 0) {
        const connections = await prisma.withingsConnection.findMany({
          where: OWNED_BY_ACTIVE_ACCOUNT,
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) {
        return foldIntegrationCohortOutcomes({
          provider: "withings",
          verdicts: [],
        });
      }

      const verdicts: IntegrationUserVerdict[] = [];
      for (const { userId } of targets) {
        if (await isReauthRequired(userId, "withings")) {
          verdicts.push({ status: "parked", imported: 0 });
          continue;
        }

        try {
          const imported = await syncUserSleep(userId);
          const parked =
            imported === 0 && (await isReauthRequired(userId, "withings"));
          verdicts.push({
            status: parked ? "parked" : "complete",
            imported,
          });
          if (imported > 0) {
            fireAndForget(() => enqueueReminderSatisfy(userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch {
          verdicts.push({ status: "failed", imported: 0, retryable: true });
          evt.addWarning("Withings sleep sync failed for one cohort member");
        }
      }

      const outcome = foldIntegrationCohortOutcomes({
        provider: "withings",
        verdicts,
      });
      evt.setBackground({
        task_name: "job.withings_sleep_sync",
        result: outcome.did,
      });
      return outcome;
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
