/**
 * The full fold of one account's rollup tier, and the boot discovery that
 * decides which accounts need one.
 *
 * The write hooks keep the DAY bucket of each touched day current and the
 * read path warms the last 90 days, but neither folds the deep WEEK / MONTH /
 * YEAR history, and neither refills a column a migration adds to rows that
 * already exist (the accumulators of 0190, the reading extremes of 0417). The
 * full backfill does both, once per account the discovery finds.
 *
 * Sized for large accounts (#1298). The fold used to be four aggregates over
 * the whole five-year window, each held to the connection's statement limit
 * (60 s unless `DATABASE_STATEMENT_TIMEOUT_MS` says otherwise). On an account
 * with tens of millions of readings no aggregate finished in time, the job
 * failed on every boot, and the columns 0417 added never filled, so every
 * reader that needs them stayed on the raw table and timed out as well. The
 * fold now works through the window one UTC calendar year at a time, newest
 * first, and every statement of the full backfill runs under its own limit
 * (`ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS`), the shape the pulse day-mean
 * rebuild already had. Each window commits on its own, so a run that reaches
 * its job budget hands the remaining years to a follow-up job instead of
 * starting over on the retry.
 */
import { activeAccountSql } from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import {
  applyStatementBudget,
  recomputeUserRollups,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";

/**
 * The boot-time full-fold queue: one job per account the discovery finds, so
 * a self-hosted instance converges on the rollup tier without an operator.
 */
export const ROLLUP_FULL_BACKFILL_QUEUE = "rollup-full-backfill";

/** Boot-fold worker concurrency. Serial so we don't crowd the pool. */
export const ROLLUP_FULL_BACKFILL_CONCURRENCY = 1;

/**
 * The full fold's expiry: an hour. A run stops itself at three quarters of it
 * (`jobBudget`), between two windows or two granularities, and hands what is
 * left to a follow-up, so the expiry bounds one run, not the whole account.
 * The margin above the budget covers the statement in flight, which can run
 * for `ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS`.
 */
export const ROLLUP_FULL_BACKFILL_EXPIRE_SECONDS = 60 * 60;

/**
 * The limit of every statement the full backfill and its discovery run, in
 * place of the connection's request limit. Five minutes, as the pulse
 * day-mean rebuild uses: one calendar year of one account's readings,
 * aggregated per granularity, stays well inside it on the largest accounts
 * reported, while a statement that would run longer still ends.
 */
export const ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS = 5 * 60 * 1000;

/** Seconds a follow-up waits before it picks up the remaining years. */
export const ROLLUP_FULL_BACKFILL_CONTINUATION_DELAY_SECONDS = 60;

/** Payload of one full-fold job. */
export interface RollupFullBackfillPayload {
  userId: string;
  /** Wall-clock kick-off for debugging only. */
  enqueuedAt: string;
  /**
   * ISO instant. A follow-up folds only the windows that end at or before
   * it: the run that sent it folded everything newer.
   */
  resumeBefore?: string;
}

/** The retry policy of every full-fold send. */
const RETRY_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/**
 * `[from, to)` windows covering `[from, to)`, cut at UTC New Year and
 * returned newest first. Every DAY, MONTH and YEAR bucket lies inside one
 * window, and a WEEK that spans New Year is folded whole by both of its
 * windows (the fold snaps each window out to whole buckets), so the windows
 * write exactly the buckets one fold over the whole span writes. Pure.
 */
export function fullBackfillWindows(
  from: Date,
  to: Date,
): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = [];
  let end = to.getTime();
  const floor = from.getTime();
  while (end > floor) {
    const year = new Date(end).getUTCFullYear();
    const newYear = Date.UTC(year, 0, 1);
    const start = Math.max(
      floor,
      newYear === end ? Date.UTC(year - 1, 0, 1) : newYear,
    );
    out.push({ from: new Date(start), to: new Date(end) });
    end = start;
  }
  return out;
}

export interface RollupHistoryFold {
  rowsUpserted: number;
  durationMs: number;
  /** Windows folded completely by this call. */
  windowsFolded: number;
  /**
   * Set when `shouldStop` ended the fold: every window that ends at or
   * before this instant is still to fold, and nothing newer is.
   */
  resumeBefore?: Date;
}

