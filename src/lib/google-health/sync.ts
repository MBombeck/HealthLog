import pLimit from "p-limit";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { isReauthRequired, recordSyncSuccess } from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeUserRollups,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import { syncUserActivity } from "./sync-activity";
import { syncUserMetrics } from "./sync-metrics";
import { syncUserSleep } from "./sync-sleep";
import { syncUserWorkout } from "./sync-workout";
import {
  GOOGLE_HEALTH_INTEGRATION_KEY,
  incrementalStart,
  markSynced,
  runWithGoogleHealthSyncCycle,
  type GoogleHealthResourceSyncOptions,
} from "./sync-core";

/**
 * Full per-user sync across every Google Health resource. The incremental
 * watermark is snapshotted once, every leaf receives the same lower bound, and
 * the connection is stamped only after a non-degenerate cycle completes.
 */
export async function syncUserGoogleHealth(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<{ imported: number; failed: boolean }> {
  if (await isReauthRequired(userId, GOOGLE_HEALTH_INTEGRATION_KEY)) {
    getEvent()?.addWarning(
      `google-health sync skipped for ${userId}: parked at error_reauth`,
    );
    return { imported: 0, failed: true };
  }

  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true },
  });
  if (!connection) return { imported: 0, failed: true };

  const start = incrementalStart(connection.lastSyncedAt, {
    fullSync: opts.fullSync,
  });
  const resourceOpts: GoogleHealthResourceSyncOptions = {
    fullSync: opts.fullSync,
    start,
    deferRollup: opts.fullSync === true,
  };
  const resources = [
    { name: "metrics", fn: syncUserMetrics },
    { name: "activity", fn: syncUserActivity },
    { name: "sleep", fn: syncUserSleep },
    { name: "workout", fn: syncUserWorkout },
  ];

  const cycle = await runWithGoogleHealthSyncCycle(async () => {
    let total = 0;
    let anyFailed = false;
    for (const { name, fn } of resources) {
      try {
        total += await fn(userId, resourceOpts);
      } catch (err) {
        anyFailed = true;
        getEvent()?.addWarning(
          `google-health ${name} sync failed for ${userId}: ${err}`,
        );
      }
    }
    return { total, anyFailed };
  });

  const total = cycle.result.total;
  const anyFailed = cycle.result.anyFailed || cycle.hardFailures.length > 0;

  if (opts.fullSync && cycle.deferredRollupKeys.length > 0) {
    try {
      const days = collapseToTypeDayKeys(cycle.deferredRollupKeys);
      const types = Array.from(new Set(days.map((key) => key.type)));
      const sorted = days
        .map((key) => key.measuredAt.getTime())
        .sort((a, b) => a - b);
      const from = new Date(sorted[0]!);
      const to = new Date(sorted[sorted.length - 1]! + 24 * 60 * 60 * 1000);
      await recomputeUserRollups(userId, { types, from, to });
      invalidateStatusInsightsForTypes(userId, types).catch((err) => {
        getEvent()?.addWarning(
          `google-health: status-insight invalidate failed for ${userId}: ${err}`,
        );
      });
    } catch (err) {
      getEvent()?.addWarning(
        `google-health: backfill rollup recompute failed for ${userId}: ${err}`,
      );
    }
  }

  const allSoftSkipped = cycle.softSkipCount >= resources.length && total === 0;
  const failed = anyFailed || allSoftSkipped;

  if (!failed) {
    await markSynced(userId);
    await recordSyncSuccess(userId, GOOGLE_HEALTH_INTEGRATION_KEY);
  }

  annotate({
    action: { name: "googleHealth.sync", details: { imported: total, failed } },
  });
  return { imported: total, failed };
}

/** Bounded fan-out width for the hourly Google Health cohort poll. */
export const GOOGLE_HEALTH_POLL_CONCURRENCY = 4;

/**
 * Run an hourly-poll cohort with bounded concurrency and per-user isolation.
 */
export async function runGoogleHealthPollCohort(
  userIds: string[],
  opts: {
    concurrency?: number;
    sync?: (userId: string) => Promise<number>;
    onUserError?: (userId: string, err: unknown) => void;
    onUserSynced?: (userId: string, imported: number) => void;
  } = {},
): Promise<{ usersSynced: number; measurementsImported: number }> {
  const sync =
    opts.sync ??
    ((userId: string) => syncUserGoogleHealth(userId).then((r) => r.imported));
  const limit = pLimit(opts.concurrency ?? GOOGLE_HEALTH_POLL_CONCURRENCY);

  let usersSynced = 0;
  let measurementsImported = 0;
  await Promise.all(
    userIds.map((userId) =>
      limit(async () => {
        try {
          const imported = await sync(userId);
          measurementsImported = measurementsImported + imported;
          usersSynced = usersSynced + 1;
          opts.onUserSynced?.(userId, imported);
        } catch (err) {
          opts.onUserError?.(userId, err);
        }
      }),
    ),
  );

  return { usersSynced, measurementsImported };
}
