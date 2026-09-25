/**
 * v1.7.0 — consolidate high-frequency spot HealthKit metrics into one
 * daily-MEAN row per user per calendar day.
 *
 * Apple Health emits walking-speed, respiratory-rate, and audio-exposure
 * samples at sensor granularity — tens-to-hundreds of `Measurement` rows
 * per day. Unlike the cumulative types (steps, energy, distance), the
 * correct daily reduction for these is the MEAN, not the SUM. This pass
 * collapses the per-sample rows into a single canonical daily row keyed
 * by the locked `stats:<HKIdentifier>:<YYYY-MM-DD>` externalId shape so
 * historical detail reads consistently and storage stays bounded.
 *
 * Scope per `HIGH_FREQUENCY_MEAN_TYPES`:
 *   RESPIRATORY_RATE, AUDIO_EXPOSURE_ENV, AUDIO_EXPOSURE_HEADPHONE,
 *   WALKING_SPEED, WALKING_STEP_LENGTH, WALKING_ASYMMETRY,
 *   WALKING_DOUBLE_SUPPORT, WALKING_STEADINESS, WALKING_HEART_RATE_AVERAGE
 *
 * PULSE is NOT in the set — correlation/scatter analytics read raw PULSE
 * rows. PULSE keeps raw storage; its display stays daily-averaged via
 * the read-path AVG.
 *
 * Per user × type × completed calendar day (anchored to `User.timezone`):
 *   1. SELECT live (`deletedAt IS NULL`) `source = 'APPLE_HEALTH'` rows
 *      for the type whose externalId is NOT the daily-stats shape and
 *      whose `measuredAt` is older than the 36-hour grace cutoff (keeps
 *      today's in-flight watch syncs raw for the live "today" view).
 *   2. Group into per-day buckets in the user's timezone.
 *   3. Compute the MEAN of the per-sample values for the day.
 *   4. UPSERT the canonical daily row keyed by
 *      `stats:<HKIdentifier>:<dateKey>` at local-noon, `value = mean`.
 *      Because mean types are NOT in `CUMULATIVE_HK_TYPES`, the daily
 *      read path averages over the single stats row (count = 1) and
 *      returns it unchanged — no reader change needed.
 *   5. SOFT-DELETE (set `deletedAt`) the per-sample rows — they stay in
 *      the table as an audit/backup trail. Sub-day detail loss is
 *      accepted, matching the legacy-step consolidation choice.
 *
 * Idempotent: the discovery query matches only users still holding live
 * per-sample mean-type rows, so a second run converges to zero work.
 * Within a run, soft-deleted rows are excluded from the scan, and the
 * single minted stats row is excluded by the `NOT externalId LIKE
 * 'stats:%'` predicate so it is never re-folded.
 *
 * Runs on pg-boss (`MEAN_CONSOLIDATION_QUEUE`), not a CLI — the
 * production standalone image strips `tsx`. Modelled on the
 * `step-consolidation` boot-time converging-backfill pattern.
 */
