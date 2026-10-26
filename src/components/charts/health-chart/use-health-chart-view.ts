"use client";

import { useEffect, useMemo } from "react";

import { bucketCaptionKey } from "@/lib/charts/bucket-caption";
import type { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import {
  bucketTimeSeries,
  pickBucket,
  type ChartBucketType,
} from "@/lib/charts/bucket-time-series";
import { shiftDailySeriesForward } from "@/lib/charts/comparison-shift";
import {
  computeWindowStats,
  type MetricWindowStats,
} from "@/lib/charts/window-stats";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";
import { computePaddedYDomain, niceYAxis } from "@/lib/insights/chart-y-domain";
import { trendLineByTime } from "@/lib/stats/linear-fit";

import { movingAverageByPoints } from "./series-math";
import type { ChartDataPoint } from "./types";

/**
 * The visible slice at its grain, indexed for the x axis, with the 7-day
 * moving average and the trend line stamped on as `${type}_ma` and
 * `${type}_trend` when those overlays are on.
 */
function bucketVisibleSeries(
  {
    sliced,
    bucketType,
  }: { sliced: ChartDataPoint[]; bucketType: ChartBucketType },
  {
    types,
    userTimezone,
    tzFmt,
    showMA,
    showTrend,
  }: {
    types: string[];
    userTimezone: string;
    tzFmt: ReturnType<typeof makeBucketLabelFormatters>;
    showMA: boolean;
    showTrend: boolean;
  },
): ChartDataPoint[] {
  const bucketed =
    bucketType === "day"
      ? sliced
      : bucketTimeSeries(
          sliced.map((p) => ({
            timestamp: p.timestamp,
            values: Object.fromEntries(
              types.map((type) => [type, p[type] as number | undefined]),
            ),
          })),
          { bucket: bucketType, timeZone: userTimezone },
        ).points.map<ChartDataPoint>((point) => {
          const date = new Date(point.timestamp);
          const out: ChartDataPoint = {
            date: tzFmt.dateShortSmart(date),
            timestamp: point.timestamp,
          };
          for (const [type, value] of Object.entries(point.values)) {
            out[type] = value;
          }
          return out;
        });

  const enriched: ChartDataPoint[] = bucketed.map((d, index) => ({
    ...d,
    pointIndex: index,
  }));

  if (showMA) {
    for (const type of types) {
      const typeData = enriched
        .filter((d) => d[type] !== undefined)
        .map((d) => ({
          date: new Date(d.timestamp),
          value: d[type] as number,
        }));

      if (typeData.length >= 2) {
        const ma = movingAverageByPoints(typeData, 7);
        for (const point of ma) {
          const pointTimestamp = point.date.getTime();
          const existing = enriched.find((d) => d.timestamp === pointTimestamp);
          if (existing) {
            existing[`${type}_ma`] = point.value;
          }
        }
      }
    }
  }

  if (showTrend) {
    for (const type of types) {
      const typeData = enriched
        .filter((d) => d[type] !== undefined)
        .map((d) => ({
          date: new Date(d.timestamp),
          value: d[type] as number,
        }));

      if (typeData.length >= 2) {
        const trend = trendLineByTime(typeData);
        if (trend) {
          for (const point of trend.points) {
            const pointTimestamp = point.date.getTime();
            const existing = enriched.find(
              (d) => d.timestamp === pointTimestamp,
            );
            if (existing) {
              existing[`${type}_trend`] = point.value;
            }
          }
        }
      }
    }
  }

  return enriched;
}

/**
 * The prior period stamped onto the visible points as `${type}_compare`: the
 * fetched daily series shifted forward by 30 / 365 days, matched on the same
 * day key the chart uses. A prior point paints only where its shifted day is
 * a visible day.
 */
function mergePriorPeriod(
  chartData: ChartDataPoint[],
  data: ChartDataPoint[],
  {
    types,
    tzFmt,
    baseline,
  }: {
    types: string[];
    tzFmt: ReturnType<typeof makeBucketLabelFormatters>;
    baseline: Exclude<ComparisonBaseline, "none">;
  },
): ChartDataPoint[] {
  const shifted = shiftDailySeriesForward(
    data.map((row) => ({
      timestamp: row.timestamp,
      values: Object.fromEntries(
        types.map((type) => [type, row[type] as number | undefined]),
      ),
    })),
    baseline,
  );

  // Indexed by the same day key the chart already uses.
  const shiftedByDay = new Map<string, Record<string, number>>();
  for (const row of shifted) {
    const dayKey = tzFmt.dateShortSmart(new Date(row.timestamp));
    const slot = shiftedByDay.get(dayKey) ?? {};
    for (const [type, value] of Object.entries(row.values)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        slot[type] = value;
      }
    }
    shiftedByDay.set(dayKey, slot);
  }

  return chartData.map((point) => {
    const compareValues = shiftedByDay.get(point.date);
    if (!compareValues) return point;
    const merged: ChartDataPoint = { ...point };
    for (const type of types) {
      const v = compareValues[type];
      if (typeof v === "number" && Number.isFinite(v)) {
        merged[`${type}_compare`] = v;
      }
    }
    return merged;
  });
}

/**
 * What the chart draws from its daily series: the visible window, bucketed
 * to day, week or month, with the moving average, the trend line and the
 * prior-period overlay merged in, and the y domain that fits all of it.
 */
