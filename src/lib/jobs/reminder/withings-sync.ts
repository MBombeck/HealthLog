/**
 * Withings fallback measure sync plus the hourly activity / sleep v2 sync handlers.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { recordError, recordWithingsSync } from "@/lib/jobs/worker-status";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  retryDueWithingsWebhookSubscriptions,
  syncUserMeasurements,
} from "@/lib/withings/sync";
import { syncUserActivity } from "@/lib/withings/sync-activity";
import { syncUserSleep } from "@/lib/withings/sync-sleep";
import { syncUserEcg } from "@/lib/withings/sync-ecg";
import type { WithingsEcgSyncPayload } from "@/lib/jobs/withings-ecg-queue";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { getWorkerPrisma } from "./shared";
export type { WithingsEcgSyncPayload } from "@/lib/jobs/withings-ecg-queue";

export interface WithingsSyncPayload {
  triggeredAt: string;
}

/**
 * v1.4.25 W17b — payload for the activity-sync queue. When enqueued
 * by the webhook handler, `userId` is set so the worker syncs only
 * that user; when enqueued by the cron schedule, `userId` is absent
 * and the worker iterates every connection (safety-net behaviour).
 */
export interface WithingsActivitySyncPayload {
  triggeredAt: string;
  userId?: string;
}

/**
 * v1.4.25 W17c — payload for the sleep-sync queue. Same shape and
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
) {
  void jobs;
  await withBackgroundEvent("job.withings_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      recordWithingsSync();
      try {
        await retryDueWithingsWebhookSubscriptions();
      } catch {
        evt.addWarning(
          "Withings subscription repair failed; continuing fallback sync",
        );
      }
      const connections = await prisma.withingsConnection.findMany({
        select: { userId: true },
      });

      if (connections.length === 0) {
        return;
      }

      let usersSynced = 0;
      let measurementsImported = 0;

      for (const connection of connections) {
        try {
          const imported = await syncUserMeasurements(connection.userId);
          usersSynced++;
          measurementsImported += imported;
          // v1.18.1 — a fresh reading landed; resolve this user's Vorsorge
          // reminders eventfully. Fire-and-forget; the cron is the net.
          if (imported > 0) {
            fireAndForget(enqueueReminderSatisfy(connection.userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch {
          evt.addWarning(`Fallback sync failed for user ${connection.userId}`);
        }
      }

      evt.setBackground({
        task_name: "job.withings_sync",
        result: {
          users_synced: usersSynced,
          total: connections.length,
          measurements_imported: measurementsImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * Drain webhook-owned ECG events. A failed source read or write is allowed to
 * reject the handler so pg-boss retains the job and applies its retry policy.
 */
export async function handleWithingsEcgSync(
  jobs: Job<WithingsEcgSyncPayload>[],
) {
  await withBackgroundEvent("job.withings_ecg_sync", async (evt) => {
    try {
      let recordingsImported = 0;
      for (const job of jobs) {
        recordingsImported += await syncUserEcg(job.data.userId, {
          startdate: job.data.startdate,
          enddate: job.data.enddate,
        });
      }
      evt.setBackground({
        task_name: "job.withings_ecg_sync",
        result: {
          events_processed: jobs.length,
          recordings_imported: recordingsImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.4.25 W17b — activity-sync handler.
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
) {
  await withBackgroundEvent("job.withings_activity_sync", async (evt) => {
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
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) return;

      let usersSynced = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          const imported = await syncUserActivity(userId);
          usersSynced++;
          measurementsImported += imported;
          if (imported > 0) {
            fireAndForget(enqueueReminderSatisfy(userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch {
          evt.addWarning(`Withings activity sync failed for user ${userId}`);
        }
      }

      evt.setBackground({
        task_name: "job.withings_activity_sync",
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.4.25 W17c — sleep-sync handler. Same enqueue semantics as the
 * activity handler: per-user when the webhook fires, full-iteration
 * when the cron ticks.
 */
export async function handleWithingsSleepSync(
  jobs: Job<WithingsSleepSyncPayload>[],
) {
  await withBackgroundEvent("job.withings_sleep_sync", async (evt) => {
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
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) return;

      let usersSynced = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          const imported = await syncUserSleep(userId);
          usersSynced++;
          measurementsImported += imported;
          if (imported > 0) {
            fireAndForget(enqueueReminderSatisfy(userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch {
          evt.addWarning(`Withings sleep sync failed for user ${userId}`);
        }
      }

      evt.setBackground({
        task_name: "job.withings_sleep_sync",
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