import type {
  MeasurementType,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";

import {
  dailyStatsExternalId,
  hkIdentifierForType,
  HIGH_FREQUENCY_MEAN_TYPES,
} from "./apple-health-mapping";
import {
  CONSOLIDATION_GRACE_CUTOFF_HOURS,
  bucketRowsByDay,
  runConsolidation,
  type DayWriteOutcome,
} from "./consolidation-base";
import { type PerSampleRow } from "./drain-per-sample-cumulative";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

/**
 * Grace window — rows newer than `now() - cutoffHours` stay raw so
 * today's still-in-flight watch syncs surface in the live "today" view.
 * Sourced from the shared `CONSOLIDATION_GRACE_CUTOFF_HOURS` so it tracks
 * the cumulative drain's `DRAIN_CUMULATIVE_CUTOFF_HOURS` in lockstep.
 */
export const MEAN_CONSOLIDATION_CUTOFF_HOURS = CONSOLIDATION_GRACE_CUTOFF_HOURS;

/** The daily-stats externalId prefix marks an already-collapsed row. */
const DAILY_STATS_PREFIX = "stats:";

export interface MeanConsolidationBucket {
  userId: string;
  type: MeasurementType;
  /** Calendar-day key in the user's timezone (`YYYY-MM-DD`). */
  dateKey: string;
  /** Number of per-sample rows folded for this day. */
  perSampleCount: number;
  /** MEAN of the per-sample values for the day. */
  meanValue: number;
  /** ISO-8601 canonical timestamp (local-noon of the user's day). */
  canonicalTimestamp: string;
  /** Resulting daily `externalId`. */
  externalId: string;
}

export interface MeanConsolidationSummary {
  dryRun: boolean;
  /**
   * `shouldStop` ended the walk before every day was reached. Nothing is
   * lost: folded days committed one by one, and the next run starts at the
   * first day this one did not reach.
   */
  stoppedEarly: boolean;
  buckets: MeanConsolidationBucket[];
  totals: {
    usersScanned: number;
    daysConsolidated: number;
    perSampleRowsSoftDeleted: number;
    dailyRowsUpserted: number;
    /**
     * Day buckets whose write failed and was stepped over. A failed day
     * keeps its per-sample rows live, so the next nightly run retries it;
     * every other bucket of the pass still consolidates.
     */
    daysFailed: number;
  };
}

export interface MeanConsolidationOptions {
  /** Limit the pass to a single user. Default = every user. */
  userId?: string;
  /** Preview-only mode — no DB writes. */
  dryRun?: boolean;
  /** Logger sink — defaults to `console.log`. */
  log?: (line: string) => void;
  /**
   * Protect recent per-sample rows from collapse. Rows whose
   * `measuredAt` is newer than `now() - cutoffHours` are excluded from
   * the scan. The scheduled nightly call passes
   * `MEAN_CONSOLIDATION_CUTOFF_HOURS`; an explicit one-shot can pass
   * `undefined` to drain everything.
   */
  cutoffHours?: number;
  /**
   * Ends the pass cleanly before the next day when it returns `true`; the
   * summary then reports `stoppedEarly`. See `ConsolidationOptions`.
   */
  shouldStop?: () => boolean;
}

/** Arithmetic mean of a per-day bucket. Exposed for unit testing. */
export function meanBucketValue(rows: readonly PerSampleRow[]): number {
  if (rows.length === 0) return 0;
  let acc = 0;
  for (const row of rows) acc += row.value;
  return acc / rows.length;
}

/**
 * Group per-sample rows into per-day buckets in the user's timezone.
 * Rows already in the daily-stats shape are skipped — they are the
 * canonical mean, not a sample. Exposed for unit testing without Prisma.
 */
export function bucketMeanRows(
  rows: readonly PerSampleRow[],
  tz: string,
): Map<string, PerSampleRow[]> {
  return bucketRowsByDay(rows, tz, DAILY_STATS_PREFIX);
}

/**
 * Find the first instant at/after `base + 1s` that the full unique
 * `(userId, type, measuredAt, source, sleepStage)` — NULLS NOT DISTINCT,
 * so tombstones occupy it too — does not already hold for this
 * (user, type, APPLE_HEALTH, sleepStage NULL) tuple. A slot held by the
 * row carrying `selfExternalId` counts as free: that row is the one the
 * caller's upsert is about to update in place, so re-using its instant
 * converges across re-runs instead of drifting one second per night.
 * Bounded probe; the per-day failure boundary in `runConsolidation`
 * absorbs the pathological exhaustion case.
 */
async function nextFreeInstant(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    type: MeasurementType;
    base: Date;
    selfExternalId: string | null;
  },
): Promise<Date> {
  for (let offsetSeconds = 1; offsetSeconds <= 60; offsetSeconds++) {
    const candidate = new Date(input.base.getTime() + offsetSeconds * 1000);
    const occupant = await tx.measurement.findFirst({
      where: {
        userId: input.userId,
        type: input.type,
        source: "APPLE_HEALTH",
        measuredAt: candidate,
        sleepStage: null,
      },
      select: { externalId: true },
    });
    if (
      occupant === null ||
      (input.selfExternalId !== null &&
        occupant.externalId === input.selfExternalId)
    ) {
      return candidate;
    }
  }
  throw new Error(
    `no free measuredAt slot within 60s after ${input.base.toISOString()}`,
  );
}

