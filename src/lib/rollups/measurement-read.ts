/**
 * v1.5.0 — read-side helpers that aggregate the persistent rollup
 * table into the same `DataSummary` shape the live aggregator
 * returns. The reader-side surfaces (`summaries-slice`,
 * `comprehensive-aggregator`, the analytics route) re-aggregate the
 * trailing DAY buckets directly via `readRollupBuckets` and feed the
 * resulting rows into `aggregateBuckets` below.
 *
 * The 90-day window is reconstructed from DAY buckets by:
 *   - sum(count_i)              → window count
 *   - min(min_i)                → window min
 *   - max(max_i)                → window max
 *   - sum(count_i × mean_i) / Σcount_i → window mean (weighted by daily count)
 *
 * That re-aggregation is mathematically exact for `count`, `min`,
 * `max`, and `mean` — they are linearly composable across DAY buckets.
 * SD / slope / R² are NOT exact: aggregating across DAY buckets is not
 * the same as the population stats over the raw rows. For those, the
 * rollup-read path delegates to live SQL so the byte-shape parity with
 * the v1.4.34.1 / 4.5 aggregator survives.
 */

import type {
  MeasurementSource,
  MeasurementType,
  RollupGranularity,
} from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import {
  windowWeighting,
  type WindowWeighting,
} from "@/lib/measurements/day-statistic";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";
import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";

/**
 * v1.11.1 — load a user's source-priority blob for the rollup collapse.
 * `null` makes `collapseRollupRowsBySource` fall back to the default ladders.
 * Callers that read many types in a loop should load it once and thread it
 * through, rather than paying one lookup per read.
 */
export async function loadUserSourcePriority(userId: string): Promise<unknown> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { sourcePriorityJson: true },
  });
  return user?.sourcePriorityJson ?? null;
}

export interface DailyMeanRow {
  day: Date;
  count: number;
  mean: number;
  minValue: number;
  maxValue: number;
}

/**
 * v1.21.0 — regression x-origin (epoch-days of 2020-01-01 UTC).
 *
 * The regression accumulators (`sum_x / sum_xy / sum_xx`) store x RELATIVE to
 * this fixed origin: `x = EXTRACT(EPOCH FROM measured_at)/86400.0 − ORIGIN`.
 * Raw epoch-days sit at x ≈ 20 540, so `x²` lands near 4.2e8 and `Σxx`
 * accumulates past ~1e10 — squaring shaves ~10 of double's ~15-16 significant
 * decimal digits BEFORE the value is ever stored, so the sub-day fractional x
 * (the time-of-day) is already lossy at write time. No read-side identity can
 * recover bits lost at accumulation. Rebasing to a recent origin keeps x in the
 * low thousands (x² ≤ ~1e7 for any realistic window), so the squared terms stay
 * comfortably exact.
 *
 * Slope / r² / population-sd are INVARIANT under an affine x-shift (subtracting
 * a constant from every x leaves Sxx, Sxy, Syy unchanged), so the composed
 * result is identical to the un-shifted basis — only the unreported intercept
 * would move. The writer SQL and migration 0193 share this exact literal; the
 * live REGR_* probe stays on raw epoch-days and matches because slope / r² / sd
 * do not depend on the origin.
 *
 * 2020-01-01 = 18 262 days after the Unix epoch. It MUST stay a stable
 * compile-time constant — changing it would orphan every stored accumulator
 * until a full re-fold. Pick a value comfortably before any plausible reading.
 */
export const REGRESSION_X_ORIGIN_DAYS = Math.floor(
  Date.UTC(2020, 0, 1) / 86_400_000,
); // 18262

/**
 * v1.20.0 F6 — per-bucket OLS regression accumulators (epoch-day x-axis).
 * Mirrors the four columns migration 0190 added to `measurement_rollups`
 * plus the `n` / `Σy` the existing `count` / `mean` already carry. A bucket
 * whose accumulators predate the migration (or whose write missed the
 * re-fold) reports `sumXy === null`; the reader treats any null in the
 * window as a coverage miss and falls back to the live REGR_* path.
 */
