/**
 * WEEK / MONTH / YEAR readers over the measurement rollup tier.
 *
 * Helpers that read the trailing N-bucket window for a single
 * `(userId, type)` pair at a chosen granularity, plus an auto-router that
 * picks the largest granularity that still resolves the requested window.
 * The shape returned is identical to `readRollupBuckets` so callers can
 * interleave WEEK / MONTH / YEAR rows with DAY rows downstream without
 * branching on the source granularity.
 *
 * Built from the DAY tier
 * -----------------------
 * Every coarse bucket is folded from the canonical DAY buckets
 * (`readCanonicalRollupBuckets`): the source-priority ladder picks one
 * source per DAY, and the week, month or year then counts every one of its
 * days. The stored per-source WEEK / MONTH / YEAR rows cannot express that:
 * collapsing them picks one source for the whole bucket, so a month of
 * manual readings plus one synced reading reported only the synced day.
 *
 * Compositional contract
 * ----------------------
 * `count / min / max / mean / sumValue` compose exactly across days.
 * `sd / slope / r2` are composed from the summed regression accumulators,
 * which is exact over the canonical rows too; a bucket with any day that
 * lacks the accumulators reports them as `null`.
 *
 * Coverage-miss semantics
 * -----------------------
 * Each reader returns `null` when the window holds no DAY buckets for
 * `(userId, type)`. The caller decides whether that is a real "no data"
 * case or a coverage miss the boot backfill has not caught up on, and
 * usually falls through to live SQL.
 */
import type {
  MeasurementType,
  RollupGranularity,
} from "@/generated/prisma/client";

import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import type { WindowWeighting } from "@/lib/measurements/day-statistic";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import {
  loadUserSourcePriority,
  readCanonicalRollupBuckets,
} from "@/lib/rollups/measurement-read";

/**
 * Normalised bucket row returned by every WMY reader. Mirrors the
 * shape `readRollupBuckets` returns plus the `sumValue` column the
 * v1.4.39 W-SUM agent added to `MeasurementRollup`. `sumValue` is
 * `null` for rows that pre-date the column's introduction; the boot
 * backfill fills it in alongside the other stats.
 */
export interface RollupBucketRow {
  bucketStart: Date;
  count: number;
  /** Days of the bucket that hold a reading (1 for a DAY row). */
  days?: number;
  mean: number;
  sd: number | null;
  slope: number | null;
  r2: number | null;
  sumValue: number | null;
  minValue: number;
  maxValue: number;
}

/**
 * Per-granularity "this is the smallest window the granularity can
 * meaningfully resolve" floor. Used by `readBestGranularityRollups`
 * to route a requested window into the coarsest tier that still
 * carries enough buckets for the caller to do something useful.
 *
 *   - DAY     → any window — 90 daily buckets for a 90-day window
 *               is already trivially cheap and the trend resolution
 *               is canonical
 *   - WEEK    → > 90 days (~13 weekly buckets for a quarter)
 *   - MONTH   → > 180 days (~6 monthly buckets, enough trend signal
 *               for a half-year view; smaller windows benefit more
 *               from DAY-bucket granularity than coarse-grained
 *               averaging)
 *   - YEAR    → > 730 days (≥ 2 yearly buckets — anything below 2 y
 *               collapses to one bucket and carries no slope signal)
 *
 * The pinned routing the v1.5 multi-year trend card relies on:
 *   90 d → DAY   (90 buckets)
 *   365 d → MONTH (12 buckets)
 *   1095 d → YEAR (3 buckets)
 *
 * The floors are conservative on purpose — coarser tiers only
 * activate when the row-count savings actually justify trading the
 * finer trend resolution.
 */
const GRANULARITY_FLOORS: Array<{
  granularity: RollupGranularity;
  minWindowDays: number;
}> = [
  { granularity: "YEAR", minWindowDays: 731 },
  { granularity: "MONTH", minWindowDays: 181 },
  { granularity: "WEEK", minWindowDays: 91 },
  { granularity: "DAY", minWindowDays: 0 },
];

/**
 * Pick the largest granularity that can still resolve the requested
 * `windowDays` window (see `GRANULARITY_FLOORS`) and read it.
 *
 * Returns the granularity the helper resolved against plus the row
 * shape the internal `readGranularity` reader produces. `null` when
 * no granularity yields any buckets in the window — the caller is
 * expected to short-circuit to "no data" or to live SQL.
 */
