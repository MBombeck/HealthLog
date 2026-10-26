/**
 * Per-type lookups over the summary's bounded reads: the latest reading,
 * the sparkline points and the all-time metadata of each measurement type.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import type {
  readAllTimeCounts,
  readLatestEver,
  readSparkBuckets,
} from "@/lib/dashboard/summary-reads";

export interface SummaryLookups {
  latestOf(type: MeasurementType): { value: number; at: Date } | null;
  sparkOf(type: MeasurementType): number[];
  metaForType(type: MeasurementType): {
    allTimeCount: number;
    lastSeenAt: string | null;
  };
}

export function summaryLookups(reads: {
  latestEver: Awaited<ReturnType<typeof readLatestEver>>;
  sparkBuckets: Awaited<ReturnType<typeof readSparkBuckets>>;
  allTimeAggregate: Awaited<ReturnType<typeof readAllTimeCounts>>;
}): SummaryLookups {
  const { latestEver, sparkBuckets, allTimeAggregate } = reads;
  // Per-type metadata lookup: a typed Map so a metric with no readings at
  // all falls through `metaForType` to the `{ allTimeCount: 0, lastSeenAt:
  // null }` default.
  const allTimeByType = new Map<
    MeasurementType,
    { allTimeCount: number; lastSeenAt: Date | null }
  >();
  // The newest reading is the one `latestEver` already read per type; its
  // instant is the metric's last-seen time.
  const lastSeenByType = new Map(
    latestEver.map((row) => [row.type, row.measured_at]),
  );
  for (const row of allTimeAggregate) {
    allTimeByType.set(row.type, {
      allTimeCount: row.count,
      lastSeenAt: lastSeenByType.get(row.type) ?? null,
    });
  }

  // Per-type latest (one row per type), carrying the most recent reading
  // regardless of age: the iOS tile shows the historical value plus a muted
  // "last reading N days ago" caption rather than nothing at all.
  const latestByType = new Map<MeasurementType, { value: number; at: Date }>();
  for (const row of latestEver) {
    latestByType.set(row.type, {
      value: Number(row.value),
      at: new Date(row.measured_at),
    });
  }
  // Cumulative tiles paint the daily SUM; spot tiles keep the daily MEAN.
  // Reading `sum_value` directly off the rollup row avoids a `mean * count`
  // reconstruction; the fallback covers rollup rows written before the sum
  // column existed, during the boot-backfill convergence window.
  const sparkByType = new Map<MeasurementType, number[]>();
  for (const row of sparkBuckets) {
    const list = sparkByType.get(row.type) ?? [];
    const cumulativePoint =
      row.sum_value !== null
        ? Number(row.sum_value)
        : Number(row.mean) * Number(row.count);
    const point = CUMULATIVE_HK_TYPES.has(row.type)
      ? cumulativePoint
      : Number(row.mean);
    list.push(point);
    sparkByType.set(row.type, list);
  }

  return {
    latestOf: (type) => latestByType.get(type) ?? null,
    sparkOf: (type) => sparkByType.get(type) ?? [],
    metaForType: (type) => {
      const slot = allTimeByType.get(type);
      return {
        allTimeCount: slot?.allTimeCount ?? 0,
        lastSeenAt: slot?.lastSeenAt?.toISOString() ?? null,
      };
    },
  };
}