/**
 * Run the daily-mean consolidation. Idempotent — re-invocation after a
 * successful pass reports zero days because the per-sample rows are
 * soft-deleted (and so excluded from the live scan).
 *
 * Does NOT enforce any auth gate — the queue handler owns that concern.
 */
export async function consolidateDailyMean(
  prismaClient: PrismaClient,
  options: MeanConsolidationOptions = {},
): Promise<MeanConsolidationSummary> {
  const log = options.log ?? ((line) => console.log(line));

  const summary: MeanConsolidationSummary = {
    dryRun: options.dryRun ?? false,
    stoppedEarly: false,
    buckets: [],
    totals: {
      usersScanned: 0,
      daysConsolidated: 0,
      perSampleRowsSoftDeleted: 0,
      dailyRowsUpserted: 0,
      daysFailed: 0,
    },
  };

  const walk = await runConsolidation<MeasurementType>({
    prismaClient,
    options,
    types: HIGH_FREQUENCY_MEAN_TYPES,
    hkIdentifierForType,
    dailyStatsExternalId,
    statsPrefix: DAILY_STATS_PREFIX,
    reduce: meanBucketValue,
    // Live per-sample rows for the type, source-scoped to APPLE_HEALTH so
    // manual + Withings spot rows survive. The single minted stats row is
    // excluded by the NOT-startsWith predicate so it is never re-folded;
    // soft-deleted rows are excluded so a re-run converges.
    buildScanWhere: ({ userId, type, cutoffAt, statsPrefix }) => ({
      userId,
      source: "APPLE_HEALTH",
      type,
      deletedAt: null,
      NOT: { externalId: { startsWith: statsPrefix } },
      ...(cutoffAt ? { measuredAt: { lt: cutoffAt } } : {}),
    }),
    // Mean needs the row unit to carry it onto the canonical daily row.
    scanSelect: {
      id: true,
      type: true,
      value: true,
      measuredAt: true,
      externalId: true,
      unit: true,
    },
    writeDay: async ({
      prismaClient: pc,
      userId,
      type,
      externalId,
      canonicalTimestamp,
      reducedValue,
      dayRows,
      sourceRowIds,
    }): Promise<DayWriteOutcome> => {
      // Carry the canonical unit straight off the in-hand live day rows
      // (units are homogeneous per type). Avoids an extra per-day query
      // and never reads a soft-deleted row's unit — the scan already
      // filters `deletedAt: null`.
      const unit = dayRows[0]?.unit ?? "unknown";
      let removed = 0;
      await pc.$transaction(async (tx) => {
        // The upsert below arbiters on (userId, type, source, externalId),
        // but the Measurement model carries a SECOND full unique —
        // (userId, type, measuredAt, source, sleepStage), NULLS NOT
        // DISTINCT, covering tombstones (schema.prisma, migration 0055).
        // Any row sitting exactly on the canonical local-noon instant with
        // a DIFFERENT externalId — live or soft-deleted — trips that index
        // on the upsert's create path (P2002) and rolls the whole day
        // back. Resolve the slot deterministically before minting:
        //   1. Slot row carries the TARGET externalId → it IS the
        //      canonical daily row (re-run path); the upsert updates it in
        //      place, no conflict.
        //   2. Slot row is a tombstone, or a per-sample row this very pass
        //      is about to soft-delete → it has no live claim on the
        //      instant; step it aside to the next free second so the
        //      canonical row keeps the local-noon anchor.
        //   3. Slot row is a live foreign row outside the consolidation
        //      set (it stays user-visible and is not ours to move) → it
        //      keeps its instant; the mean row yields and mints on the
        //      next free second after local-noon instead.
        const slotRow = await tx.measurement.findFirst({
          where: {
            userId,
            type,
            source: "APPLE_HEALTH",
            measuredAt: canonicalTimestamp,
            sleepStage: null,
          },
          select: { id: true, externalId: true, deletedAt: true },
        });

        let mintAt = canonicalTimestamp;
        if (slotRow !== null && slotRow.externalId !== externalId) {
          const yieldsToMean =
            slotRow.deletedAt !== null || sourceRowIds.includes(slotRow.id);
          if (yieldsToMean) {
            // `selfExternalId: null` — the shifted row must land on a
            // strictly free instant; sharing one with the canonical row
            // (e.g. a mean row that yielded on an earlier run and still
            // sits at +1s) would re-trip the unique.
            await tx.measurement.update({
              where: { id: slotRow.id },
              data: {
                measuredAt: await nextFreeInstant(tx, {
                  userId,
                  type,
                  base: canonicalTimestamp,
                  selfExternalId: null,
                }),
              },
            });
          } else {
            // `selfExternalId: externalId` — an instant already held by
            // the existing mean row (yielded on an earlier run) counts as
            // free, so the upsert re-targets it instead of drifting one
            // second further every night.
            mintAt = await nextFreeInstant(tx, {
              userId,
              type,
              base: canonicalTimestamp,
              selfExternalId: externalId,
            });
          }
        }

        // Mint / refresh the canonical daily-mean row. The unique
        // index (userId, type, source, externalId) makes the upsert
        // idempotent across re-runs. Built field-by-field (no spread)
        // per the no-mass-assignment convention.
        await tx.measurement.upsert({
          where: {
            userId_type_source_externalId: {
              userId,
              type,
              source: "APPLE_HEALTH",
              externalId,
            },
          },
          create: {
            userId,
            type,
            value: reducedValue,
            unit,
            source: "APPLE_HEALTH",
            measuredAt: mintAt,
            externalId,
          },
          update: {
            value: reducedValue,
            measuredAt: mintAt,
            deletedAt: null,
          },
        });

        // Soft-delete the per-sample rows in the same transaction —
        // tombstone, never hard-delete; they remain as an audit trail and
        // drop off the live read + this pass's re-run discovery.
        const del = await tx.measurement.updateMany({
          where: { id: { in: sourceRowIds }, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        removed = del.count;
      });

      // T3 — recompute the affected (user, type, day) rollup buckets after
      // the consolidation commits, the same way the batch route does on
      // ingest. Without it, a rollup-covered read could serve a pre-drain
      // mean derived from the now soft-deleted per-sample rows: the rollup
      // tier reads only `deleted_at IS NULL`, so the stale DAY bucket must
      // be re-aggregated against the single consolidated row. The
      // canonical timestamp is local-noon of the consolidated day, which
      // lands the recompute on the correct UTC day bucket.
      await recomputeBucketsForMeasurement(userId, type, canonicalTimestamp);

      return { kind: "written", sourceRowsRemoved: removed };
    },
    recordBucket: ({
      userId,
      type,
      dateKey,
      dayRows,
      reducedValue,
      canonicalTimestamp,
      externalId,
      outcome,
    }) => {
      summary.buckets.push({
        userId,
        type,
        dateKey,
        perSampleCount: dayRows.length,
        meanValue: reducedValue,
        canonicalTimestamp: canonicalTimestamp.toISOString(),
        externalId,
      });
      summary.totals.daysConsolidated += 1;
      summary.totals.dailyRowsUpserted += 1;
      summary.totals.perSampleRowsSoftDeleted +=
        outcome?.kind === "written"
          ? outcome.sourceRowsRemoved
          : dayRows.length;
    },
    onUserComplete: ({ userId, tz, dryRun }) => {
      log(
        `[mean-consolidation] user=${userId} tz=${tz}${dryRun ? " (dry-run)" : ""}`,
      );
    },
    // Per-day failure boundary: one poisoned day (e.g. a residual
    // unique-index collision the slot resolution could not absorb) must
    // not abort the global nightly pass — every later user / type / day
    // still consolidates, and the failed day's per-sample rows stay live
    // for the next run to retry.
    onBucketError: ({ userId, type, dateKey, error }) => {
      const reason = error instanceof Error ? error.message : String(error);
      log(
        `[mean-consolidation] user=${userId} type=${type} day=${dateKey} failed — ${reason}; continuing with the next bucket`,
      );
    },
  });

  summary.totals.usersScanned = walk.usersScanned;
  summary.stoppedEarly = walk.stoppedEarly;
  summary.totals.daysFailed = walk.daysFailed;

  log(
    `[mean-consolidation] done — usersScanned=${summary.totals.usersScanned} daysConsolidated=${summary.totals.daysConsolidated} perSampleRowsSoftDeleted=${summary.totals.perSampleRowsSoftDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted} daysFailed=${summary.totals.daysFailed}${options.dryRun ? " (dry-run)" : ""}`,
  );

  return summary;
}
