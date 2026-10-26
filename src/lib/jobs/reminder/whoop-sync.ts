/**
 * WHOOP hourly resource syncs (recovery / sleep / workout / cycle) sharing one cohort runner.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { type Job } from "pg-boss";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { recordError } from "@/lib/jobs/worker-status";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  syncUserRecovery,
  syncWhoopRecoveryById,
} from "@/lib/whoop/sync-recovery";
import {
  syncUserSleep as syncWhoopSleep,
  syncWhoopSleepById,
} from "@/lib/whoop/sync-sleep";
import { syncUserCycle } from "@/lib/whoop/sync-cycle";
import {
  syncUserWorkout,
  syncWhoopWorkoutById,
} from "@/lib/whoop/sync-workout";
import {
  recordWhoopSyncFailure,
  syncWhoopResourceWithStatus,
  type WhoopSyncLeg,
} from "@/lib/whoop/sync-core";
import { isSyncFailureRecorded } from "@/lib/integrations/status";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { getWorkerPrisma } from "./shared";

/**
 * v1.11.0 — WHOOP per-resource sync payload. Two enqueue paths feed each
 * WHOOP sync queue:
 *
 *   1. Webhook (`recovery.updated` / `sleep.updated` / `workout.updated`) —
 *      payload carries `userId` and (v1.16.16) the `resourceId`; the handler
 *      does a targeted fetch-by-id refresh of that single record.
 *   2. Cron — payload has no `userId`; the handler iterates every WHOOP
 *      connection and re-syncs each collection, catching dropped webhook
 *      deliveries. Cycle has no webhook, so its cron is the sole driver.
 *
 * A webhook job that carries a `userId` but no `resourceId` (a legacy in-flight
 * job, or a delivery that omitted the id) falls back to the per-user collection
 * walk rather than touching every connection.
 */
export interface WhoopSyncPayload {
  userId?: string;
  /** v1.16.16 — webhook resource id for a targeted fetch-by-id refresh. */
  resourceId?: string;
}

/** A per-user collection walk (cron + the no-id webhook fallback). */
type CollectionSync = (userId: string) => Promise<number>;
/** A webhook-driven single-record refresh by resource id. */
type ByIdSync = (userId: string, resourceId: string) => Promise<number>;

/**
 * Shared driver for the per-resource WHOOP sync handlers.
 *
 *   - A webhook job with a `resourceId` runs the targeted `byIdFn` (when the
 *     resource supports fetch-by-id) — landing the exact record immediately.
 *   - A webhook job with a `userId` but no `resourceId` runs the per-user
 *     collection `syncFn`.
 *   - A cron tick (no `userId` on any job) walks every connection's collection.
 *
 * One user's parked-at-reauth state never starves the rest of the cohort.
 *
 * The pass is what the outcome judges: a per-user failure is that user's
 * problem, recorded on their integration ledger and counted as `users_failed`,
 * not a queue-wide failure that would retry the whole cohort.
 */
export async function runWhoopResourceSync(
  taskName: string,
  leg: WhoopSyncLeg,
  jobs: Job<WhoopSyncPayload>[],
  syncFn: CollectionSync,
  byIdFn?: ByIdSync,
): Promise<JobOutcome> {
  return withBackgroundEvent(taskName, async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      // (userId, optional resourceId) work items from the webhook payloads.
      const targets: Array<{ userId: string; resourceId?: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) {
          targets.push({
            userId: job.data.userId,
            resourceId: job.data.resourceId,
          });
        }
      }
      if (targets.length === 0) {
        // Cron tick — re-walk every connection's collection.
        const connections = await prisma.whoopConnection.findMany({
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

      let usersSynced = 0;
      let usersFailed = 0;
      let measurementsImported = 0;
      for (const { userId, resourceId } of targets) {
        try {
          // Stamp `IntegrationStatus.lastSuccessAt` on a genuine per-resource
          // import — a webhook-driven refresh advanced the cursor but used to
          // leave the sync-status ledger frozen until the next full poll.
          const imported = await syncWhoopResourceWithStatus(userId, leg, () =>
            resourceId && byIdFn ? byIdFn(userId, resourceId) : syncFn(userId),
          );
          measurementsImported += imported;
          usersSynced++;
          // v1.18.1 — a fresh reading landed; resolve this user's Vorsorge
          // reminders eventfully. Fire-and-forget; the cron is the net.
          if (imported > 0) {
            // Background-sync posture: mark the analytics cells stale (never
            // hard-evict from a poll) and sweep the workouts cache so the
            // imported rows reach the cached readers. This driver is the only
            // sync tail the webhook / per-resource cron paths pass through —
            // `syncUserWhoop` covers the manual + backfill paths itself.
            invalidateUserMeasurements(userId);
            fireAndForget(() => enqueueReminderSatisfy(userId), {
              action: "reminder.satisfy.enqueue",
            });
          }
        } catch (err) {
          // WH-4: a write-path throw on the hourly cron reaches no ledger
          // otherwise (stale-green pill). Fetch hard-fails already recorded +
          // marked in `handleCollectionFetchError`, so record only the UNMARKED
          // escapes here.
          if (!isSyncFailureRecorded(err)) {
            await recordWhoopSyncFailure(userId, err, leg);
          }
          usersFailed++;
          evt.addWarning(`${taskName} failed for user ${userId}: ${err}`);
        }
      }

      evt.setBackground({
        task_name: taskName,
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
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

export function handleWhoopRecoverySync(
  jobs: Job<WhoopSyncPayload>[],
): Promise<JobOutcome> {
  return runWhoopResourceSync(
    "job.whoop_recovery_sync",
    "recovery",
    jobs,
    syncUserRecovery,
    syncWhoopRecoveryById,
  );
}

export function handleWhoopSleepSync(
  jobs: Job<WhoopSyncPayload>[],
): Promise<JobOutcome> {
  return runWhoopResourceSync(
    "job.whoop_sleep_sync",
    "sleep",
    jobs,
    syncWhoopSleep,
    syncWhoopSleepById,
  );
}

export function handleWhoopWorkoutSync(
  jobs: Job<WhoopSyncPayload>[],
): Promise<JobOutcome> {
  return runWhoopResourceSync(
    "job.whoop_workout_sync",
    "workout",
    jobs,
    syncUserWorkout,
    syncWhoopWorkoutById,
  );
}

export function handleWhoopCycleSync(
  jobs: Job<WhoopSyncPayload>[],
): Promise<JobOutcome> {
  // Cycle has no webhook (poll-only), so no fetch-by-id path.
  return runWhoopResourceSync(
    "job.whoop_cycle_sync",
    "cycle",
    jobs,
    syncUserCycle,
  );
}