export async function readBestGranularityRollups(
  userId: string,
  type: MeasurementType,
  windowDays: number,
  userPriorityJson?: unknown,
): Promise<{
  granularity: RollupGranularity;
  rows: RollupBucketRow[];
} | null> {
  if (!Number.isFinite(windowDays) || windowDays <= 0) return null;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  // v1.11.1 — load the source-priority blob once and thread it into every
  // granularity probe so the collapse never re-queries the user per floor.
  const priority =
    userPriorityJson !== undefined
      ? userPriorityJson
      : await loadUserSourcePriority(userId);
  // Every tier is folded from the same canonical DAY buckets, but a coarse
  // bucket that starts before `since` is left out (it holds only part of its
  // days). Data that sits only in that leading partial bucket, say three
  // months at the start of a 731-day window, reads as empty at YEAR: step one
  // tier finer until a tier has buckets, down to DAY, which starts inside the
  // window by construction.
  const floors = GRANULARITY_FLOORS.filter(
    (f) => windowDays >= f.minWindowDays,
  );
  for (const floor of floors) {
    const rows = await readGranularity(
      userId,
      type,
      floor.granularity,
      since,
      // Trailing-window semantics: no upper bound. This router serves the
      // "last N days to now" probes (summaries-slice / health-score); the
      // requested-window bounding lives on `readTieredRollupSeries`.
      null,
      priority,
    );
    if (rows && rows.length > 0) {
      return { granularity: floor.granularity, rows };
    }
  }
  return null;
}

/**
 * Linearly compose `count / min / max / mean / sum` across an array
 * of bucket rows. Mirrors `rollup-read.ts:aggregateBuckets` but
 * carries `sumValue` so cumulative-metric callers (steps, energy,
 * distance) can read the window total without re-deriving from
 * `mean * count`. SD / slope / r2 are intentionally omitted — those
 * stats do not compose across coarser buckets and the consumers that
 * need them stay on live SQL.
 */
export function aggregateWmyBuckets(
  rows: RollupBucketRow[],
  weighting: WindowWeighting = "count",
): {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
} {
  if (rows.length === 0) {
    return { count: 0, min: null, max: null, mean: null, sum: null };
  }
  let totalCount = 0;
  let sumWeighted = 0;
  let totalWeight = 0;
  let sumCumulative = 0;
  let sawSum = false;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    totalCount += row.count;
    // Each reading weighs one, or, for a type whose DAY value is the mean of
    // its hourly means (pulse), each DAY weighs one: a bucket weighs the days
    // it holds. See `aggregateBuckets` in measurement-read.ts.
    const weight =
      weighting === "day" ? (row.count > 0 ? (row.days ?? 1) : 0) : row.count;
    sumWeighted += weight * row.mean;
    totalWeight += weight;
    if (row.sumValue !== null && Number.isFinite(row.sumValue)) {
      sumCumulative += row.sumValue;
      sawSum = true;
    }
    if (row.minValue < min) min = row.minValue;
    if (row.maxValue > max) max = row.maxValue;
  }
  if (totalCount === 0 || totalWeight === 0) {
    return { count: 0, min: null, max: null, mean: null, sum: null };
  }
  return {
    count: totalCount,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    mean: sumWeighted / totalWeight,
    sum: sawSum ? sumCumulative : null,
  };
}

/**
 * Internal — one type's canonical buckets at `granularity`, built from the
 * DAY tier (`readCanonicalRollupBuckets`: canonical source per DAY, then the
 * fold). Returns `null` when the window has no rows so the caller can branch
 * on a coverage miss without a separate count round-trip.
 *
 * When `to` is supplied the window is bounded on BOTH ends (`bucketStart` in
 * `[from, to]`), so a caller asking for an arbitrary historic window reads
 * the buckets INSIDE it rather than the trailing "to now" slice, the same
 * contract the DAY-tier `readRollup` and the live-SQL fallback keep.
 * `to === null` keeps the trailing-window semantics for the
 * `readBestGranularityRollups` router.
 */
async function readGranularity(
  userId: string,
  type: MeasurementType,
  granularity: RollupGranularity,
  from: Date,
  to: Date | null,
  userPriorityJson: unknown,
): Promise<RollupBucketRow[] | null> {
  const rows = await readCanonicalRollupBuckets({
    userId,
    type,
    granularity,
    from,
    to,
    toInclusive: true,
    userPriorityJson,
  });
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    bucketStart: r.bucketStart,
    count: r.count,
    days: r.days,
    mean: r.mean,
    sd: r.sd,
    slope: r.slope,
    r2: r.r2,
    sumValue: r.sumValue,
    minValue: r.minValue,
    maxValue: r.maxValue,
  }));
}

