/**
 * v1.28.31 — pg-boss queue + boot-time one-shot discovery for the dense-tier
 * hourly history rebuild (`runDenseIntradayHourlyRebuild`).
 *
 * Modelled on the self-converging boot backfills (`lab-biomarker-backfill`,
 * `dense-intraday-retention`): a discovery query enqueues one job per user
 * that still holds rebuildable days, and the pass is idempotent across
 * reboots. The durable marker is the DATA, not a schema column: a rebuilt
 * day's daily `stats:` row is tombstoned in the same transaction as its
 * hourly rows, so the "live daily row PAIRED with tombstoned raw rows"
 * predicate below stops matching it — once every rebuildable day is
 * converted, the discovery returns zero users on every later boot and the
 * rebuild has run exactly once per install.
 *
 * The pairing in the discovery is deliberately coarse (±14 h around the
 * daily row's local-noon anchor covers the whole local day for every zone);
 * the per-user handler re-derives the exact tz-correct day window and skips
 * days whose tombstones actually belong to a neighbour. A residual
 * false-positive user costs one cheap no-op job per boot and disappears at
 * the latest when the tombstone-retention prune removes the neighbouring
 * raw tombstones.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder/register-rollup.ts` so pg-boss provisions it at
 * boot; an unregistered queue silently never drains.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { DENSE_INTRADAY_RETENTION_ENABLED } from "@/lib/jobs/dense-intraday-retention";
import {
  DENSE_INTRADAY_RETENTION_DAYS,
  DENSE_INTRADAY_RETENTION_TYPES,
} from "@/lib/measurements/dense-intraday-retention";
import { runDenseIntradayHourlyRebuild } from "@/lib/measurements/dense-intraday-hourly-rebuild";

export const DENSE_INTRADAY_HOURLY_REBUILD_QUEUE =
  "dense-intraday-hourly-rebuild";

/**
 * Serial concurrency — a rebuild walks every folded day for one account
 * with a transaction per day; concurrency-1 keeps it from crowding the
 * request pool, matching the retention drain's convention.
 */
export const DENSE_INTRADAY_HOURLY_REBUILD_CONCURRENCY = 1;

/**
 * Boot-discovery jobs start only after this delay (seconds). The rebuild
 * shares the retention drain's P2028 reasoning (transaction-per-day work
 * must never contend with the deploy storm for the shared pool) and is
 * staged AFTER the retention drain's 600 s defer so the two dense-tier
 * walks never overlap at boot.
 */
export const DENSE_INTRADAY_HOURLY_REBUILD_BOOT_DELAY_SECONDS = 900;

export interface DenseIntradayHourlyRebuildPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user queue handler. Runs the hourly history rebuild for one account
 * and returns the summary totals so the worker can log them.
 */
export async function runDenseIntradayHourlyRebuildForUser(
  userId: string,
  shouldStop?: () => boolean,
): Promise<{
  daysRebuilt: number;
  hourlyRowsUpserted: number;
  dailyRowsRetired: number;
  daysSkippedNoTombstones: number;
  /** The job's budget ran out first; see the queue handler. */
  stoppedEarly: boolean;
}> {
  // Shares the retention drain's kill-switch: when an operator disables the
  // dense tier, no-op so any already-queued backlog drains cleanly.
  if (!DENSE_INTRADAY_RETENTION_ENABLED) {
    return {
      daysRebuilt: 0,
      hourlyRowsUpserted: 0,
      dailyRowsRetired: 0,
      daysSkippedNoTombstones: 0,
      stoppedEarly: false,
    };
  }
  const summary = await runDenseIntradayHourlyRebuild(prisma, {
    userId,
    shouldStop,
    log: () => {
      // Silent inside the queue handler — the worker logs the totals.
    },
  });
  annotate({
    action: {
      name: "retention.hourly_rebuild.complete",
      details: {
        days_rebuilt: summary.totals.daysRebuilt,
        hourly_rows_upserted: summary.totals.hourlyRowsUpserted,
        daily_rows_retired: summary.totals.dailyRowsRetired,
        days_skipped_no_tombstones: summary.totals.daysSkippedNoTombstones,
        days_failed: summary.totals.daysFailed,
      },
    },
  });
  return {
    daysRebuilt: summary.totals.daysRebuilt,
    hourlyRowsUpserted: summary.totals.hourlyRowsUpserted,
    dailyRowsRetired: summary.totals.dailyRowsRetired,
    daysSkippedNoTombstones: summary.totals.daysSkippedNoTombstones,
    stoppedEarly: summary.stoppedEarly,
  };
}

