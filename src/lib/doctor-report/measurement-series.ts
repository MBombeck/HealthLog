/**
 * Per-type measurement series and their summary statistics.
 *
 * Folds the pre-aggregated dense buckets down to the same shape the raw-row
 * path produces — one entry per local day per type, plus per-type and
 * per-glucose-context stats — so the rest of the aggregator never has to know
 * which path a type came down.
 *
 * Split out of the aggregator with the selection rework.
 */
import { collapseMeasurementsToCanonical } from "@/lib/doctor-report-helpers";
import { glucoseContextBucket } from "@/lib/glucose";
import type { DoctorReportStats } from "@/lib/doctor-report-types";
import type { GlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DenseMeasurementBucket } from "./dense-buckets";
import { glucoseClinicalFromBuckets } from "./glucose-panel";

export interface DenseMeasurementSummary {
  byType: Record<string, Array<{ value: number; measuredAt: string }>>;
  stats: Record<string, DoctorReportStats>;
  glucoseStats: Record<string, DoctorReportStats>;
  glucoseClinical: GlucoseClinicalMetrics;
}

interface DenseStatsAccumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
  latestAt: Date;
  latest: number;
}

export function summariseDenseBuckets(
  rows: readonly DenseMeasurementBucket[],
  timezone: string,
  sourcePriorityJson: unknown,
  windowDays: number,
): DenseMeasurementSummary {
  const canonical = collapseMeasurementsToCanonical(
    rows.map((row) => ({
      ...row,
      value: row.sumValue / row.count,
      measuredAt: row.bucketStart,
    })),
    timezone,
    sourcePriorityJson,
  );
  const byType: DenseMeasurementSummary["byType"] = {};
  const statsAcc = new Map<string, DenseStatsAccumulator>();
  const glucoseStatsAcc = new Map<string, DenseStatsAccumulator>();

  const byTypeDay = new Map<
    string,
    {
      type: string;
      bucketStart: Date;
      count: number;
      sum: number;
      min: number;
      max: number;
      latestAt: Date;
      latest: number;
    }
  >();
  for (const row of canonical) {
    const key = `${row.type}:${row.bucketStart.toISOString()}`;
    const current = byTypeDay.get(key);
    if (!current) {
      byTypeDay.set(key, {
        type: row.type,
        bucketStart: row.bucketStart,
        count: row.count,
        sum: row.sumValue,
        min: row.minValue,
        max: row.maxValue,
        latestAt: row.latestAt,
        latest: row.latestValue,
      });
      continue;
    }
    current.count += row.count;
    current.sum += row.sumValue;
    current.min = Math.min(current.min, row.minValue);
    current.max = Math.max(current.max, row.maxValue);
    if (row.latestAt > current.latestAt) {
      current.latestAt = row.latestAt;
      current.latest = row.latestValue;
    }
  }

  const accumulate = (
    target: Map<string, DenseStatsAccumulator>,
    key: string,
    row: DenseStatsAccumulator,
  ) => {
    const current = target.get(key);
    if (!current) {
      target.set(key, { ...row });
      return;
    }
    current.count += row.count;
    current.sum += row.sum;
    current.min = Math.min(current.min, row.min);
    current.max = Math.max(current.max, row.max);
    if (row.latestAt > current.latestAt) {
      current.latestAt = row.latestAt;
      current.latest = row.latest;
    }
  };

  for (const row of byTypeDay.values()) {
    (byType[row.type] ??= []).push({
      value: row.sum / row.count,
      measuredAt: row.bucketStart.toISOString(),
    });
    accumulate(statsAcc, row.type, row);
  }

  for (const row of canonical) {
    if (row.type !== "BLOOD_GLUCOSE") continue;
    // #943 — a reading with no meal-time context is filed under the shared
    // untagged bucket. Skipping it here dropped the whole panel for an
    // account whose meter never records one.
    accumulate(glucoseStatsAcc, glucoseContextBucket(row.glucoseContext), {
      count: row.count,
      sum: row.sumValue,
      min: row.minValue,
      max: row.maxValue,
      latestAt: row.latestAt,
      latest: row.latestValue,
    });
  }

  for (const entries of Object.values(byType)) {
    entries.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  }
  const stats: DenseMeasurementSummary["stats"] = {};
  for (const [key, value] of statsAcc) {
    stats[key] = {
      count: value.count,
      avg: value.sum / value.count,
      min: value.min,
      max: value.max,
      latest: value.latest,
    };
  }
  const glucoseStats: DenseMeasurementSummary["glucoseStats"] = {};
  for (const [key, value] of glucoseStatsAcc) {
    glucoseStats[key] = {
      count: value.count,
      avg: value.sum / value.count,
      min: value.min,
      max: value.max,
      latest: value.latest,
    };
  }

  return {
    byType,
    stats,
    glucoseStats,
    glucoseClinical: glucoseClinicalFromBuckets(canonical, windowDays),
  };
}
