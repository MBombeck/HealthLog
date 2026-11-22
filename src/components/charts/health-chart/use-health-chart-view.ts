"use client";

import { useEffect, useMemo } from "react";

import { bucketCaptionKey } from "@/lib/charts/bucket-caption";
import type { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import {
  bucketTimeSeries,
  type ChartBucketType,
} from "@/lib/charts/bucket-time-series";
import {
  bucketPeriod,
  firstWindowDayUtc,
  PERIOD_END_KEY,
  PERIOD_START_KEY,
  pickRangeBucket,
  READINGS_KEY,
} from "@/lib/charts/range-grain";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";
import { shiftDailySeriesForward } from "@/lib/charts/comparison-shift";
import {
  computeWindowStats,
  type MetricWindowStats,
} from "@/lib/charts/window-stats";
import type {
  ChartRangePoints,
  ComparisonBaseline,
} from "@/lib/dashboard-layout";
import { computePaddedYDomain, niceYAxis } from "@/lib/insights/chart-y-domain";
import { trendLineByTime } from "@/lib/stats/linear-fit";

import { movingAverageByPoints, readingsKey } from "./series-math";
import type { ChartDataPoint } from "./types";

/** The visible window at its grain, as `useHealthChartView` derives it. */
interface VisibleSlice {
  /** The daily points inside the window. */
  sliced: ChartDataPoint[];
  bucketType: ChartBucketType;
  /** The window's first and last day, for clipping a week or month. */
  period: { firstDay: number | null; lastDay: number };
}

/**
 * The visible slice at its grain, indexed for the x axis, with the 7-day
 * moving average and the trend line stamped on as `${type}_ma` and
 * `${type}_trend` when those overlays are on.
 *
 * A week or month point is the mean of its days, with the spread of its days
 * as the range band, the summed reading count, and the days it covers inside
 * the window, so the tooltip and the table can name a week still running as
 * the shorter stretch it is. The 7-day moving average is drawn on daily
 * points only: over weekly means it would be a seven-week average under a
 * "7-day" label, and over monthly means a seven-month one.
 */
function bucketVisibleSeries(
  { sliced, bucketType, period }: VisibleSlice,
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
              types.flatMap((type) => {
                const range = p[`${type}__range`];
                const readings = p[readingsKey(type)];
                return [
                  [type, p[type] as number | undefined],
                  [readingsKey(type), readings as number | undefined],
                  ...(Array.isArray(range)
                    ? [
                        [`${type}__lo`, range[0]],
                        [`${type}__hi`, range[1]],
                      ]
                    : []),
                ];
              }),
            ),
          })),
          { bucket: bucketType, timeZone: userTimezone },
        ).points.flatMap<ChartDataPoint>((point) => {
          const date = new Date(point.timestamp);
          const covered = bucketPeriod(point.timestamp, bucketType, period);
          const out: ChartDataPoint = {
            date: tzFmt.dateShortSmart(date),
            timestamp: point.timestamp,
            [PERIOD_START_KEY]: covered.start,
            [PERIOD_END_KEY]: covered.end,
          };
          let readings = 0;
          for (const type of types) {
            const value = point.values[type];
            if (value === undefined) continue;
            out[type] = value;
            const lo = point.mins[`${type}__lo`];
            const hi = point.maxs[`${type}__hi`];
            if (lo !== undefined && hi !== undefined) {
              out[`${type}__range`] = [lo, hi];
            }
            readings = Math.max(
              readings,
              point.sums[readingsKey(type)] ?? point.counts[type] ?? 0,
            );
          }
          if (types.every((type) => out[type] === undefined)) return [];
          out[READINGS_KEY] = readings;
          return [out];
        });

  const enriched: ChartDataPoint[] = bucketed.map((d, index) => ({
    ...d,
    pointIndex: index,
  }));

  if (showMA && bucketType === "day") {
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
 * fetched daily series shifted forward by 30 / 365 days. On daily points a
 * prior point paints only where its shifted day is a visible day. On week or
 * month points the shifted days fold into the same buckets first, so a week
 * is compared with the mean of the shifted week, not with its Monday alone.
 */
function mergePriorPeriod(
  chartData: ChartDataPoint[],
  data: ChartDataPoint[],
  {
    types,
    tzFmt,
    baseline,
    bucketType,
    userTimezone,
  }: {
    types: string[];
    tzFmt: ReturnType<typeof makeBucketLabelFormatters>;
    baseline: Exclude<ComparisonBaseline, "none">;
    bucketType: ChartBucketType;
    userTimezone: string;
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

  // Keyed by what identifies a visible point: its day label on daily
  // points, its bucket start on week and month points.
  const priorByKey = new Map<string | number, Record<string, number>>();
  const rows =
    bucketType === "day"
      ? shifted.map((row) => ({
          key: tzFmt.dateShortSmart(new Date(row.timestamp)) as string | number,
          values: row.values,
        }))
      : bucketTimeSeries(shifted, {
          bucket: bucketType,
          timeZone: userTimezone,
        }).points.map((point) => ({
          key: point.timestamp as string | number,
          values: point.values as Record<string, number | undefined>,
        }));
  for (const row of rows) {
    const slot = priorByKey.get(row.key) ?? {};
    for (const [type, value] of Object.entries(row.values)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        slot[type] = value;
      }
    }
    priorByKey.set(row.key, slot);
  }

  return chartData.map((point) => {
    const compareValues = priorByKey.get(
      bucketType === "day" ? point.date : point.timestamp,
    );
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
  rangePoints: ChartRangePoints;
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
  // The grain (day / week / month) is the range tab's (`pickRangeBucket`):
  // 7 and 30 days daily, 90 days weekly, All by the span of the data. It has
  // ONE source: the points, the caption chip, the tooltip and the data table
  // all read it. The slice
  // is a calendar-day window, as the range tabs promise and the fetch
  // requests, on the self-fetched and the batched path alike.
  const visibleSlice = useMemo<VisibleSlice | null>(() => {
    if (!data?.length) return null;
    const now = new Date().getTime();
    const cutoff = now - rangePoints * 86_400_000;
    const sliced =
      rangePoints > 0
        ? data.filter((point) => point.timestamp >= cutoff)
        : [...data];
    // An empty window stays an empty slice ("no data in this range");
    // returning null would quietly widen the window to the whole series.
    return {
      sliced,
      bucketType: pickRangeBucket(
        rangePoints,
        sliced.map((point) => point.timestamp),
      ),
      period: {
        firstDay: rangePoints > 0 ? firstWindowDayUtc(cutoff) : null,
        lastDay: dayKeyAsUtcMidnight(
          userDayKey(new Date(now), userTimezone),
        ).getTime(),
      },
    };
  }, [data, rangePoints, userTimezone]);

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

  // Min / max / median / mean of the days under the active range tab, for
  // the stat strip a sub-page lifts the callback into. Read from the daily
  // slice, not from the drawn points, so the strip does not change meaning
  // with the grain: on the 90-day tab "Min" is still the lowest day, not the
  // lowest weekly mean. Mini mode has no stat strip.
  const visibleStatsByType = useMemo<Record<
    string,
    MetricWindowStats
  > | null>(() => {
    if (mini || !chartData?.length || !visibleSlice) return null;
    const out: Record<string, MetricWindowStats> = {};
    for (const type of types) {
      const stats = computeWindowStats(
        visibleSlice.sliced.map((point) => point[type] as number | undefined),
      );
      if (stats.count > 0) out[type] = stats;
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [mini, chartData, visibleSlice, types]);

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
      bucketType: visibleSlice?.bucketType ?? "day",
      userTimezone,
    });
  }, [
    chartData,
    effectiveCompareBaseline,
    data,
    types,
    tzFmt,
    visibleSlice,
    userTimezone,
  ]);

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
  // The 7-day average is a daily overlay: over weekly or monthly means it
  // would be a seven-week or seven-month average under a "7-day" label, so
  // it is drawn on daily points only and leaves no legend entry behind.
  const drawMA = showMA && activeBucket === "day";

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
    drawMA,
    yDomain: yAxis?.domain,
    yTicks: yAxis?.ticks,
  };
}
