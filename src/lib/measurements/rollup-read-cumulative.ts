/**
 * v1.4.39 W-SUM — read helpers for cumulative-metric daily sums.
 *
 * The v1.4.36 read path consumes the rollup table for spot-metric means
 * via `rollup-read.ts`. Cumulative HK types (steps, flights, distance,
 * daylight, active-energy) need the per-day SUM rather than the MEAN —
 * every row is a partial-day slice from HealthKit, so MEAN understates
 * the daily total by the per-bucket sample count.
 *
 * The v1.4.39 schema scaffolding (migration 0072) added `sum_value` to
 * `measurement_rollups`. The writer in `rollups.ts` populates it on
 * every fold (including for non-cumulative types — the cost is one
 * extra `SUM` in the existing aggregator). The legacy-NULL backfill
 * runs through `enqueueBootTimeRollupBackfill` so existing rows
 * converge on the next worker boot.
 *
 * Callers fall back to `mean * count` when `sumValue` is null. The
 * shortcut is mathematically exact for a single source per day:
 *
 *   sum = mean × count = (Σvalue / count) × count = Σvalue
 *
 * Multiple sources for the same `(user, type, day)` mix into the same
 * bucket today — the source-priority resolution that
 * `pickCanonicalSourceRows` runs in JS happens AFTER the rollup
 * aggregate is built. The W8c per-source rollup deferred to v1.5 fixes
 * that; until then, the cumulative read paths trust the bucket sum as
 * the canonical daily total and the iOS drain (which collapses per
 * source via `dailyStatsExternalId`) keeps Marc's tenant on the
 * single-source-per-day path.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { CUMULATIVE_HK_TYPES } from "./apple-health-mapping";

/**
 * Cumulative measurement types the rollup `sum_value` column serves.
 * Re-exported from the canonical Apple Health mapping so the
 * consumer-side gate stays in one place.
 *
 * Audit anchor: `.planning/round-v1438-perf-analysis.md` §3
 * "Cumulative daily sums" + §5 P3.
 */
export type CumulativeType =
  | "ACTIVITY_STEPS"
  | "ACTIVE_ENERGY_BURNED"
  | "FLIGHTS_CLIMBED"
  | "WALKING_RUNNING_DISTANCE"
  | "TIME_IN_DAYLIGHT";

/**
 * `true` when `type` is one of the cumulative HK types whose daily
 * total the rollup `sum_value` column carries.
 */
export function isCumulativeType(type: MeasurementType): type is CumulativeType {
  return CUMULATIVE_HK_TYPES.has(type);
}

/** One DAY-bucket row read from `measurement_rollups`. */
export interface CumulativeDaySumRow {
  bucketStart: Date;
  /**
   * Per-bucket SUM. `null` only when the bucket pre-dates the v1.4.39
   * writer change AND the boot-time backfill has not yet converged on
   * this user. Callers fall back to `mean * count` for the null case.
   */
  sumValue: number | null;
  count: number;
  mean: number;
}

/**
 * Read every DAY bucket for `(userId, type)` since `since`. Returns
 * rows ascending by `bucketStart`. Pre-v1.4.39 rows surface here with
 * `sumValue = null`; the caller decides whether to fall back to
 * `mean * count` or skip them.
 *
 * Bounded to the cumulative-type set so a misuse (passing a spot
 * metric) is a type error rather than a silent SUM on the wrong
 * column. The query is a plain `findMany` against the
 * `(userId, type, granularity, bucketStart)` composite primary key —
 * single round-trip, fully indexed.
 */
export async function readCumulativeDaySums(
  userId: string,
  type: CumulativeType,
  since: Date,
): Promise<CumulativeDaySumRow[]> {
  const rows = await prisma.measurementRollup.findMany({
    where: {
      userId,
      type: type as MeasurementType,
      granularity: "DAY",
      bucketStart: { gte: since },
    },
    orderBy: { bucketStart: "asc" },
    select: {
      bucketStart: true,
      sumValue: true,
      count: true,
      mean: true,
    },
  });
  return rows.map((r) => ({
    bucketStart: r.bucketStart,
    sumValue: r.sumValue,
    count: r.count,
    mean: r.mean,
  }));
}

/**
 * Batch read DAY buckets for several cumulative types in one round
 * trip. Eliminates the per-type chunked-findMany loop in
 * `/api/analytics` A2 for the five highest-row-count metrics on
 * Marc's tenant.
 *
 * Returns a Map keyed on `MeasurementType` so the caller can route
 * each type's rows back into the per-metric branch without scanning
 * the flat list.
 */
export async function readCumulativeDaySumsBatch(
  userId: string,
  types: readonly CumulativeType[],
  since: Date,
): Promise<Map<CumulativeType, CumulativeDaySumRow[]>> {
  if (types.length === 0) return new Map();
  const rows = await prisma.measurementRollup.findMany({
    where: {
      userId,
      type: { in: types as unknown as MeasurementType[] },
      granularity: "DAY",
      bucketStart: { gte: since },
    },
    orderBy: [{ type: "asc" }, { bucketStart: "asc" }],
    select: {
      type: true,
      bucketStart: true,
      sumValue: true,
      count: true,
      mean: true,
    },
  });
  const out = new Map<CumulativeType, CumulativeDaySumRow[]>();
  for (const t of types) out.set(t, []);
  for (const row of rows) {
    const bucket = out.get(row.type as CumulativeType);
    if (!bucket) continue;
    bucket.push({
      bucketStart: row.bucketStart,
      sumValue: row.sumValue,
      count: row.count,
      mean: row.mean,
    });
  }
  return out;
}

/**
 * Resolve a per-bucket cumulative total. Reads `sumValue` when the
 * v1.4.39 writer has populated it; falls back to `mean * count` for
 * legacy NULL rows so the chart never paints a hole during the boot-
 * backfill convergence window.
 */
export function resolveBucketSum(row: CumulativeDaySumRow): number {
  if (row.sumValue !== null) return row.sumValue;
  return row.mean * row.count;
}