export interface RegressionAccumulators {
  count: number;
  /**
   * Per-bucket mean. Kept for the count/min/max/mean composition and as the
   * Σy fallback (`mean·count`) when the exact `sumValue` accumulator is null.
   */
  mean: number;
  /**
   * Exact Σy = SUM(value) over the bucket's rows. The writer stores this in
   * `sum_value` (migration pre-0190; `schema.prisma` `sumValue`); composing Σy
   * from it instead of `mean·count` removes the ~1-ULP float-reorder residual
   * the AVG→multiply round trip introduces. `null` on a row whose write
   * predates the column, in which case the composer falls back to `mean·count`.
   */
  sumValue?: number | null;
  sumX: number | null;
  sumXy: number | null;
  sumXx: number | null;
  sumYy: number | null;
}

/** Closed-form windowed regression result. `null` when undefined. */
export interface ComposedRegression {
  slope: number | null;
  r2: number | null;
  /** Population standard deviation (divides by n, matching STDDEV_POP). */
  sdPop: number | null;
}

/**
 * v1.20.0 F6 — compose a windowed OLS slope / r² / population-sd from the
 * summed regression accumulators of a set of DAY buckets.
 *
 * The six terms (`n = Σcount`, `Σx`, `Σy`, `Σxy`, `Σxx`, `Σyy`) are ADDITIVE
 * across buckets, so summing the per-bucket accumulators over the window and
 * evaluating the closed form yields a result that matches Postgres
 * `REGR_SLOPE` / `REGR_R2` / `STDDEV_POP` over the same raw rows (Postgres
 * folds the same accumulators).
 *
 * The composition uses the MEAN-CENTERED (corrected-sum) identities rather
 * than the textbook determinant form `n·Σxx − Σx²`:
 *
 *   Sxx    = Σxx − Σx²/n
 *   Sxy    = Σxy − Σx·Σy/n
 *   Syy    = Σyy − Σy²/n
 *   slope  = Sxy / Sxx
 *   r²     = Sxy² / (Sxx·Syy)
 *   sd_pop = sqrt(Syy / n)
 *
 * This is algebraically identical to the determinant form (multiply numerator
 * and denominator by n) and to Postgres' REGR_* / STDDEV_POP, but numerically
 * stable: the centered form subtracts `Σx²/n` from `Σxx` at the same scale per
 * term, so the cancellation is bounded by the true x-variance, not the absolute
 * x magnitude.
 *
 * v1.21.0 — the accumulators are stored REBASED to `REGRESSION_X_ORIGIN_DAYS`
 * (x = epoch_days − origin), so `Σxx` stays O(1e7) instead of O(1e10) and the
 * squared terms never shed precision at write time. Slope / r² / sd are
 * invariant under the x-shift, so this composes the SAME regression the live
 * (un-rebased) REGR_* probe folds — the rebase only restores the bits the raw
 * epoch-day square would have lost. Σy is read from the exact stored `sumValue`
 * accumulator when present (falling back to `mean·count`), removing the
 * AVG→multiply ULP residual on the y side too.
 *
 * The caller MUST collapse overlapping sources to the canonical source
 * BEFORE handing rows here — the accumulators are per-source, so summing a
 * dual-source day's two rows would double-count the reading. Pass the
 * already-source-collapsed bucket set.
 *
 * Coverage contract: returns `{ null, null, null }` (a full miss) when
 *   - any bucket in the window has a `null` accumulator (pre-migration row
 *     the boot re-fold has not refilled), or
 *   - the window holds fewer than 2 readings, or
 *   - a denominator degenerates to 0 (no x-variance / no y-variance).
 *
 * The caller treats a miss as "fall back to live SQL", so a partially
 * back-filled window never silently returns a wrong (partial) regression.
 *
 * Postgres' REGR_SLOPE / REGR_R2 ignore rows with a NULL dependent or
 * independent value; `value` and `measured_at` are NOT NULL on
 * `measurements`, so every raw row contributes and the accumulator `n`
 * equals the live `regr_count`.
 */
