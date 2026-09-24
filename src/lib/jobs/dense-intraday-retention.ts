/**
 * v1.10.0 — pg-boss queue + boot-time converging backfill for the dense
 * intra-day retention drain of daytime HRV / heart-rate samples.
 *
 * Modelled on `mean-consolidation.ts`: a discovery query enqueues one job
 * per user still holding live per-sample dense-tier rows OLDER than the
 * retention window, the per-user handler runs `runDenseIntradayRetention`,
 * and the pass is idempotent across reboots (folded rows are soft-deleted
 * so they drop off the discovery list).
 *
 * Unlike the daily-mean consolidation, this pass scopes to the dense-tier
 * types (`HEART_RATE_VARIABILITY`, `PULSE`, `OXYGEN_SATURATION`) and keeps
 * the last `DENSE_INTRADAY_RETENTION_DAYS` of raw per-sample rows so the
 * Stress engine still has its intra-day SDNN shape; only out-of-window
 * samples fold — to hourly means since v1.28.31.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` so pg-boss provisions it at boot; an
 * unregistered queue silently never drains.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  runDenseIntradayRetention,
  DENSE_INTRADAY_RETENTION_TYPES,
  DENSE_INTRADAY_RETENTION_DAYS,
} from "@/lib/measurements/dense-intraday-retention";

export const DENSE_INTRADAY_RETENTION_QUEUE = "dense-intraday-retention";

/**
 * Serial concurrency — the drain walks every out-of-window per-sample
 * dense-tier row for a user and writes a transaction per day;
 * concurrency-1 keeps it from crowding the request pool, matching the
 * mean-consolidation + step-consolidation convention.
 */
export const DENSE_INTRADAY_RETENTION_CONCURRENCY = 1;

/**
 * Daily at 03:50 Europe/Berlin — inside the existing 03:xx maintenance
 * window, after the daily-mean consolidation that the cumulative + mean
 * drains run, and before the 04:30 insight pre-generation + 04:45
 * recovery-score so the rollup tier reflects the fold before the nightly
 * scores read it.
 */
export const DENSE_INTRADAY_RETENTION_CRON = "50 3 * * *";

/**
 * Boot-discovery jobs start only after this delay (seconds) so the
 * catch-up drain never competes with the startup storm — the deploy
 * container recreate, the Prisma migration, the other boot-time backfills
 * (rollup / mean- + step-consolidation / mood / medication-compliance),
 * and the foreground health-checks all share one connection pool. Running
 * the transaction-per-day drain into that contention exhausted the pool on
 * a data-heavy tenant (`P2028: Unable to start a transaction in the given
 * time`), starving `/api/health` into a restart loop. Deferring past the
 * boot window restores the pre-v1.10 boot profile; the scheduled 03:50
 * cron is unaffected, and the per-user jobs still drain serially
 * (concurrency 1) once the delay elapses.
 */
export const DENSE_INTRADAY_RETENTION_BOOT_DELAY_SECONDS = 600;

/**
 * Kill-switch, default ON (re-enabled in v1.10.2). The v1.10.0.2 default
 * was OFF because the fold's canonical-timestamp upsert collided with an
 * already-present daily row on the
 * `(user_id, type, measured_at, source, sleep_stage)` unique constraint
 * (`P2002`) on real data — a fold-coexistence bug the mocked unit tests
 * could not surface. v1.10.2 reworks `writeDay` to resolve the canonical
 * local-noon row by the measured_at composite (the index the collision was
 * on) and adopt it in place, so the fold now coexists with a pre-existing
 * daily row, and an integration test pins the no-P2002 contract. The drain
 * is on by default again; the boot-discovery still defers past the startup
 * storm (`DENSE_INTRADAY_RETENTION_BOOT_DELAY_SECONDS`). An operator can
 * still disable it explicitly with `DENSE_INTRADAY_RETENTION_ENABLED=false`.
 */
export const DENSE_INTRADAY_RETENTION_ENABLED =
  process.env.DENSE_INTRADAY_RETENTION_ENABLED !== "false";

export interface DenseIntradayRetentionPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user queue handler. Runs the dense-tier retention drain for one
 * account and returns the summary totals so the worker can log them.
 */