/**
 * Wire-row shape the chart-data client consumes — mirrors
 * `DailySeriesRow` in `daily-series-read.ts` so a tier-stepped series
 * interleaves with the daily path without the caller branching on the
 * source granularity. `measuredAt` is the bucket-start ISO string at the
 * resolved tier (one row per DAY / WEEK / MONTH / YEAR bucket).
 */
export interface TieredSeriesRow {
  type: string;
  value: number;
  measuredAt: string;
  count: number;
  minValue?: number | null;
  maxValue?: number | null;
}

/**
 * Pick the rollup granularity for a chart window of `windowDays`:
 *
 *   - > 730 days  → MONTH
 *   - 366–730     → WEEK
 *   - ≤ 365       → DAY   (daily resolution; the DAY cap covers it)
 *
 * This ladder must stay COMPATIBLE with the chart's client-side
 * `pickBucket` (`src/lib/charts/bucket-time-series.ts`), which captions
 * the rendered series from the visible data span (day ≤ 90, week 91–730,
 * month > 730): for any span the tier chosen here is never COARSER than
 * the caption the client will print, so a "Wochendurchschnitt" chip
 * always sits over points the client actually folded into weeks. The
 * ladders are not identical — this one may be finer (DAY rows for a
 * 91–365 d span; the client folds them into the weeks it captions) —
 * and a test pins the never-coarser direction across every span.
 */
export function pickRollupGranularityForWindow(
  windowDays: number,
): RollupGranularity {
  if (windowDays > 730) return "MONTH";
  if (windowDays > 365) return "WEEK";
  return "DAY";
}

/**
 * A tier bucket starts at UTC midnight, and a client names a row by the
 * date its `measuredAt` falls on in the person's zone. West of UTC that
 * midnight is still the evening before, so a March bucket read as February
 * and every month of the chart's "All" range sat one month early. A row is
 * therefore stamped at noon UTC of the bucket's first day: that instant falls
 * inside the bucket's own week, month and year in every zone, and on the
 * bucket's own day from UTC−12 to UTC+11.
 */
const TIER_ROW_ANCHOR_MS = 12 * 3_600_000;

/**
 * A cumulative type's tier row as the average day of its bucket: the bucket's
 * total over the days that hold a reading. A day row is its own total, which
 * is the same quantity. The chart folds its shorter ranges from day totals
 * into the mean day of each week or month, and the live fallback serves day
 * totals too; a WEEK or MONTH row carrying its whole total put a monthly sum
 * where every other path puts a daily figure, so the "All" range read ~30
 * times higher once a history was long enough to be served monthly, under a
 * caption that said average.
 */
function dailyAverage(r: {
  sumValue: number | null;
  mean: number;
  count: number;
  days: number;
}): number {
  const total = r.sumValue ?? r.mean * r.count;
  return r.days > 1 ? total / r.days : total;
}

/**
 * A level type's tier row: the mean of its days' means. The count-weighted
 * `mean` let a day with many readings outweigh the rest, while the chart's
 * shorter ranges and the live fallback weigh each day once.
 */
function chartLevel(r: { mean: number; dayMean?: number }): number {
  return typeof r.dayMean === "number" && Number.isFinite(r.dayMean)
    ? r.dayMean
    : r.mean;
}

/** DAY → WEEK → MONTH → YEAR, finest first. */
const TIER_ORDER: RollupGranularity[] = ["DAY", "WEEK", "MONTH", "YEAR"];

