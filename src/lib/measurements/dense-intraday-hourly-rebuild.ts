/**
 * v1.28.31 — one-shot history rebuild: hourly means for already-folded
 * dense-tier days.
 *
 * Before v1.28.31 the dense intra-day retention drain folded out-of-window
 * per-sample APPLE_HEALTH rows (`HEART_RATE_VARIABILITY`, `PULSE`,
 * `OXYGEN_SATURATION`) into ONE daily-mean `stats:<HK>:<YYYY-MM-DD>` row
 * per day, erasing the intraday shape. The fold soft-deletes rather than
 * hard-deletes, so for every day folded within the tombstone-retention
 * horizon the raw samples are still in the table — enough to reconstruct
 * the hourly grain the fold now writes.
 *
 * Scope, per user × dense-tier type × local day OLDER than the retention
 * window: a day qualifies only when BOTH
 *   (a) a live daily-grain `stats:<HK>:<YYYY-MM-DD>` row exists (the
 *       pre-hourly fold's output — hourly rows carry a `T<HH>` suffix and
 *       never match the daily shape), AND
 *   (b) tombstoned non-`stats:` APPLE_HEALTH raw rows exist inside the
 *       day's local window (the fold's soft-deleted inputs).
 *
 * Per qualifying day: compute per-local-hour means from the tombstoned raw
 * rows (same `meanBucketValue` reducer + `adoptOrMintHourlyRows`
 * adopt-in-place slot logic as the live fold, so a re-run converges), then
 * tombstone the daily row IN THE SAME TRANSACTION as the hourly mint — at
 * no instant are the daily row and its hourly rows both live, so an
 * AVG-over-live-rows reader can never double-count the day.
 *
 * Days with no tombstoned raw rows keep their daily row untouched (their
 * tombstones were pruned past the retention horizon — the daily mean is
 * the only surviving representation). Days inside the retention window are
 * never touched (the daily-row scan is bounded by the window cutoff).
 * Non-APPLE_HEALTH sources are never touched (every predicate is
 * source-scoped).
 *
 * DAY-rollup handling after a rebuilt day:
 *   - `PULSE` + `OXYGEN_SATURATION`: DAY buckets are left untouched — they
 *     hold the TRUE pre-fold min/max/mean the fold captured from raw rows;
 *     recomputing from hourly means would degrade them.
 *   - `HEART_RATE_VARIABILITY`: the pre-v1.28.31 fold recomputed the HRV
 *     DAY bucket AFTER the fold, collapsing it to min == max == mean of
 *     the single daily row. Hourly-derived stats are strictly better, so
 *     the DAY bucket is recomputed from the now-live hourly rows.
 *   - WEEK/MONTH/YEAR aggregate from live measurement rows (not from DAY
 *     buckets — see `runRollupAggregate`), and the rebuild changes the
 *     live row population of the day, so whole-bucket recomputes are
 *     enqueued for every affected span (via `bucketSpan`, never a partial
 *     span).
 *
 * Idempotent / self-converging: retiring the daily row removes the day
 * from the (a)+(b) pairing, so a re-run — and the boot-time discovery in
 * `src/lib/jobs/dense-intraday-hourly-rebuild.ts` — converges to zero
 * work. The retired daily row IS the durable marker; no schema column is
 * needed (the `lab-biomarker-backfill` "the data is the marker" pattern).
 *
 * Runs on pg-boss — the production standalone image strips `tsx`, so this
 * can never be a CLI script.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { isP2002 as isUniqueConstraintViolation } from "@/lib/prisma-errors";

import { hkIdentifierForType } from "./apple-health-mapping";
import {
  loadConsolidationUsers,
  resolveUserTimezone,
} from "./consolidation-base";
import {
  canonicalDailyTimestamp,
  canonicalHourlyTimestamp,
  localDayWindow,
  type PerSampleRow,
} from "./consolidation-tz";
import { meanBucketValue } from "./consolidate-daily-mean";
import {
  DENSE_INTRADAY_RETENTION_DAYS,
  DENSE_INTRADAY_RETENTION_TYPES,
  adoptOrMintHourlyRows,
  bucketRowsByLocalHour,
  hourlyStatsExternalId,
} from "./dense-intraday-retention";
import {
  bucketSpan,
  enqueueRollupRecompute,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";

/**
 * The daily-grain suffix a pre-hourly fold row carries after
 * `stats:<HK>:` — exactly a calendar-day key. Hourly rows
 * (`…:<YYYY-MM-DD>T<HH>`) and the iOS hourly-HR wire rows
 * (`…:<ISO-instant>Z`) both fail this shape, so the rebuild can never
 * mistake them for a daily row.
 */
