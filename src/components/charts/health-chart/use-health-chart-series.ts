"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { chartSeriesParams } from "@/components/charts/chart-series-request";
import type { MeasurementType } from "@/generated/prisma/client";
import { apiGet } from "@/lib/api/api-fetch";
import type { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import { shouldFireDataReady } from "@/lib/charts/data-ready-latch";
import {
  localDayKeyFor,
  openEndedFetchWindow,
} from "@/lib/charts/fetch-window";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { queryKeys } from "@/lib/query-keys";

import { rangeWindowDays } from "../chart-range-tabs";

import { dayKeyToTimestamp, toDayKey } from "./series-math";
import type { ChartDataPoint, MeasurementApiRow } from "./types";

type BucketValues = Record<
  string,
  {
    sum: number;
    count: number;
    // The bucket's spread for the range band, from the rollup's min / max
    // columns; null when the row carries none (raw rows, cumulative metric).
    min: number | null;
    max: number | null;
  }
>;

/**
 * One read of the chart's series, folded to one point per profile-zone day.
 * Every value passes the display scale once, here; cumulative types add up
 * within a day and the rest average; the rollup's min / max become the range
 * band's tuple.
 */
async function readDailySeries({
  types,
  fetchWindow,
  usePreloaded,
  preloadedSeries,
  valueScale,
  valueOffset,
  dayKeyFormatter,
  tzFmt,
}: {
  types: string[];
  fetchWindow: ReturnType<typeof openEndedFetchWindow>;
  usePreloaded: boolean;
  preloadedSeries?: Record<string, MeasurementApiRow[]>;
  valueScale: number;
  valueOffset: number;
  dayKeyFormatter: Intl.DateTimeFormat;
  tzFmt: ReturnType<typeof makeBucketLabelFormatters>;
}): Promise<ChartDataPoint[]> {
  const dailyAggregates = new Map<
    string,
    { timestamp: number; values: BucketValues }
  >();

  // SLEEP_DURATION is stored one row per stage per night. The series
  // adapter reconstructs ONE point per night carrying the night's time
  // asleep in hours (core + deep + REM, bare asleep only without a
  // granular stage, in bed and awake excluded, dual-source nights
  // collapsed), so every sleep surface shares one reconstruction.
  async function fetchSleepNights() {
    const sleepParams = new URLSearchParams();
    sleepParams.set("kind", "sleep");
    // The series route caps sleep at 365 days; clamp the request so a
    // longer comparison window still resolves.
    sleepParams.set(
      "days",
      String(Math.max(1, Math.min(3650, Math.ceil(fetchWindow.windowDays)))),
    );
    // A failed read rejects the query rather than caching an empty
    // series as success (which painted "no data" with no retry).
    const data = await apiGet<{
      points?: Array<{ at: string; value: number }>;
    }>(`/api/measurements/series?${sleepParams}`);
    const points = data?.points ?? [];
    for (const point of points) {
      const value = point.value * valueScale + valueOffset;
      if (value == null || !Number.isFinite(value)) continue;
      const dayKey = toDayKey(point.at, dayKeyFormatter);
      const bucket = dailyAggregates.get(dayKey) ?? {
        timestamp: dayKeyToTimestamp(dayKey),
        values: {},
      };
      const current = bucket.values["SLEEP_DURATION"] ?? {
        sum: 0,
        count: 0,
        min: null,
        max: null,
      };
      current.sum += value;
      current.count += 1;
      bucket.values["SLEEP_DURATION"] = current;
      dailyAggregates.set(dayKey, bucket);
    }
  }

  async function fetchMeasurementsByType(type: string) {
    if (type === "SLEEP_DURATION") {
      await fetchSleepNights();
      return;
    }
    const typeParams = chartSeriesParams(type, fetchWindow);

    // The batched slice reads through the same rollup path as the
    // per-type read, so the bucketed result is identical. A covered type
    // missing from it paints the no-data card rather than fetching.
    const page =
      usePreloaded && preloadedSeries
        ? (preloadedSeries[type] ?? [])
        : await (async () => {
            // A failed read rejects the whole query (see above).
            const data = await apiGet<{
              measurements?: MeasurementApiRow[];
            }>(`/api/measurements?${typeParams}`);
            return data?.measurements ?? [];
          })();

    for (const measurement of page) {
      // The display scale folds into the value at this one boundary, so
      // everything downstream works on the scaled series. The BMI
      // division happens in `select`, so the cache stays raw.
      const value = measurement.value * valueScale + valueOffset;

      if (!Number.isFinite(value)) {
        continue;
      }

      const dayKey = toDayKey(measurement.measuredAt, dayKeyFormatter);
      const bucket = dailyAggregates.get(dayKey) ?? {
        timestamp: dayKeyToTimestamp(dayKey),
        values: {},
      };
      const current = bucket.values[type] ?? {
        sum: 0,
        count: 0,
        min: null,
        max: null,
      };
      current.sum += value;
      current.count += 1;
      // The rollup bucket's spread, scaled like the value so the band
      // tracks the line. The 7-day range never draws the band.
      if (
        fetchWindow.windowDays > 7 &&
        typeof measurement.minValue === "number" &&
        typeof measurement.maxValue === "number"
      ) {
        const scaledMin = measurement.minValue * valueScale + valueOffset;
        const scaledMax = measurement.maxValue * valueScale + valueOffset;
        current.min =
          current.min === null ? scaledMin : Math.min(current.min, scaledMin);
        current.max =
          current.max === null ? scaledMax : Math.max(current.max, scaledMax);
      }
      bucket.values[type] = current;
      dailyAggregates.set(dayKey, bucket);
    }
  }

  await Promise.all(types.map(fetchMeasurementsByType));

  const allData: ChartDataPoint[] = Array.from(dailyAggregates.values())
    .map((bucket) => {
      const point: ChartDataPoint = {
        date: tzFmt.dateShortSmart(new Date(bucket.timestamp)),
        timestamp: bucket.timestamp,
      };

      for (const [type, stats] of Object.entries(bucket.values)) {
        // Cumulative types (steps, active energy, distance, flights,
        // daylight) add up within a day; everything else averages.
        const isCumulative = CUMULATIVE_HK_TYPES.has(type as MeasurementType);
        point[type] = isCumulative ? stats.sum : stats.sum / stats.count;
        // The day's spread as a `[min, max]` tuple for the range band,
        // when the rollup supplied both bounds and the metric is not a
        // sum (a total has no meaningful intra-day spread).
        if (!isCumulative && stats.min !== null && stats.max !== null) {
          point[`${type}__range`] = [stats.min, stats.max] as never;
        }
      }

      return point;
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  return allData;
}

/**
 * The chart's daily series: one point per day in the profile time zone,
 * read from the window the active range tab needs.
 *
 * The window is bounded by the range tab (the "All" tab asks for about ten
 * years; the server steps up to week and month buckets past its day cap) and
 * stretched backwards by the comparison shift so the prior period rides the
 * same read. It ends at the end of TODAY in the profile zone, not at the mount
 * instant, so a reading saved after mount falls inside the window the
 * invalidated query refetches, and the cache key stays put all day.
 *
 * On the dashboard the batched slice stands in for the per-type reads, but
 * only for windows over 7 days that fit the batch's coverage and only when
 * every non-sleep type is in it; sleep always reads its own per-night series.
 */
export function useHealthChartSeries({
  types,
  valueMode,
  bmiDivisor,
  valueScale,
  valueOffset,
  userTimezone,
  dayKeyFormatter,
  tzFmt,
  rangePoints,
  effectiveCompareBaseline,
  preloadedSeries,
  preloadedCoverageDays,
  enabled,
  onDataReady,
}: {
  types: string[];
  valueMode: "raw" | "bmi";
  bmiDivisor: number | null;
  valueScale: number;
  valueOffset: number;
  userTimezone: string;
  dayKeyFormatter: Intl.DateTimeFormat;
  tzFmt: ReturnType<typeof makeBucketLabelFormatters>;
  rangePoints: number;
  effectiveCompareBaseline: ComparisonBaseline;
  preloadedSeries?: Record<string, MeasurementApiRow[]>;
  preloadedCoverageDays?: number;
  enabled: boolean;
  onDataReady?: () => void;
}) {
  const todayKey = localDayKeyFor(new Date(), userTimezone);
  const fetchWindow = useMemo(() => {
    const windowDays = rangeWindowDays(rangePoints);
    const compareShift =
      effectiveCompareBaseline === "lastMonth"
        ? 30
        : effectiveCompareBaseline === "lastYear"
          ? 365
          : 0;
    return openEndedFetchWindow(
      windowDays + compareShift,
      todayKey,
      userTimezone,
    );
  }, [rangePoints, effectiveCompareBaseline, userTimezone, todayKey]);

  // Without an explicit coverage (a legacy mount) the slice is bypassed
  // rather than trusted blindly.
  const usePreloaded = useMemo(() => {
    if (!preloadedSeries) return false;
    if (fetchWindow.windowDays <= 7) return false;
    const coverage = preloadedCoverageDays ?? 0;
    if (fetchWindow.windowDays > coverage) return false;
    return types.every(
      (type) => type === "SLEEP_DURATION" || preloadedSeries[type] != null,
    );
  }, [preloadedSeries, preloadedCoverageDays, fetchWindow.windowDays, types]);

  const chartQuery = useQuery({
    // A range-tab change re-keys the query; without placeholder data every
    // switch dropped the painted chart to a skeleton for the round trip. It
    // is only honest because the chart dims while `isPlaceholderData` is
    // true: the old range must never masquerade as the new one.
    placeholderData: keepPreviousData,
    // The `["chart-data"]` prefix lands in `measurementDependentKeys`, so a
    // new measurement evicts every chart's cache in one pass. The BMI view
    // shares the raw WEIGHT entry (the division happens in `select`), the
    // time zone and the window re-key it, and the discriminator separates a
    // batched render from a self-fetch only on mounts that pass a batch (an
    // empty string keeps every other caller's key as it was).
    queryKey: queryKeys.chartData(
      types.join(","),
      "raw",
      "no-bmi",
      userTimezone,
      fetchWindow.from,
      fetchWindow.to,
      valueScale,
      preloadedSeries ? (usePreloaded ? "preloaded" : "fetch") : "",
    ),
    // A minute of freshness so moving between metric pages does not refire
    // every chart; five minutes of cache for a quick back-and-forth.
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: () =>
      readDailySeries({
        types,
        fetchWindow,
        usePreloaded,
        preloadedSeries,
        valueScale,
        valueOffset,
        dayKeyFormatter,
        tzFmt,
      }),
    // The BMI view: the cached raw WEIGHT series divided at read time, so the
    // entry is shared with the weight chart. No height → no series. The range
    // tuples are dropped; the BMI view has never drawn the band.
    select: useCallback(
      (points: ChartDataPoint[]): ChartDataPoint[] => {
        if (valueMode !== "bmi") return points;
        if (!bmiDivisor) return [];
        return points.map((p) => {
          const out: ChartDataPoint = {
            date: p.date,
            timestamp: p.timestamp,
          };
          for (const type of types) {
            const v = p[type];
            if (typeof v === "number") {
              out[type] = v / bmiDivisor;
            }
          }
          return out;
        });
      },
      [valueMode, bmiDivisor, types],
    ),
    enabled,
  });

  // Report the settled first read to the dashboard's shared reveal, exactly
  // once. Latched behind a ref and keyed on `isLoading` alone: the dashboard
  // passes an inline closure, and re-running the notify on every commit kept
  // the chart row's popper anchors re-committing until React's update-depth
  // guard tripped (#185). A late-arriving handler still fires.
  const { isLoading } = chartQuery;
  const onDataReadyRef = useRef(onDataReady);
  useEffect(() => {
    onDataReadyRef.current = onDataReady;
  }, [onDataReady]);
  const dataReadyFiredRef = useRef(false);
  useEffect(() => {
    if (
      !shouldFireDataReady({
        isLoading,
        alreadyFired: dataReadyFiredRef.current,
      })
    )
      return;
    dataReadyFiredRef.current = true;
    onDataReadyRef.current?.();
  }, [isLoading]);

  return chartQuery;
}