/**
 * Discovery query for the boot enqueue: every user holding at least one
 * live daily-grain dense-tier `stats:` row older than the retention window
 * that is PAIRED with tombstoned raw rows of the same type within ±14 h of
 * the daily row's anchor (the coarse whole-local-day pairing; the per-user
 * handler re-derives the exact tz-correct window).
 *
 * The daily-grain shape is asserted with a constant regex — hourly rows
 * (`…T<HH>` suffix) and the iOS hourly-HR wire rows (ISO-instant suffix)
 * never match, so a converted day can never re-qualify. Prisma cannot
 * express the regex or the pairing, hence the parameter-bound `$queryRaw`;
 * the only spliced text is the constant pattern. Exported so the
 * integration suite pins the SQL against a real Postgres — a malformed
 * query here would surface only as a swallowed boot-discovery error and
 * the rebuild would silently never run.
 */
export async function findHourlyRebuildCandidateUserIds(
  prismaClient: PrismaClient,
  windowStart: Date,
): Promise<string[]> {
  const types = Array.from(DENSE_INTRADAY_RETENTION_TYPES).map(String);
  if (types.length === 0) return [];

  const users = await prismaClient.$queryRaw<Array<{ user_id: string }>>`
    SELECT DISTINCT m."user_id"
    FROM "measurements" m
    WHERE m."source" = 'APPLE_HEALTH'
      AND m."type"::text IN (${Prisma.join(types)})
      AND m."deleted_at" IS NULL
      AND m."external_id" ~ '^stats:[A-Za-z0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND m."measured_at" < ${windowStart}
      AND EXISTS (
        SELECT 1
        FROM "measurements" t
        WHERE t."user_id" = m."user_id"
          AND t."type" = m."type"
          AND t."source" = 'APPLE_HEALTH'
          AND t."deleted_at" IS NOT NULL
          AND t."external_id" NOT LIKE 'stats:%'
          AND t."measured_at" >= m."measured_at" - interval '14 hours'
          AND t."measured_at" <  m."measured_at" + interval '14 hours'
      )
  `;
  return users.map((u) => u.user_id);
}

/**
 * Boot-time discovery. Runs `findHourlyRebuildCandidateUserIds` and
 * enqueues one rebuild job per account.
 *
 * Idempotent across reboots: rebuilding a day tombstones its daily row,
 * which removes the pair. pg-boss `singletonKey` coalesces duplicate
 * sends. Best-effort: errors are returned through the result value so
 * worker boot never fails because of a rebuild miss.
 */
export async function enqueueBootTimeDenseIntradayHourlyRebuild(): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  if (!DENSE_INTRADAY_RETENTION_ENABLED) {
    return { enqueued: 0, skipped: 0, error: null };
  }
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    const windowStart = new Date(
      Date.now() - DENSE_INTRADAY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const userIds = await findHourlyRebuildCandidateUserIds(
      prisma,
      windowStart,
    );

    if (userIds.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const userId of userIds) {
      const payload: DenseIntradayHourlyRebuildPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        DENSE_INTRADAY_HOURLY_REBUILD_QUEUE,
        payload,
        {
          retryLimit: 3,
          retryDelay: 60,
          retryBackoff: true,
          // Defer past the boot storm AND past the retention drain's own
          // 600 s defer so the two dense-tier walks never overlap at boot.
          startAfter: DENSE_INTRADAY_HOURLY_REBUILD_BOOT_DELAY_SECONDS,
          singletonKey: `dense-intraday-hourly-rebuild|${userId}`,
        },
      );
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