/**
 * v1.19.2 — whole-history series reader for very long chart ranges.
 *
 * The DAY-only `readDailySeries` reader caps its result at
 * `BUCKET_CAP.daily` (365) buckets. A multi-year "Alle" range therefore
 * silently truncated to roughly the most recent year — the older history
 * never reached the client even though the chart's own
 * `bucketTimeSeries` downsampler would have rendered it as week / month
 * points. This reader closes that gap by reading the bucket tier that
 * matches the chart's display granularity (WEEK for 1–2 years, MONTH
 * beyond), so the returned series spans the WHOLE requested window inside
 * a sane point budget instead of being chopped to a recent slice.
 *
 * The tier is purely a downsampling choice: `count` and the
 * count-weighted `mean` compose identically across any granularity (see
 * the compositional contract above), so a 5-year window rendered as ~60
 * MONTH points carries the same trend as the ~1 800 DAY points would have
 * — minus the truncation. `minValue` / `maxValue` ride through for the
 * range band on spot metrics. The value is the average day of the bucket
 * at every tier, as the chart's own fold of day points gives it: a level's
 * days each weigh one, and a cumulative metric (steps, energy, distance)
 * carries its total over the days that hold a reading, without a spread.
 *
 * Coverage handling: the tier is chosen from the span of the window's DAY
 * buckets and read folded from them. Returns `null` when the window holds no
 * DAY buckets; the caller then falls through to its live-SQL path.
 *
 * The result is NOT capped — the tier selection bounds the row count
 * (≤ ~104 weeks for the WEEK tier, ≤ ~12 months/year for MONTH). If a
 * future tier ever risks an unbounded count it must step coarser rather
 * than truncate; no silent cap lives on this path.
 *
 * v1.26.0 SEAM-N2 — the reader is bounded to the REQUESTED `[from, to]`
 * window on BOTH ends, not a trailing "now − windowDays … now" slice.
 * The caller passes arbitrary ISO instants (a historic "All" range whose
 * `to` need not be ≈ now), so anchoring on `Date.now()` returned the wrong
 * buckets entirely. The tier SELECTION still keys off the window WIDTH
 * (`windowDays`, derived from the span) — only the window the tier READS
 * changed. This matches the DAY-tier `readRollup` + the live-SQL
 * `readLiveDaily` fallback, both of which bound on `[from, to]`.
 */
export async function readTieredRollupSeries(opts: {
  userId: string;
  type: MeasurementType;
  from: Date;
  to: Date;
  priorityJson?: unknown;
}): Promise<{
  granularity: RollupGranularity;
  rows: TieredSeriesRow[];
} | null> {
  const { userId, type, from, to, priorityJson } = opts;
  // Tier selection keys off the window WIDTH; derive it the same way the
  // caller (`daily-series-read`) does so the chosen tier is identical.
  const windowDays = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  if (!Number.isFinite(windowDays) || windowDays <= 0) return null;

  const priority =
    priorityJson !== undefined
      ? priorityJson
      : await loadUserSourcePriority(userId);

  const target = pickRollupGranularityForWindow(windowDays);
  // Refine the tier by the ACTUAL data span, not the requested window. The
  // "Alle" tab always requests ~3650 days, so keying the tier off the request
  // width alone handed EVERY account MONTH buckets: a record whose history
  // spans four months came back as four monthly means while the client
  // (which captions from the real span) labelled them "weekly average". The
  // tier is never coarser than the request calls for.
  const span = await prisma.measurementRollup.aggregate({
    where: {
      userId,
      type,
      granularity: "DAY",
      bucketStart: { gte: from, lte: to },
    },
    _min: { bucketStart: true },
    _max: { bucketStart: true },
  });
  const first = span._min.bucketStart;
  const last = span._max.bucketStart;
  if (!first || !last) return null;
  const spanDays = Math.ceil((last.getTime() - first.getTime()) / 86_400_000);
  const refined = pickRollupGranularityForWindow(Math.max(1, spanDays));
  const granularity =
    TIER_ORDER.indexOf(refined) < TIER_ORDER.indexOf(target) ? refined : target;
  const rows = await readCanonicalRollupBuckets({
    userId,
    type,
    granularity,
    from,
    to,
    toInclusive: true,
    userPriorityJson: priority,
  });
  if (rows.length === 0) return null;
  const useSum = CUMULATIVE_HK_TYPES.has(type);
  annotate({
    action: { name: "measurement.list" },
    meta: {
      total: rows.length,
      type,
      aggregate: "tiered",
      granularity,
      target_granularity: target,
      source: "rollup",
    },
  });
  return {
    granularity,
    rows: rows.map((r) => ({
      type,
      // The chart's quantity at every tier: the average day of the bucket,
      // each day weighing one, as its shorter ranges and the live fallback
      // fold it.
      value: useSum ? dailyAverage(r) : chartLevel(r),
      measuredAt: new Date(
        r.bucketStart.getTime() + TIER_ROW_ANCHOR_MS,
      ).toISOString(),
      count: r.count,
      minValue: useSum ? undefined : r.minValue,
      maxValue: useSum ? undefined : r.maxValue,
    })),
  };
}