export function composeRegression(
  buckets: ReadonlyArray<RegressionAccumulators>,
): ComposedRegression {
  const MISS: ComposedRegression = { slope: null, r2: null, sdPop: null };
  if (buckets.length === 0) return MISS;

  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXy = 0;
  let sumXx = 0;
  let sumYy = 0;
  for (const b of buckets) {
    // Any null accumulator in the window means the row predates the
    // accumulator columns (or its re-fold is pending) — bail to live SQL
    // rather than compose a regression over an incomplete window.
    if (
      b.sumX === null ||
      b.sumXy === null ||
      b.sumXx === null ||
      b.sumYy === null
    ) {
      return MISS;
    }
    n += b.count;
    sumX += b.sumX;
    // Σy is the exact stored SUM(value) when the bucket carries it; fall back
    // to mean·count for pre-`sumValue` rows. The exact accumulator removes the
    // AVG→multiply float-reorder residual.
    sumY += b.sumValue ?? b.mean * b.count;
    sumXy += b.sumXy;
    sumXx += b.sumXx;
    sumYy += b.sumYy;
  }

  if (n < 2) return MISS;

  // Mean-centered (corrected-sum) identities. Sxx/Sxy/Syy are the determinant
  // terms divided by n — algebraically identical to `n·Σxx − Σx²` etc., but
  // they subtract `Σx²/n` from `Σxx` at matched scale, avoiding the
  // catastrophic cancellation the determinant form suffers on the ~1e10
  // epoch-day x-axis. See the function header for the full rationale.
  const sxx = sumXx - (sumX * sumX) / n;
  const syy = sumYy - (sumY * sumY) / n;
  const sxy = sumXy - (sumX * sumY) / n;

  const slope = sxx === 0 ? null : sxy / sxx;
  // REGR_R2 is null when either variance is zero (matches Postgres).
  const r2 = sxx === 0 || syy === 0 ? null : (sxy * sxy) / (sxx * syy);

  // Population variance: Syy/n = Σyy/n − (Σy/n)². Clamp tiny negative values
  // float rounding can produce when the variance is effectively zero.
  const variance = syy / n;
  const sdPop = variance <= 0 ? 0 : Math.sqrt(variance);

  return { slope, r2, sdPop };
}

/** Minimal shape the source collapse needs from a per-source rollup row. */
export interface SourcedBucketRow {
  bucketStart: Date;
  source: MeasurementSource;
  count: number;
}

/**
 * v1.11.1 — collapse per-source rollup rows to ONE row per bucket using the
 * user's source-priority ladder. The writer mints one row per
 * (type, day, source); this resolves overlapping sources (e.g. WHOOP + Apple
 * Watch resting heart rate) to the ladder-canonical reading before the linear
 * composition in `aggregateBuckets` / the WMY readers runs. Cumulative types
 * collapse to the single canonical source too, so the caller reads that one
 * source's summed `sumValue` — a day's total reflects one source, never a
 * cross-source sum.
 *
 * Resolution per bucket:
 *   1. the first source in the metric's ladder that is present → canonical;
 *   2. no ladder match (an unlisted source, or a type with no ladder) → the
 *      row with the alphabetically smallest source name, so the bucket
 *      neither doubles nor goes dark AND the pick matches the live-SQL
 *      paths' `ORDER BY … source` tiebreak.
 *
 * Input order is preserved (buckets emit in first-seen order). A single-source
 * day (the common case) short-circuits to the row unchanged.
 */
export function collapseRollupRowsBySource<T extends SourcedBucketRow>(
  rows: T[],
  type: MeasurementType,
  userPriorityJson: unknown,
): T[] {
  if (rows.length <= 1) return rows;

  const byBucket = new Map<number, T[]>();
  for (const row of rows) {
    const key = row.bucketStart.getTime();
    const slot = byBucket.get(key);
    if (slot) slot.push(row);
    else byBucket.set(key, [row]);
  }

  const metricKey = metricKeyForType(type);
  const ladder: readonly MeasurementSource[] = metricKey
    ? getSourceLadder(parseSourcePriority(userPriorityJson), metricKey)
    : [];

  const out: T[] = [];
  for (const bucketRows of byBucket.values()) {
    if (bucketRows.length === 1) {
      out.push(bucketRows[0]);
      continue;
    }
    let picked: T | undefined;
    for (const source of ladder) {
      const hit = bucketRows.find((r) => r.source === source);
      if (hit) {
        picked = hit;
        break;
      }
    }
    if (!picked) {
      // No ladder match — keep one row deterministically by alphabetically
      // smallest source name, so the bucket neither doubles nor goes dark AND
      // the pick matches the live-SQL paths' `ORDER BY … source` tiebreak
      // (live/rollup parity for a ranked type whose day carries only
      // non-ladder sources).
      picked = bucketRows.reduce((best, r) =>
        r.source < best.source ? r : best,
      );
    }
    out.push(picked);
  }
  return out;
}