/**
 * Fold one account's rollup tier over the five-year window, every type and
 * granularity, one calendar year at a time, newest first. The same buckets
 * `recomputeUserRollups(userId)` writes in one pass; see
 * `fullBackfillWindows` for why the windows change nothing about them.
 *
 * `before` resumes a fold that stopped: only the windows ending at or before
 * it run. `shouldStop` is asked before each window and between the
 * granularities of a window; a window it interrupts is folded again whole by
 * the follow-up, so `resumeBefore` is always a window's end.
 */
export async function foldUserRollupHistory(
  userId: string,
  opts: {
    before?: Date;
    shouldStop?: () => boolean;
    statementTimeoutMs?: number;
    now?: Date;
  } = {},
): Promise<RollupHistoryFold> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const floor = new Date(now.getTime() - ROLLUP_FOLD_WINDOW_MS);
  const ceiling = opts.before && opts.before < now ? opts.before : now;
  let rowsUpserted = 0;
  let windowsFolded = 0;
  const result = (resumeBefore?: Date): RollupHistoryFold => ({
    rowsUpserted,
    durationMs: Date.now() - startedAt,
    windowsFolded,
    ...(resumeBefore ? { resumeBefore } : {}),
  });
  for (const window of fullBackfillWindows(floor, ceiling)) {
    if (opts.shouldStop?.()) return result(window.to);
    const done = await recomputeUserRollups(userId, {
      from: window.from,
      to: window.to,
      statementTimeoutMs: opts.statementTimeoutMs,
      shouldStop: opts.shouldStop,
    });
    rowsUpserted += done.rowsUpserted;
    if (done.stopped) return result(window.to);
    windowsFolded += 1;
  }
  return result();
}

/**
 * Hand the windows a stopped fold did not reach to a follow-up job. Keyed on
 * the account and the resume point: the running job still holds the account's
 * boot key, and a second follow-up for the same point is the same work.
 * Throws when no queue is attached or the send fails, so the run fails and
 * its retry folds the same windows again rather than leaving them.
 */
export async function sendRollupFullBackfillContinuation(
  userId: string,
  resumeBefore: Date,
): Promise<boolean> {
  const boss = getGlobalBoss();
  if (!boss) {
    throw new Error("rollup-full-backfill: no queue to hand the rest to");
  }
  const payload: RollupFullBackfillPayload = {
    userId,
    enqueuedAt: new Date().toISOString(),
    resumeBefore: resumeBefore.toISOString(),
  };
  const jobId = await boss.send(ROLLUP_FULL_BACKFILL_QUEUE, payload, {
    ...RETRY_OPTIONS,
    expireInSeconds: ROLLUP_FULL_BACKFILL_EXPIRE_SECONDS,
    singletonKey: `boot-backfill|${userId}|${payload.resumeBefore}`,
    startAfter: ROLLUP_FULL_BACKFILL_CONTINUATION_DELAY_SECONDS,
  });
  return jobId !== null;
}

/**
 * Whether a full fold of the account is queued or running. The dense fold
 * leaves such an account alone (`ConsolidationOptions.deferUser`): it deletes
 * the raw samples a fold still has to read, and a year the full backfill
 * reached after the dense fold would take its day figures from hourly means.
 *
 * False when there is no queue table (a web-only deployment has no full
 * backfill either). Any other failure to read the queue counts as pending:
 * the dense fold's deletion cannot be undone, and deferring an account costs
 * one night. The failure is annotated on the caller's event.
 *
 * A full fold that failed for good (retries spent) is not pending, and the
 * dense fold goes ahead on that account; the system job alert reports the
 * failed backfill, and the next boot's discovery enqueues it again.
 */
export async function isRollupFullBackfillPending(
  userId: string,
): Promise<boolean> {
  try {
    const [queue] = await prisma.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regclass('pgboss.job') IS NOT NULL AS present
    `;
    if (!queue?.present) return false;
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pgboss.job
      WHERE name = ${ROLLUP_FULL_BACKFILL_QUEUE}
        AND state IN ('created', 'retry', 'active')
        AND data->>'userId' = ${userId}
    `;
    return (rows[0]?.n ?? 0) > 0;
  } catch (err) {
    annotate({
      meta: {
        rollup_backfill_pending_check_failed: true,
        rollup_backfill_pending_check_error:
          err instanceof Error ? err.message.slice(0, 200) : String(err),
      },
    });
    return true;
  }
}

