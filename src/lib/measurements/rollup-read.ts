/**
 * v1.5.0 — read-side helpers that aggregate the persistent rollup
 * table into the same `DataSummary` shape the live aggregator
 * returns. The reader-side surfaces (`summaries-slice`,
 * `comprehensive-aggregator`, the analytics route) call
 * `readDataSummariesFromRollups` before falling through to live SQL;
 * on rollup miss / stale they call `recomputeUserRollups` once to
 * persist the buckets, then re-read.
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
import type { MeasurementType } from "@/generated/prisma/client";
import { readRollupBuckets } from "@/lib/rollups/measurement-rollups";

export interface DailyMeanRow {
  day: Date;
  count: number;
  mean: number;
  minValue: number;
  maxValue: number;
}

/**
 * Read the trailing DAY buckets for `(userId, type)` over `[from, to)`
 * and return them as a normalised list.
 */
export async function readDailyMeans(
  userId: string,
  type: MeasurementType,
  from: Date,
  to: Date,
): Promise<DailyMeanRow[]> {
  const rows = await readRollupBuckets(userId, type, "DAY", from, to);
  return rows.map((r) => ({
    day: r.bucketStart,
    count: r.count,
    mean: r.mean,
    minValue: r.minValue,
    maxValue: r.maxValue,
  }));
}

/**
 * Combine DAY buckets into the linearly-composable window stats —
 * `count`, `min`, `max`, `mean`. SD / slope / R² are intentionally
 * NOT computed here because they don't compose across DAY rollups.
 */
export function aggregateBuckets(rows: DailyMeanRow[]): {
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
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    totalCount += r.count;
    sumWeighted += r.count * r.mean;
    if (r.minValue < min) min = r.minValue;
    if (r.maxValue > max) max = r.maxValue;
  }
  if (totalCount === 0) {
    return { count: 0, min: null, max: null, mean: null };
  }
  return {
    count: totalCount,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    mean: sumWeighted / totalCount,
  };
}