/**
 * v1.20.0 F6 — a DAY bucket carrying its `bucketStart` plus the
 * regression accumulators. The windowed-regression readers consume an
 * array of these (one canonical-source row per day) and slice them into
 * the 7/30/90-day sub-windows before composing.
 */
export interface AccumulatorBucketRow extends RegressionAccumulators {
  bucketStart: Date;
}

/**
 * v1.20.0 F6 — compose a windowed slope / r² / population-sd over the DAY
 * buckets whose `bucketStart` falls on or after `since`.
 *
 * The window is DAY-aligned (a bucket is in-window iff its `bucketStart`
 * is `>= since`), matching the DAY-rollup grain. Callers anchor `since` on
 * a UTC-day boundary (`startOfUtcDay(now − N days)`) so the window is the
 * day-aligned equivalent of the live `measured_at >= NOW() - INTERVAL 'N
 * days'` filter. The accumulator-composed result over a given bucket set
 * is bit-identical to live REGR_* / STDDEV_POP over the same buckets' raw
 * rows — the parity test pins this.
 *
 * Returns a full miss `{ null, null, null }` when any in-window bucket
 * lacks accumulators (see `composeRegression`), so a partially back-filled
 * window falls through to live SQL rather than returning a partial answer.
 */
export function composeWindowedRegression(
  rows: ReadonlyArray<AccumulatorBucketRow>,
  since: Date,
): ComposedRegression {
  const cutoff = since.getTime();
  const inWindow = rows.filter((r) => r.bucketStart.getTime() >= cutoff);
  return composeRegression(inWindow);
}

/**
 * v1.20.0 P3 M-1 — true iff any in-window DAY bucket carries a NULL
 * regression accumulator (a row that predates migration 0190, or whose
 * boot re-fold has not yet refilled it). `composeWindowedRegression`
 * collapses both that case AND the legitimate "< 2 readings" / degenerate
 * cases into the same `{ null, null, null }` miss, so the reader cannot
 * tell from the composed result alone whether a null slope is the honest
 * answer or a coverage gap pending backfill.
 *
 * The slim / comprehensive readers call this alongside the compose so they
 * can annotate the miss (`regression_source:"unavailable_pending_backfill"`)
 * per the project's "no silent cap / log any truncation" rule. The null
 * value itself stays — it converges once the boot backfill refills the
 * accumulators — but the MISS becomes observable rather than silent.
 *
 * Window contract matches `composeWindowedRegression`: a bucket is
 * in-window iff its `bucketStart` is `>= since`.
 */