const DAILY_SUFFIX_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DenseIntradayHourlyRebuildSummary {
  dryRun: boolean;
  totals: {
    usersScanned: number;
    /** Days converted from the daily to the hourly grain. */
    daysRebuilt: number;
    /** Hourly `stats:` rows minted / adopted across all rebuilt days. */
    hourlyRowsUpserted: number;
    /** Daily `stats:` rows tombstoned (one per rebuilt day). */
    dailyRowsRetired: number;
    /**
     * Days whose daily row survives because zero tombstoned raw rows
     * remain for the day (pruned past the tombstone-retention horizon) —
     * nothing to reconstruct from.
     */
    daysSkippedNoTombstones: number;
    /** Days whose rebuild threw and was stepped over (retried next run). */
    daysFailed: number;
  };
}

export interface DenseIntradayHourlyRebuildOptions {
  /** Limit the pass to a single user. Default = every user. */
  userId?: string;
  /** Preview-only mode — no DB writes. */
  dryRun?: boolean;
  /** Logger sink — defaults to `console.log`. */
  log?: (line: string) => void;
  /**
   * Retention window in days — daily rows anchored INSIDE the window are
   * never touched. Defaults to `DENSE_INTRADAY_RETENTION_DAYS`; tests can
   * pass `0` to lift the bound.
   */
  retentionDays?: number;
}

/**
 * Run the hourly history rebuild. See the module header for scope and
 * invariants. Does NOT enforce any auth gate — the queue handler owns
 * that concern.
 */
export async function runDenseIntradayHourlyRebuild(
  prismaClient: PrismaClient,
  options: DenseIntradayHourlyRebuildOptions = {},
): Promise<DenseIntradayHourlyRebuildSummary> {
  const log = options.log ?? ((line) => console.log(line));
  const dryRun = options.dryRun ?? false;
  const retentionDays = options.retentionDays ?? DENSE_INTRADAY_RETENTION_DAYS;
  const cutoffAt =
    retentionDays > 0
      ? new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
      : null;

  const summary: DenseIntradayHourlyRebuildSummary = {
    dryRun,
    totals: {
      usersScanned: 0,
      daysRebuilt: 0,
      hourlyRowsUpserted: 0,
      dailyRowsRetired: 0,
      daysSkippedNoTombstones: 0,
      daysFailed: 0,
    },
  };

  const users = await loadConsolidationUsers(prismaClient, options.userId);
  summary.totals.usersScanned = users.length;

  for (const user of users) {
    const tz = resolveUserTimezone(user.timezone);

    for (const type of DENSE_INTRADAY_RETENTION_TYPES) {
      const hkIdentifier = hkIdentifierForType(type);
      if (!hkIdentifier) continue;

      // Candidate days: live daily-grain stats rows older than the window.
      // The startsWith narrows to this type's stats family; the exact
      // daily shape is asserted in JS below (Prisma has no regex filter),
      // which also bounds the scan — at most one daily row per folded day.
      const statsPrefix = `stats:${hkIdentifier}:`;
      const dailyRows = await prismaClient.measurement.findMany({
        where: {
          userId: user.id,
          type,
          source: "APPLE_HEALTH",
          deletedAt: null,
          externalId: { startsWith: statsPrefix },
          ...(cutoffAt ? { measuredAt: { lt: cutoffAt } } : {}),
        },
        select: { id: true, externalId: true },
        orderBy: { measuredAt: "asc" },
      });

      const candidates: Array<{ id: string; dateKey: string }> = [];
      for (const row of dailyRows) {
        const suffix = row.externalId?.slice(statsPrefix.length) ?? "";
        if (DAILY_SUFFIX_RE.test(suffix)) {
          candidates.push({ id: row.id, dateKey: suffix });
        }
      }
      if (candidates.length === 0) continue;

      for (const candidate of candidates) {
        // Per-day failure boundary: one poisoned day is stepped over so the
        // walk keeps rebuilding every other user / type / day; the failed
        // day keeps its live daily row, so the discovery re-finds it.
        try {
          const rebuilt = await rebuildDay(prismaClient, {
            userId: user.id,
            type,
            hkIdentifier,
            tz,
            dateKey: candidate.dateKey,
            dailyRowId: candidate.id,
            dryRun,
          });
          if (rebuilt === null) {
            summary.totals.daysSkippedNoTombstones += 1;
            continue;
          }
          summary.totals.daysRebuilt += 1;
          summary.totals.hourlyRowsUpserted += rebuilt.hourlyRows;
          summary.totals.dailyRowsRetired += rebuilt.dailyRetired ? 1 : 0;

          if (dryRun) continue;

          const dayAnchor = canonicalDailyTimestamp(candidate.dateKey, tz);
          if (type === "HEART_RATE_VARIABILITY") {
            // Historical HRV DAY buckets were collapsed to
            // min == max == mean at fold time; the now-live hourly rows
            // carry strictly better stats. Recompute DAY inline (and let
            // the call enqueue the WEEK/MONTH/YEAR spans).
            await recomputeBucketsForMeasurement(user.id, type, dayAnchor);
          } else {
            // PULSE + SpO2: the DAY bucket holds the TRUE pre-fold
            // min/max/mean — leave it untouched. Only the WEEK/MONTH/YEAR
            // buckets aggregate live rows whose population this rebuild
            // changed, so enqueue whole-span recomputes for them.
            await Promise.all(
              (["WEEK", "MONTH", "YEAR"] as const).map((granularity) => {
                const { from, to } = bucketSpan(dayAnchor, granularity);
                return enqueueRollupRecompute({
                  userId: user.id,
                  type,
                  granularity,
                  from,
                  to,
                });
              }),
            );
          }
        } catch (err) {
          summary.totals.daysFailed += 1;
          const reason = err instanceof Error ? err.message : String(err);
          log(
            `[dense-intraday-hourly-rebuild] user=${user.id} type=${type} day=${candidate.dateKey} failed — ${reason}; continuing with the next day`,
          );
        }
      }
    }
  }

  log(
    `[dense-intraday-hourly-rebuild] done — usersScanned=${summary.totals.usersScanned} daysRebuilt=${summary.totals.daysRebuilt} hourlyRowsUpserted=${summary.totals.hourlyRowsUpserted} dailyRowsRetired=${summary.totals.dailyRowsRetired} daysSkippedNoTombstones=${summary.totals.daysSkippedNoTombstones} daysFailed=${summary.totals.daysFailed}${dryRun ? " (dry-run)" : ""}`,
  );

  return summary;
}

