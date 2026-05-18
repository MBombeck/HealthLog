/**
 * v1.4.39 W-WMY — WEEK / MONTH / YEAR rollup readers.
 *
 * Background — the read-side gap
 * ------------------------------
 * Every measurement write fans out via `recomputeBucketsForMeasurement`
 * into a synchronous DAY upsert plus pg-boss-queued WEEK / MONTH / YEAR
 * recomputes. The boot-time backfill (`enqueueBootTimeRollupBackfill`)
 * mints the full WEEK / MONTH / YEAR history once per uncovered user.
 *
 * As of v1.4.38 the only reader that consults `measurement_rollups`
 * (`rollup-read.ts`, plus the per-fast-path branches in
 * `summaries-slice`, `comprehensive-aggregator`, etc.) caps at DAY and
 * a trailing 90-day window. The WEEK / MONTH / YEAR buckets sit in
 * Postgres as pure write amplification — populated every write,
 * surfaced nowhere on read. The v1.4.38 perf audit
 * (`.planning/round-v1438-perf-analysis.md` §2 + §5 P6) calls this out
 * as the largest unused investment in the rollup tier.
 *
 * What this module adds
 * ---------------------
 * Helpers that read the trailing N-bucket window for a single
 * `(userId, type)` pair at a chosen granularity, plus an auto-router
 * that picks the largest granularity that still resolves the requested
 * window. The shape returned is identical to `readRollupBuckets` so
 * callers can interleave WEEK / MONTH / YEAR rows with DAY rows
 * downstream without branching on the source granularity.
 *
 * Compositional contract
 * ----------------------
 * `count / min / max / mean / sumValue` are linearly composable across
 * any granularity — aggregating these stats over WEEK buckets returns
 * the same numbers as aggregating the underlying DAY buckets or the
 * raw measurements. `sd / slope / r2` are NOT linearly composable; the
 * routed callers either fall back to live SQL for those or accept the
 * per-bucket stat as-is. The auto-router is a granularity selector
 * only — it does not attempt to reconstruct slope across coarser
 * buckets.
 *
 * Coverage-miss semantics
 * -----------------------
 * Each reader returns `null` when the requested granularity yields
 * zero rows for `(userId, type, since)`. The caller decides whether
 * that is a real "no data" case (the user has not logged this type in
 * the window) or a coverage miss the boot-backfill / worker has not
 * caught up on. The default policy is to fall back to a finer
 * granularity (MONTH → WEEK → DAY) before giving up — see
 * `readBestGranularityRollups`.
 *
 * Scope vs. `rollup-read.ts`
 * --------------------------
 * `rollup-read.ts` carries the existing DAY-only aggregator. This
 * module is deliberately separate so the WEEK / MONTH / YEAR wiring
 * is reviewable in isolation and so the v1.4.39 W-SUM agent's
 * concurrent edits to the writer side don't collide with the reader
 * additions.
 */
import type {
  MeasurementType,
  RollupGranularity,
} from "@/generated/prisma/client";

import { prisma } from "@/lib/db";

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
 * Read the trailing WEEK buckets for `(userId, type)` since `since`.
 * Returns `null` when no buckets exist in the window — the caller
 * decides whether to fall back to a finer granularity or to live SQL.
 */
export async function readWeekRollups(
  userId: string,
  type: MeasurementType,
  since: Date,
): Promise<RollupBucketRow[] | null> {
  return readGranularity(userId, type, "WEEK", since);
}

/**
 * Read the trailing MONTH buckets for `(userId, type)` since `since`.
 * Returns `null` on coverage miss.
 */
export async function readMonthRollups(
  userId: string,
  type: MeasurementType,
  since: Date,
): Promise<RollupBucketRow[] | null> {
  return readGranularity(userId, type, "MONTH", since);
}

/**
 * Read the trailing YEAR buckets for `(userId, type)` since `since`.
 * Returns `null` on coverage miss.
 */
export async function readYearRollups(
  userId: string,
  type: MeasurementType,
  since: Date,
): Promise<RollupBucketRow[] | null> {
  return readGranularity(userId, type, "YEAR", since);
}

/**
 * Pick the largest granularity that can still resolve the requested
 * `windowDays` window — WEEK for >14 d, MONTH for >62 d, YEAR for
 * >730 d. Falls back to a finer granularity on coverage miss so a
 * user with WEEK / MONTH coverage but no YEAR buckets (e.g. a tenant
 * who joined less than two years ago) still gets a usable trend
 * series.
 *
 * Returns the granularity the helper resolved against plus the row
 * shape `readWeekRollups` / `readMonthRollups` / `readYearRollups`
 * return. `null` when no granularity yields any buckets in the
 * window — the caller is expected to short-circuit to "no data" or
 * to live SQL.
 */
export async function readBestGranularityRollups(
  userId: string,
  type: MeasurementType,
  windowDays: number,
): Promise<{
  granularity: RollupGranularity;
  rows: RollupBucketRow[];
} | null> {
  if (!Number.isFinite(windowDays) || windowDays <= 0) return null;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  // Walk the floors from coarsest to finest and return the first
  // granularity whose floor the window clears AND which has coverage
  // for `(userId, type, since)`. The `if rows == null` fall-through
  // is what makes the helper resilient to partial coverage.
  for (const floor of GRANULARITY_FLOORS) {
    if (windowDays < floor.minWindowDays) continue;
    const rows = await readGranularity(userId, type, floor.granularity, since);
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
export function aggregateWmyBuckets(rows: RollupBucketRow[]): {
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
  let sumCumulative = 0;
  let sawSum = false;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    totalCount += row.count;
    sumWeighted += row.count * row.mean;
    if (row.sumValue !== null && Number.isFinite(row.sumValue)) {
      sumCumulative += row.sumValue;
      sawSum = true;
    }
    if (row.minValue < min) min = row.minValue;
    if (row.maxValue > max) max = row.maxValue;
  }
  if (totalCount === 0) {
    return { count: 0, min: null, max: null, mean: null, sum: null };
  }
  return {
    count: totalCount,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    mean: sumWeighted / totalCount,
    sum: sawSum ? sumCumulative : null,
  };
}

/**
 * Internal — shared `findMany` projection. Returns `null` when the
 * window has zero rows so the caller can branch on coverage miss
 * without a separate count round-trip.
 */
async function readGranularity(
  userId: string,
  type: MeasurementType,
  granularity: RollupGranularity,
  since: Date,
): Promise<RollupBucketRow[] | null> {
  // Bounded `findMany`: `(userId, type, granularity, bucketStart)`
  // is the composite primary key so the planner picks the index path
  // every time. `bucketStart >= since` is the same shape
  // `readRollupBuckets` uses; we don't carry an upper bound because
  // the helpers are always reading "trailing window to now".
  const rows = await prisma.measurementRollup.findMany({
    where: {
      userId,
      type,
      granularity,
      bucketStart: { gte: since },
    },
    orderBy: { bucketStart: "asc" },
    select: {
      bucketStart: true,
      count: true,
      mean: true,
      sd: true,
      slope: true,
      r2: true,
      sumValue: true,
      minValue: true,
      maxValue: true,
    },
  });
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    bucketStart: r.bucketStart,
    count: r.count,
    mean: r.mean,
    sd: r.sd,
    slope: r.slope,
    r2: r.r2,
    sumValue: r.sumValue,
    minValue: r.minValue,
    maxValue: r.maxValue,
  }));
}