export function useHealthChartView({
  data,
  rangePoints,
  types,
  userTimezone,
  tzFmt,
  showMA,
  showTrend,
  effectiveCompareBaseline,
  mini,
  isLoading,
  isError,
  onVisibleStats,
}: {
  data: ChartDataPoint[] | undefined;
  rangePoints: number;
  types: string[];
  userTimezone: string;
  tzFmt: ReturnType<typeof makeBucketLabelFormatters>;
  showMA: boolean;
  showTrend: boolean;
  effectiveCompareBaseline: ComparisonBaseline;
  mini: boolean;
  isLoading: boolean;
  isError: boolean;
  onVisibleStats?: (stats: Record<string, MetricWindowStats> | null) => void;
}) {
  // The grain (day / week / month) is picked from the VISIBLE range, so a
  // 30-day tab stays daily on a five-year-old account, and it has ONE source:
  // the points, the caption chip and the data table all read it. The slice
  // is a calendar-day window, as the range tabs promise and the fetch
  // requests, on the self-fetched and the batched path alike.
  const visibleSlice = useMemo(() => {
    if (!data?.length) return null;
    const cutoff = new Date().getTime() - rangePoints * 86_400_000;
    const sliced =
      rangePoints > 0
        ? data.filter((point) => point.timestamp >= cutoff)
        : [...data];
    // An empty window stays an empty slice ("no data in this range");
    // returning null would quietly widen the window to the whole series.
    const rangeDays =
      sliced.length < 2
        ? 0
        : Math.round(
            (sliced[sliced.length - 1].timestamp - sliced[0].timestamp) /
              (24 * 60 * 60 * 1000),
          );
    return { sliced, bucketType: pickBucket(rangeDays) };
  }, [data, rangePoints]);

  const chartData = useMemo(() => {
    if (!data?.length || !visibleSlice) return data;
    return bucketVisibleSeries(visibleSlice, {
      types,
      userTimezone,
      tzFmt,
      showMA,
      showTrend,
    });
  }, [data, visibleSlice, showMA, showTrend, types, tzFmt, userTimezone]);

  // Min / max / median / mean of what is visible under the active range tab,
  // for the stat strip a sub-page lifts the callback into. Mini mode has no
  // stat strip.
  const visibleStatsByType = useMemo<Record<
    string,
    MetricWindowStats
  > | null>(() => {
    if (mini || !chartData?.length) return null;
    const out: Record<string, MetricWindowStats> = {};
    for (const type of types) {
      const stats = computeWindowStats(
        chartData.map((point) => point[type] as number | undefined),
      );
      if (stats.count > 0) out[type] = stats;
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [mini, chartData, types]);

  // An effect, so the parent's state update never runs during this render,
  // and only once the read settled: a report during the first fetch would
  // tell the strip "no window" and it would paint the full-range summary
  // first. A failed read settles too, so the strip never waits forever.
  useEffect(() => {
    if (mini || isLoading) return;
    onVisibleStats?.(isError ? null : visibleStatsByType);
  }, [mini, isLoading, isError, visibleStatsByType, onVisibleStats]);

  // The prior period, from the already-fetched daily series shifted forward
  // by 30 / 365 days, stamped onto the visible points under `${type}_compare`.
  // A prior point paints only where its shifted day is a visible day.
  const chartDataWithCompare = useMemo(() => {
    if (!chartData || effectiveCompareBaseline === "none") return chartData;
    if (!data?.length) return chartData;
    return mergePriorPeriod(chartData, data, {
      types,
      tzFmt,
      baseline: effectiveCompareBaseline,
    });
  }, [chartData, effectiveCompareBaseline, data, types, tzFmt]);

  // True when at least one visible day has a prior value. A partial overlay
  // counts as available, so the "comparison unavailable" caption never sits
  // beside dimmed history the reader can see.
  const hasComparisonData = useMemo(() => {
    if (effectiveCompareBaseline === "none" || !chartDataWithCompare)
      return false;
    return chartDataWithCompare.some((point) =>
      types.some(
        (type) =>
          typeof point[`${type}_compare`] === "number" &&
          Number.isFinite(point[`${type}_compare`] as number),
      ),
    );
  }, [chartDataWithCompare, effectiveCompareBaseline, types]);

  const activeBucket: ChartBucketType = visibleSlice?.bucketType ?? "day";
  // What a folded point is: the average day of its week or month (a daily
  // total's average for steps and the like), named on the caption chip and
  // in the tooltip.
  const bucketCaption = bucketCaptionKey(activeBucket, types);

  const yAxis = useMemo<
    { domain: [number, number]; ticks: number[] } | undefined
  >(() => {
    if (!chartDataWithCompare?.length) return undefined;

    const keys = [...types];
    if (showMA) keys.push(...types.map((type) => `${type}_ma`));
    if (showTrend) keys.push(...types.map((type) => `${type}_trend`));
    // The prior period may sit on a different scale; without it the dimmed
    // line clips outside the plot.
    if (effectiveCompareBaseline !== "none") {
      keys.push(...types.map((type) => `${type}_compare`));
    }

    const values = chartDataWithCompare
      .flatMap((point) => keys.map((key) => point[key]))
      .filter((value): value is number => typeof value === "number")
      .filter((value) => Number.isFinite(value));

    const padded = computePaddedYDomain(values, types);
    return padded ? niceYAxis(padded) : undefined;
  }, [
    chartDataWithCompare,
    effectiveCompareBaseline,
    showMA,
    showTrend,
    types,
  ]);

  return {
    visibleSlice,
    chartData,
    visibleStatsByType,
    chartDataWithCompare,
    hasComparisonData,
    activeBucket,
    bucketCaption,
    yDomain: yAxis?.domain,
    yTicks: yAxis?.ticks,
  };
}