/**
 * Rebuild one (user, type, local day): hourly means from the day's
 * tombstoned raw rows + retirement of the daily row, atomically. Returns
 * `null` when the day has no tombstoned raw rows (skip — the daily row is
 * the only surviving representation), otherwise the per-day counts.
 */
async function rebuildDay(
  prismaClient: PrismaClient,
  input: {
    userId: string;
    type: MeasurementType;
    hkIdentifier: string;
    tz: string;
    dateKey: string;
    dailyRowId: string;
    dryRun: boolean;
  },
): Promise<{ hourlyRows: number; dailyRetired: boolean } | null> {
  const { dayStart, dayEnd } = localDayWindow(input.dateKey, input.tz);

  // The fold's soft-deleted inputs: tombstoned per-sample rows inside the
  // day's local window. Never `stats:` rows (a tombstoned daily row from a
  // neighbouring rebuild must not feed the mean), never another source.
  const tombstoned = (await prismaClient.measurement.findMany({
    where: {
      userId: input.userId,
      type: input.type,
      source: "APPLE_HEALTH",
      deletedAt: { not: null },
      NOT: { externalId: { startsWith: "stats:" } },
      measuredAt: { gte: dayStart, lt: dayEnd },
    },
    select: {
      id: true,
      type: true,
      value: true,
      measuredAt: true,
      externalId: true,
      unit: true,
    },
    orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
  })) as PerSampleRow[];

  if (tombstoned.length === 0) return null;

  const unit = tombstoned[0]?.unit ?? "unknown";
  const byHour = [
    ...bucketRowsByLocalHour(tombstoned, input.tz).entries(),
  ].sort((a, b) => a[0] - b[0]);

  if (input.dryRun) {
    return { hourlyRows: byHour.length, dailyRetired: true };
  }

  const rebuildOnce = async (): Promise<{ dailyRetired: boolean }> => {
    let dailyRetired = false;
    await prismaClient.$transaction(async (tx) => {
      const canonicalRowIds = await adoptOrMintHourlyRows(tx, {
        userId: input.userId,
        type: input.type,
        unit,
        slots: byHour.map(([hour, hourRows]) => ({
          externalId: hourlyStatsExternalId(
            input.hkIdentifier,
            input.dateKey,
            hour,
          ),
          anchor: canonicalHourlyTimestamp(input.dateKey, hour, input.tz),
          value: meanBucketValue(hourRows),
        })),
      });

      // Retire the daily row in the SAME transaction — at no instant are
      // the daily row and the hourly rows both live (an AVG-over-live-rows
      // reader would double-count the day). Guarded against the degenerate
      // adopt where the daily row itself became an hourly slot (a
      // DST-shifted anchor landing on the daily instant): tombstoning it
      // then would erase the rebuild.
      if (!canonicalRowIds.includes(input.dailyRowId)) {
        await tx.measurement.update({
          where: { id: input.dailyRowId },
          data: { deletedAt: new Date() },
        });
        dailyRetired = true;
      }
    });
    return { dailyRetired };
  };

  let outcome: { dailyRetired: boolean };
  try {
    outcome = await rebuildOnce();
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    // A concurrent writer (the nightly fold racing this rebuild) won a slot
    // mid-transaction. Retry once: the deterministic lookup inside
    // `adoptOrMintHourlyRows` now resolves the winning row and adopts it.
    outcome = await rebuildOnce();
  }

  return { hourlyRows: byHour.length, dailyRetired: outcome.dailyRetired };
}
