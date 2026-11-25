"use client";

import { useMemo } from "react";

import {
  bucketTimeSeries,
  type ChartBucketType,
} from "@/lib/charts/bucket-time-series";
import type { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import { shiftDailySeriesForward } from "@/lib/charts/comparison-shift";
import {
  firstWindowDayUtc,
  PERIOD_END_KEY,
  PERIOD_START_KEY,
  READINGS_KEY,
} from "@/lib/charts/range-grain";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";
import type {
  ChartRangePoints,
  ComparisonBaseline,
} from "@/lib/dashboard/chart-overlay-prefs";
import { trendLineByTime } from "@/lib/stats/linear-fit";

import {
  dayKeyToTimestamp,
  movingAverageByPoints,
} from "../health-chart/series-math";

import { aggregateMoodEntries, type MoodEntryDay } from "./aggregate";
import type { ChartDataPoint } from "./plot";

/**
 * What the mood chart draws from its daily entries: the visible window at
 * the range tab's grain, with the moving average (daily points only), the
 * trend line and the prior period merged in.
 */
export function useMoodChartView({
  entries,
  rangePoints,
  profileTimeZone,
  tzFmt,
  showMA,
  showTrend,
  effectiveCompareBaseline,
}: {
  entries: MoodEntryDay[] | undefined;
  rangePoints: ChartRangePoints;
  profileTimeZone: string;
  tzFmt: ReturnType<typeof makeBucketLabelFormatters>;
  showMA: boolean;
  showTrend: boolean;
  effectiveCompareBaseline: ComparisonBaseline;
}) {
  // The visible window at its grain, once: the points, the caption chip, the
  // tooltip and the data table all read this one result.
  const visible = useMemo(() => {
    if (!entries?.length) return null;
    // A calendar-day window, not "the last N logged days":
    // the tabs promise days, and the measurement charts window by days.
    // The grain is the tab's (`pickRangeBucket`: 7 and 30 days daily, 90
    // days weekly, All by span), applied by `aggregateMoodEntries`, the
    // function the unit tests pin.
    const now = new Date().getTime();
    const cutoff = now - rangePoints * 86_400_000;
    const windowed =
      rangePoints > 0
        ? entries.filter((entry) => dayKeyToTimestamp(entry.date) >= cutoff)
        : entries;
    return {
      days: windowed.length,
      ...aggregateMoodEntries(windowed, profileTimeZone, {
        range: rangePoints,
        period: {
          firstDay: rangePoints > 0 ? firstWindowDayUtc(cutoff) : null,
          lastDay: dayKeyAsUtcMidnight(
            userDayKey(new Date(now), profileTimeZone),
          ).getTime(),
        },
      }),
    };
  }, [entries, rangePoints, profileTimeZone]);
  const activeBucket: ChartBucketType = visible?.bucket ?? "day";

  const chartData = useMemo((): ChartDataPoint[] | undefined => {
    if (!visible) return undefined;
    const visibleData: ChartDataPoint[] = visible.points.map((point) => ({
      date: tzFmt.dateShortSmart(new Date(point.timestamp)),
      timestamp: point.timestamp,
      pointIndex: 0,
      score: point.score,
      ...(point.periodStart !== undefined && point.periodEnd !== undefined
        ? {
            [PERIOD_START_KEY]: point.periodStart,
            [PERIOD_END_KEY]: point.periodEnd,
            [READINGS_KEY]: point.readings,
          }
        : {}),
    }));

    const enriched: ChartDataPoint[] = visibleData.map((d, index) => ({
      ...d,
      pointIndex: index,
    }));

    // The 7-day moving average only over daily points: over weekly means it
    // would be a seven-week average under a "7-day" label.
    if (showMA && visible.bucket === "day") {
      const scoreData = enriched.map((d) => ({
        date: new Date(d.timestamp),
        value: d.score,
      }));

      if (scoreData.length >= 2) {
        const ma = movingAverageByPoints(scoreData, 7);
        for (const point of ma) {
          const pointTimestamp = point.date.getTime();
          const existing = enriched.find((d) => d.timestamp === pointTimestamp);
          if (existing) {
            existing.ma = point.value;
          }
        }
      }
    }

    if (showTrend) {
      const scoreData = enriched.map((d) => ({
        date: new Date(d.timestamp),
        value: d.score,
      }));

      if (scoreData.length >= 2) {
        const trend = trendLineByTime(scoreData);
        if (trend) {
          for (const point of trend.points) {
            const pointTimestamp = point.date.getTime();
            const existing = enriched.find(
              (d) => d.timestamp === pointTimestamp,
            );
            if (existing) {
              existing.trend = point.value;
            }
          }
        }
      }
    }

    return enriched;
  }, [visible, showMA, showTrend, tzFmt]);

  /**
   * The comparison overlay merged into chartData.
   *
   * Same mechanic as HealthChart: shift the full mood-entries history
   * forward by 30 / 365 days, key by the existing `date` formatter, and
   * stamp the prior-period score onto each visible point as
   * `scoreCompare`. The Recharts <Line dataKey="scoreCompare" />
   * below renders the dimmed dashed overlay.
   */
  const chartDataWithCompare = useMemo<ChartDataPoint[] | undefined>(() => {
    if (!chartData || effectiveCompareBaseline === "none") return chartData;
    if (!entries?.length) return chartData;

    const shifted = shiftDailySeriesForward(
      entries.map((entry) => ({
        timestamp: dayKeyToTimestamp(entry.date),
        score: entry.score,
      })),
      effectiveCompareBaseline,
    );

    // Daily points match the shifted day; week and month points match the
    // shifted days folded into the same buckets, so a week is compared with
    // the mean of the shifted week rather than with its Monday alone.
    const priorByKey = new Map<string | number, number>();
    if (activeBucket === "day") {
      for (const row of shifted) {
        if (typeof row.score === "number" && Number.isFinite(row.score)) {
          priorByKey.set(
            tzFmt.dateShortSmart(new Date(row.timestamp)),
            row.score,
          );
        }
      }
    } else {
      const folded = bucketTimeSeries(
        shifted.map((row) => ({
          timestamp: row.timestamp,
          values: { score: row.score },
        })),
        { bucket: activeBucket, timeZone: profileTimeZone },
      );
      for (const point of folded.points) {
        priorByKey.set(point.timestamp, point.values.score);
      }
    }

    return chartData.map((point) => {
      const compareValue = priorByKey.get(
        activeBucket === "day" ? point.date : point.timestamp,
      );
      if (typeof compareValue === "number" && Number.isFinite(compareValue)) {
        return { ...point, scoreCompare: compareValue };
      }
      return point;
    });
  }, [
    chartData,
    effectiveCompareBaseline,
    entries,
    tzFmt,
    activeBucket,
    profileTimeZone,
  ]);

  const hasComparisonData = useMemo(() => {
    if (effectiveCompareBaseline === "none" || !chartDataWithCompare)
      return false;
    return chartDataWithCompare.some((point) =>
      typeof point.scoreCompare === "number"
        ? Number.isFinite(point.scoreCompare)
        : false,
    );
  }, [chartDataWithCompare, effectiveCompareBaseline]);

  return {
    visible,
    activeBucket,
    chartData,
    chartDataWithCompare,
    hasComparisonData,
  };
}