export function hasPendingAccumulatorBackfill(
  rows: ReadonlyArray<AccumulatorBucketRow>,
  since: Date,
): boolean {
  const cutoff = since.getTime();
  for (const r of rows) {
    if (r.bucketStart.getTime() < cutoff) continue;
    if (
      r.sumX === null ||
      r.sumXy === null ||
      r.sumXx === null ||
      r.sumYy === null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Combine DAY buckets into the linearly-composable window stats —
 * `count`, `min`, `max`, `mean`. SD / slope / R² are intentionally
 * NOT computed here because they don't compose across DAY rollups.
 *
 * `weighting` decides how the days make up the window mean. By default each
 * day weighs its sample count, which is the plain mean over every reading. For
 * a type whose DAY value is the mean of its hourly means (pulse, see
 * `day-statistic.ts`) pass `"day"`: every day weighs one. Weighting days by how
 * many samples they hold would hand a workout day, with its thousands of
 * samples, the same outsized share the hourly mean exists to take away.
 * `count` stays the number of readings either way.
 */
export function aggregateBuckets(
  rows: DailyMeanRow[],
  weighting: WindowWeighting = "count",
): {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
} {
  if (rows.length === 0) {
    return { count: 0, min: null, max: null, mean: null };
  }
  let totalCount = 0;
  let sumWeighted = 0;
  let totalWeight = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    totalCount += r.count;
    // A day with no readings carries no weight under either rule.
    const weight = weighting === "day" ? (r.count > 0 ? 1 : 0) : r.count;
    sumWeighted += weight * r.mean;
    totalWeight += weight;
    if (r.minValue < min) min = r.minValue;
    if (r.maxValue > max) max = r.maxValue;
  }
  if (totalCount === 0 || totalWeight === 0) {
    return { count: 0, min: null, max: null, mean: null };
  }
  return {
    count: totalCount,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    mean: sumWeighted / totalWeight,
  };
}

const DAY_MS = 86_400_000;

/**
 * Start of the UTC bucket containing `at` at the given granularity. The same
 * cut Postgres `date_trunc(<unit>, measured_at)` makes on the rollup writer's
 * UTC wall-clock `measured_at` (weeks are ISO weeks starting on Monday).
 */
export function utcBucketStart(at: Date, granularity: RollupGranularity): Date {
  switch (granularity) {
    case "DAY":
      return startOfUtcDay(at);
    case "WEEK": {
      const day = startOfUtcDay(at);
      // getUTCDay(): Sunday = 0 … Saturday = 6; ISO weeks start on Monday.
      const mondayOffset = (day.getUTCDay() + 6) % 7;
      return new Date(day.getTime() - mondayOffset * DAY_MS);
    }
    case "MONTH":
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    case "YEAR":
      return new Date(Date.UTC(at.getUTCFullYear(), 0, 1));
  }
}

/** Start of the UTC bucket after the one containing `at`. */
export function utcBucketEnd(at: Date, granularity: RollupGranularity): Date {
  const start = utcBucketStart(at, granularity);
  switch (granularity) {
    case "DAY":
      return new Date(start.getTime() + DAY_MS);
    case "WEEK":
      return new Date(start.getTime() + 7 * DAY_MS);
    case "MONTH":
      return new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
      );
    case "YEAR":
      return new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1));
  }
}

/** One canonical-source bucket, at any granularity. */
export interface CanonicalRollupBucket {
  bucketStart: Date;
  count: number;
  /** Days of the bucket that hold a reading (1 for a DAY bucket). */
  days: number;
  /**
   * The mean of the bucket's daily means, each day weighing one: what the
   * chart's own fold of day points gives. `mean` weighs every reading.
   */
  dayMean: number;
  mean: number;
  minValue: number;
  maxValue: number;
  sumValue: number | null;
  sd: number | null;
  slope: number | null;
  r2: number | null;
  sumX: number | null;
  sumXy: number | null;
  sumXx: number | null;
  sumYy: number | null;
  computedAt: Date;
}

/**
 * One coarse bucket as the canonical-day fold returns it: the summed
 * composable stats of the bucket's canonical days.
 */
interface FoldedBucketRow {
  bucket_start: Date;
  count: number;
  /** Canonical DAY rows folded into the bucket: its days with a reading. */
  days: number;
  /** The days' own means added up (each day weighs one). */
  sum_day_mean: number;
  sum_y: number;
  min_value: number;
  max_value: number;
  /** Null when any day of the bucket lacks the regression accumulators. */
  sum_x: number | null;
  sum_xy: number | null;
  sum_xx: number | null;
  sum_yy: number | null;
  computed_at: Date;
}

/** SQL `date_trunc` unit per coarse granularity (a closed map, never input). */
const COARSE_TRUNC_UNIT: Record<Exclude<RollupGranularity, "DAY">, string> = {
  WEEK: "week",
  MONTH: "month",
  YEAR: "year",
};

/**
 * Compose one coarse bucket from the summed stats of its canonical days.
 * `count`, `min`, `max`, `sum` and the count-weighted `mean` are exact;
 * `sd`, `slope` and `r2` come from the summed regression accumulators
 * (`composeRegression`) and are `null` when a day lacks them.
 */
