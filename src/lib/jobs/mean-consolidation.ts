/**
 * v1.7.0 — pg-boss queue + boot-time converging backfill for the
 * daily-mean consolidation of high-frequency spot HealthKit metrics
 * (walking speed/step length, respiratory rate, audio exposure).
 *
 * Modelled on `step-consolidation.ts`: a discovery query enqueues one
 * job per user still holding live per-sample mean-type rows, the
 * per-user handler runs `consolidateDailyMean`, and the pass is
 * idempotent across reboots (consolidated rows are soft-deleted so they
 * drop off the discovery list).
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` so pg-boss provisions it at boot;
 * an unregistered queue silently never drains.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  consolidateDailyMean,
  MEAN_CONSOLIDATION_CUTOFF_HOURS,
} from "@/lib/measurements/consolidate-daily-mean";
import { HIGH_FREQUENCY_MEAN_TYPES } from "@/lib/measurements/apple-health-mapping";

export const MEAN_CONSOLIDATION_QUEUE = "mean-consolidation";

/**
 * Serial concurrency — the populator walks every per-sample mean-type
 * row for a user and writes a transaction per day; concurrency-1 keeps
 * it from crowding the request pool, matching the step-consolidation
 * + rollup-full-backfill convention.
 */
export const MEAN_CONSOLIDATION_CONCURRENCY = 1;

export interface MeanConsolidationPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user queue handler. Runs the consolidation for one account and
 * returns the summary totals so the worker can log them. Passes the
 * 36-hour grace cutoff so today's in-flight watch syncs stay raw.
 */
export async function runMeanConsolidationForUser(
  userId: string,
): Promise<{ daysConsolidated: number; perSampleRowsSoftDeleted: number }> {
  const summary = await consolidateDailyMean(prisma, {
    userId,
    cutoffHours: MEAN_CONSOLIDATION_CUTOFF_HOURS,
    log: () => {
      // Silent inside the queue handler — the worker logs the totals.
    },
  });
  annotate({
    action: {
      name: "measurement.mean.consolidate",
      details: {
        days: summary.totals.daysConsolidated,
        per_sample_rows_soft_deleted: summary.totals.perSampleRowsSoftDeleted,
        daily_rows_upserted: summary.totals.dailyRowsUpserted,
      },
    },
  });
  return {
    daysConsolidated: summary.totals.daysConsolidated,
    perSampleRowsSoftDeleted: summary.totals.perSampleRowsSoftDeleted,
  };
}

/**
 * Boot-time discovery. Finds every user holding at least one LIVE
 * per-sample mean-type row (an `APPLE_HEALTH` row of a
 * `HIGH_FREQUENCY_MEAN_TYPES` type whose externalId is NULL or does NOT
 * start with the daily-stats prefix, and that is not tombstoned) and
 * enqueues one consolidation job per account.
 *
 * Idempotent across reboots: once a user's per-sample rows are
 * soft-deleted, the `deleted_at IS NULL` predicate drops them from the
 * discovery set. pg-boss `singletonKey` coalesces duplicate sends.
 *
 * Best-effort: errors are returned through the result value so the
 * worker boot never fails because of a consolidation miss.
 */
export async function enqueueBootTimeMeanConsolidation(): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // The mean-type set is a closed compile-time list of enum members;
    // splice-free — Prisma binds the `type IN (...)` array as parameters.
    const types = Array.from(HIGH_FREQUENCY_MEAN_TYPES);
    if (types.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    const users = await prisma.measurement.findMany({
      where: {
        source: "APPLE_HEALTH",
        type: { in: types },
        deletedAt: null,
        NOT: { externalId: { startsWith: "stats:" } },
      },
      select: { userId: true },
      distinct: ["userId"],
    });

    if (users.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of users) {
      const payload: MeanConsolidationPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(MEAN_CONSOLIDATION_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        singletonKey: `mean-consolidation|${userId}`,
      });
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