/**
 * Boot-time discovery. Finds the accounts whose rollup tier misses something
 * inside the fold window and enqueues one full fold per account.
 *
 * Two arms:
 *
 *   1. Missing coverage per day: a (user, type, UTC day) with a live reading
 *      and no DAY rollup row. Per day rather than per type, because a sync
 *      or a restore that writes without the write hook leaves gaps in a type
 *      that already has buckets.
 *   2. A DAY rollup row inside the window whose regression accumulators
 *      (0190) or reading extremes (0417) are NULL: a row folded before the
 *      column existed. New folds write them, so the arm drains to empty.
 *
 * Both are bounded to the fold window. The fold writes nothing older, so an
 * older gap would flag the account on every boot and never close.
 *
 * Arm 1 used to read every live reading in the window, which on an account
 * with tens of millions of rows is the same scan that kept the fold itself
 * from finishing. It now walks the days instead: per account and type, the
 * first live reading at or after the start of each next UTC day, read off
 * the live `(user_id, type, measured_at)` index, so the cost follows the
 * number of days with readings, not the number of readings. The statement
 * also runs under the full backfill's own limit.
 *
 * Idempotent across reboots: an account drops off once it is covered, and
 * the per-account `singletonKey` coalesces a send while a fold is queued.
 * Best-effort: errors come back in the result so the worker boot never fails.
 */
export async function enqueueBootTimeRollupBackfill(
  // Optional boot-storm stagger, seconds. Default 0 keeps immediate semantics
  // for any non-boot caller.
  startAfterSeconds: number = 0,
): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    const foldWindowStart = new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS);
    const users = await prisma.$transaction(
      async (tx) => {
        await applyStatementBudget(
          tx,
          ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS,
        );
        return tx.$queryRaw<Array<{ id: string }>>`
          WITH RECURSIVE pairs AS (
            SELECT u."id" AS user_id, t.type
            FROM users u
            CROSS JOIN unnest(enum_range(NULL::"measurement_type")) AS t(type)
            WHERE ${activeAccountSql('u."id"')}
          ),
          days AS (
            SELECT p.user_id, p.type, f.at
            FROM pairs p
            CROSS JOIN LATERAL (
              SELECT min(m."measured_at") AS at
              FROM measurements m
              WHERE m."user_id" = p.user_id
                AND m."type" = p.type
                AND m."deleted_at" IS NULL
                AND m."measured_at" >= ${foldWindowStart}
            ) f
            WHERE f.at IS NOT NULL
            UNION ALL
            SELECT d.user_id, d.type, n.at
            FROM days d
            CROSS JOIN LATERAL (
              SELECT min(m."measured_at") AS at
              FROM measurements m
              WHERE m."user_id" = d.user_id
                AND m."type" = d.type
                AND m."deleted_at" IS NULL
                AND m."measured_at" >= date_trunc('day', d.at) + interval '1 day'
            ) n
            WHERE n.at IS NOT NULL
          )
          SELECT DISTINCT id FROM (
            SELECT d.user_id AS id
            FROM days d
            WHERE NOT EXISTS (
              SELECT 1 FROM measurement_rollups r
              WHERE r."user_id" = d.user_id
                AND r."type" = d.type
                AND r."granularity" = 'DAY'
                AND r."bucket_start" = date_trunc('day', d.at)
            )

            UNION

            SELECT r."user_id" AS id
            FROM measurement_rollups r
            WHERE r."granularity" = 'DAY'
              AND r."bucket_start" >= ${foldWindowStart}
              AND (r."sum_xy" IS NULL OR r."reading_min_value" IS NULL)
              AND ${activeAccountSql('r."user_id"')}
          ) discovered
        `;
      },
      {
        maxWait: 10_000,
        timeout: ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS + 30_000,
      },
    );

    let enqueued = 0;
    let skipped = 0;
    for (const { id } of users) {
      const payload: RollupFullBackfillPayload = {
        userId: id,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(ROLLUP_FULL_BACKFILL_QUEUE, payload, {
        ...RETRY_OPTIONS,
        expireInSeconds: ROLLUP_FULL_BACKFILL_EXPIRE_SECONDS,
        // Coalesce: if a backfill for this user is already queued and
        // we restart, pg-boss returns null instead of duplicating.
        singletonKey: `boot-backfill|${id}`,
        ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}),
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