function composeFoldedBucket(
  row: FoldedBucketRow,
  weighting: WindowWeighting = "count",
): CanonicalRollupBucket {
  const count = Number(row.count);
  const sumY = Number(row.sum_y);
  // The mean of every reading: what the regression below composes from.
  const sampleMean = sumY / count;
  const dayMean = Number(row.sum_day_mean) / Number(row.days);
  // The bucket's own `mean`: every reading, or, for a type whose DAY value is
  // the mean of its hourly means (pulse), every day once.
  const mean = weighting === "day" ? dayMean : sampleMean;
  const accumulatorsComplete =
    row.sum_x !== null &&
    row.sum_xy !== null &&
    row.sum_xx !== null &&
    row.sum_yy !== null;
  const sumX = accumulatorsComplete ? Number(row.sum_x) : null;
  const sumXy = accumulatorsComplete ? Number(row.sum_xy) : null;
  const sumXx = accumulatorsComplete ? Number(row.sum_xx) : null;
  const sumYy = accumulatorsComplete ? Number(row.sum_yy) : null;
  const regression = accumulatorsComplete
    ? composeRegression([
        { count, mean: sampleMean, sumValue: sumY, sumX, sumXy, sumXx, sumYy },
      ])
    : { slope: null, r2: null, sdPop: null };
  return {
    bucketStart: new Date(row.bucket_start),
    count,
    days: Number(row.days),
    dayMean,
    mean,
    minValue: Number(row.min_value),
    maxValue: Number(row.max_value),
    sumValue: sumY,
    // A single reading has no spread; STDDEV_POP of one value is 0.
    sd: count === 1 && accumulatorsComplete ? 0 : regression.sdPop,
    slope: regression.slope,
    r2: regression.r2,
    sumX,
    sumXy,
    sumXx,
    sumYy,
    computedAt: new Date(row.computed_at),
  };
}

/**
 * Read one type's canonical rollup buckets at `granularity`.
 *
 * Every granularity is built from the DAY tier. The canonical source is a
 * per-DAY decision: a week, month or year in which the user logged most days
 * by hand and one day from a device holds readings from both, and each of
 * those days counts. Collapsing the stored per-source WEEK / MONTH / YEAR
 * rows instead picked ONE source for the whole bucket, so a month of manual
 * blood-pressure readings plus one synced one reported the synced day alone,
 * and a step history that switched devices mid-month lost every day logged by
 * the losing device. The stored coarse rows are therefore not read.
 *
 * DAY: the day's rows collapse to the ladder-canonical source in
 * `collapseRollupRowsBySource`. WEEK / MONTH / YEAR: the same pick runs in
 * SQL (`DISTINCT ON` the day, ordered by the ladder rank and then the source
 * name, the order the JS collapse uses), and the days fold into their bucket
 * there too, so a five-year read returns a handful of rows, not every day.
 *
 * A bucket is returned when its start lies in the window: `bucketStart >=
 * from`, and `< to` (or `<= to` with `toInclusive`). `to === null` leaves the
 * window open towards now. A returned bucket always carries all of its days,
 * including days past `to`, the way the stored coarse rows did.
 */