export async function runDenseIntradayRetentionForUser(
  userId: string,
  shouldStop?: () => boolean,
): Promise<{
  daysConsolidated: number;
  perSampleRowsSoftDeleted: number;
  derivedRestingRowsUpserted: number;
  /** The job's budget ran out first; the next run continues from here. */
  stoppedEarly: boolean;
}> {
  // Kill-switch: when an operator opts out, no-op so any already-queued
  // backlog completes cleanly (drains the queue) instead of running the fold.
  if (!DENSE_INTRADAY_RETENTION_ENABLED) {
    return {
      daysConsolidated: 0,
      perSampleRowsSoftDeleted: 0,
      derivedRestingRowsUpserted: 0,
      stoppedEarly: false,
    };
  }
  const summary = await runDenseIntradayRetention(prisma, {
    userId,
    shouldStop,
    log: () => {
      // Silent inside the queue handler — the worker logs the totals.
    },
  });
  annotate({
    action: {
      name: "measurement.dense_intraday.retain",
      details: {
        days: summary.totals.daysConsolidated,
        per_sample_rows_soft_deleted: summary.totals.perSampleRowsSoftDeleted,
        hourly_rows_upserted: summary.totals.hourlyRowsUpserted,
        daily_rows_retired: summary.totals.dailyRowsRetired,
        // iOS#34 — derived RESTING_HEART_RATE rows minted from folded PULSE
        // days for proxy users, preserving the resting signal post-fold.
        derived_resting_rows_upserted:
          summary.totals.derivedRestingRowsUpserted,
        stopped_early: summary.stoppedEarly,
      },
    },
  });
  return {
    daysConsolidated: summary.totals.daysConsolidated,
    perSampleRowsSoftDeleted: summary.totals.perSampleRowsSoftDeleted,
    derivedRestingRowsUpserted: summary.totals.derivedRestingRowsUpserted,
    stoppedEarly: summary.stoppedEarly,
  };
}

/**
 * Boot-time discovery. Finds every user holding at least one LIVE
 * per-sample dense-tier row (an `APPLE_HEALTH` row of a
 * `DENSE_INTRADAY_RETENTION_TYPES` type whose externalId does NOT start
 * with the daily-stats prefix, that is not tombstoned, AND whose
 * `measuredAt` is older than the retention window) and enqueues one
 * retention job per account.
 *
 * Idempotent across reboots: once a user's out-of-window per-sample rows
 * are soft-deleted, the predicate drops them from the discovery set.
 * pg-boss `singletonKey` coalesces duplicate sends. Best-effort: errors
 * are returned through the result value so worker boot never fails because
 * of a retention miss.
 */
export async function enqueueBootTimeDenseIntradayRetention(): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  // Kill-switch: enqueue nothing while the drain is disabled.
  if (!DENSE_INTRADAY_RETENTION_ENABLED) {
    return { enqueued: 0, skipped: 0, error: null };
  }
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // The dense-tier type set is a closed compile-time list of enum
    // members; splice-free — Prisma binds the `type IN (...)` array as
    // parameters.
    const types = Array.from(DENSE_INTRADAY_RETENTION_TYPES);
    if (types.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    const windowStart = new Date(
      Date.now() - DENSE_INTRADAY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    // `groupBy` compiles to a server-side `GROUP BY` — Prisma's
    // `distinct` dedups in the client AFTER pulling every matching row,
    // an instance-wide scan of every out-of-window dense-tier row just
    // to list user ids.
    const users = await prisma.measurement.groupBy({
      by: ["userId"],
      where: {
        source: "APPLE_HEALTH",
        type: { in: types },
        deletedAt: null,
        NOT: { externalId: { startsWith: "stats:" } },
        measuredAt: { lt: windowStart },
      },
    });

    if (users.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of users) {
      const payload: DenseIntradayRetentionPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(DENSE_INTRADAY_RETENTION_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        // Defer past the boot storm so the drain never contends with
        // startup + foreground for the shared connection pool. This drain is
        // the furthest-out stage among the boot backfills by design.
        startAfter: DENSE_INTRADAY_RETENTION_BOOT_DELAY_SECONDS,
        singletonKey: `dense-intraday-retention|${userId}`,
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