export async function readCanonicalRollupBuckets(opts: {
  userId: string;
  type: MeasurementType;
  granularity: RollupGranularity;
  from: Date;
  to: Date | null;
  toInclusive?: boolean;
  /** The user's source-priority blob; `undefined` loads it on demand. */
  userPriorityJson?: unknown;
}): Promise<CanonicalRollupBucket[]> {
  const { userId, type, granularity, from, to } = opts;
  if (granularity === "DAY") {
    const dayRows = await prisma.measurementRollup.findMany({
      where: {
        userId,
        type,
        granularity: "DAY",
        bucketStart:
          to === null
            ? { gte: from }
            : opts.toInclusive
              ? { gte: from, lte: to }
              : { gte: from, lt: to },
      },
      orderBy: { bucketStart: "asc" },
      select: {
        bucketStart: true,
        source: true,
        count: true,
        mean: true,
        minValue: true,
        maxValue: true,
        sumValue: true,
        sd: true,
        slope: true,
        r2: true,
        sumX: true,
        sumXy: true,
        sumXx: true,
        sumYy: true,
        computedAt: true,
      },
    });
    if (dayRows.length === 0) return [];
    const priority =
      opts.userPriorityJson !== undefined
        ? opts.userPriorityJson
        : await loadUserSourcePriority(userId);
    return collapseRollupRowsBySource(dayRows, type, priority).map(
      ({ source: _source, ...day }) => ({ ...day, days: 1, dayMean: day.mean }),
    );
  }

  const priority =
    opts.userPriorityJson !== undefined
      ? opts.userPriorityJson
      : await loadUserSourcePriority(userId);
  const unit = Prisma.raw(`'${COARSE_TRUNC_UNIT[granularity]}'`);
  const rank = Prisma.raw(
    buildSourceRankCase(priority, 'r."type"', 'r."source"'),
  );
  // The DAY read reaches the end of the last bucket that can start inside the
  // window, so that bucket folds complete; buckets that start before `from`
  // hold only part of their days and are left out below.
  const upper =
    to === null
      ? Prisma.empty
      : Prisma.sql`AND r."bucket_start" < ${utcBucketEnd(to, granularity)}`;
  const rows = await prisma.$queryRaw<FoldedBucketRow[]>`
    WITH canon AS (
      SELECT DISTINCT ON (r."bucket_start")
        r."bucket_start", r."count", r."mean", r."min_value", r."max_value",
        r."sum_value", r."sum_x", r."sum_xy", r."sum_xx", r."sum_yy",
        r."computed_at"
      FROM measurement_rollups r
      WHERE r."user_id" = ${userId}
        AND r."type" = ${type}::measurement_type
        AND r."granularity" = 'DAY'
        AND r."bucket_start" >= ${from}
        ${upper}
      ORDER BY r."bucket_start", (${rank}), r."source"::text
    )
    SELECT
      date_trunc(${unit}, c."bucket_start" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                                                             AS bucket_start,
      SUM(c."count")::int                                    AS count,
      COUNT(*)::int                                          AS days,
      SUM(c."mean")::double precision                        AS sum_day_mean,
      SUM(COALESCE(c."sum_value", c."count" * c."mean"))::double precision
                                                             AS sum_y,
      MIN(c."min_value")::double precision                   AS min_value,
      MAX(c."max_value")::double precision                   AS max_value,
      CASE WHEN COUNT(c."sum_x") = COUNT(*) AND COUNT(c."sum_xy") = COUNT(*)
            AND COUNT(c."sum_xx") = COUNT(*) AND COUNT(c."sum_yy") = COUNT(*)
        THEN SUM(c."sum_x") END::double precision            AS sum_x,
      CASE WHEN COUNT(c."sum_x") = COUNT(*) AND COUNT(c."sum_xy") = COUNT(*)
            AND COUNT(c."sum_xx") = COUNT(*) AND COUNT(c."sum_yy") = COUNT(*)
        THEN SUM(c."sum_xy") END::double precision           AS sum_xy,
      CASE WHEN COUNT(c."sum_x") = COUNT(*) AND COUNT(c."sum_xy") = COUNT(*)
            AND COUNT(c."sum_xx") = COUNT(*) AND COUNT(c."sum_yy") = COUNT(*)
        THEN SUM(c."sum_xx") END::double precision           AS sum_xx,
      CASE WHEN COUNT(c."sum_x") = COUNT(*) AND COUNT(c."sum_xy") = COUNT(*)
            AND COUNT(c."sum_xx") = COUNT(*) AND COUNT(c."sum_yy") = COUNT(*)
        THEN SUM(c."sum_yy") END::double precision           AS sum_yy,
      MAX(c."computed_at")                                   AS computed_at
    FROM canon c
    GROUP BY 1
    ORDER BY 1
  `;
  const fromMs = from.getTime();
  const toMs = to?.getTime() ?? null;
  const weighting = windowWeighting(type);
  return rows
    .map((r) => composeFoldedBucket(r, weighting))
    .filter((b) => {
      const start = b.bucketStart.getTime();
      if (start < fromMs) return false;
      if (toMs === null) return true;
      return opts.toInclusive ? start <= toMs : start < toMs;
    });
}
