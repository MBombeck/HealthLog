"use client";

import { useMemo } from "react";

import {
  computeWindowTrend,
  SPLIT_HALF_THRESHOLD_DAYS,
} from "@/lib/analytics/window-trend";
import type { MetricWindowStats } from "@/lib/charts/window-stats";
import type { useFormatters } from "@/lib/i18n/context";

import type { ChartDataTableColumn } from "../chart-data-table";

import { computePersonalBaseline, getTypeLabel } from "./series-math";
import type {
  ChartDataPoint,
  ChartTargetZone,
  ChartValueBand,
  VisibleTargetZone,
  VisibleValueBand,
} from "./types";
import { baselineLabelText, rightLabelRoom } from "./chart-layers";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;
type Formatters = ReturnType<typeof useFormatters>;

/** A band clipped to the y domain, as top / height percentages of the plot. */
function clipToDomain(
  min: number,
  max: number,
  [domainMin, domainMax]: [number, number],
) {
  const span = domainMax - domainMin;
  const low = Math.max(Math.min(min, max), domainMin);
  const high = Math.min(Math.max(min, max), domainMax);
  if (high <= low) return null;
  return {
    low,
    high,
    topPct: ((domainMax - high) / span) * 100,
    heightPct: ((high - low) / span) * 100,
  };
}

/**
 * The layers drawn over the series: the value bands and target zones
 * (clipped to the y domain, only with the target-range toggle on), the
 * personal baseline per type, and the trend read-out above the plot.
 */
export function useHealthChartOverlays({
  showBands,
  showTrend,
  valueBands,
  targetZones,
  yDomain,
  chartData,
  types,
  unit,
  valueMode,
  t,
  fmt,
}: {
  showBands: boolean;
  showTrend: boolean;
  valueBands?: ChartValueBand[];
  targetZones?: ChartTargetZone[];
  yDomain: [number, number] | undefined;
  chartData: ChartDataPoint[] | undefined;
  types: string[];
  unit?: string;
  valueMode: "raw" | "bmi";
  t: Translate;
  fmt: Formatters;
}) {
  const visibleBands = useMemo<VisibleValueBand[]>(() => {
    if (!showBands || !valueBands?.length || !yDomain) return [];
    const span = yDomain[1] - yDomain[0];
    if (!Number.isFinite(span) || span <= 0) return [];

    return valueBands
      .map((band, index) => {
        const clipped = clipToDomain(band.min, band.max, yDomain);
        if (!clipped) return null;
        return {
          key: `${band.min}-${band.max}-${index}`,
          topPct: clipped.topPct,
          heightPct: clipped.heightPct,
          color: band.color,
          opacity: band.opacity ?? 0.2,
          strokeOpacity: band.strokeOpacity ?? 0.35,
        };
      })
      .filter(
        (entry): entry is VisibleValueBand =>
          entry !== null && entry.heightPct > 0,
      );
  }, [showBands, valueBands, yDomain]);

  const visibleTargetZones = useMemo<VisibleTargetZone[]>(() => {
    if (!showBands || !targetZones?.length || !yDomain) return [];
    const span = yDomain[1] - yDomain[0];
    if (!Number.isFinite(span) || span <= 0) return [];

    const zones: VisibleTargetZone[] = [];
    for (const [index, zone] of targetZones.entries()) {
      const clipped = clipToDomain(zone.min, zone.max, yDomain);
      if (!clipped) continue;
      zones.push({
        key: `${zone.min}-${zone.max}-${index}`,
        ...clipped,
        color: zone.color,
        opacity: zone.opacity ?? 0.3,
        label: zone.label ?? undefined,
        textColor: zone.textColor ?? undefined,
        lineOpacity: zone.lineOpacity ?? 0.42,
      });
    }
    return zones;
  }, [showBands, targetZones, yDomain]);

  const trendInfo = useMemo(() => {
    if (!showTrend || !chartData?.length) return [];

    const formatSigned = (value: number) => {
      const formatted = fmt.number(Math.abs(value), 1);
      return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}`;
    };

    return types
      .map((type) => {
        const series = chartData.filter(
          (point) =>
            typeof point[type] === "number" &&
            typeof point[`${type}_trend`] === "number",
        );
        if (series.length < 2) return null;

        const first = series[0];
        const last = series[series.length - 1];
        const days = (last.timestamp - first.timestamp) / 86400000;
        if (!Number.isFinite(days) || days <= 0) return null;

        const rawValues = series.map((point) => point[type] as number);
        const trendValues = series.map(
          (point) => point[`${type}_trend`] as number,
        );

        const computed = computeWindowTrend({
          rawValues,
          trendValues,
          windowDays: days,
        });
        if (!computed) return null;

        const { weeklyDelta, splitHalfDelta } = computed;
        const base = rawValues[0];
        const weeklyPct =
          Math.abs(base) > Number.EPSILON
            ? (weeklyDelta / Math.abs(base)) * 100
            : null;
        const unitSuffix = unit ? ` ${unit}` : "";

        // On a long window the per-week slope rounds to ±0.0 and reads as "no
        // change", so from SPLIT_HALF_THRESHOLD_DAYS the first-half versus
        // second-half mean delta is added: one number that cannot round to
        // zero unless the metric truly did not move.
        let totalDeltaSegment = "";
        if (days >= SPLIT_HALF_THRESHOLD_DAYS && splitHalfDelta !== null) {
          const meanFirst =
            rawValues
              .slice(0, Math.floor(rawValues.length / 2))
              .reduce((sum, value) => sum + value, 0) /
            Math.max(1, Math.floor(rawValues.length / 2));
          const totalDeltaPct =
            Math.abs(meanFirst) > Number.EPSILON
              ? (splitHalfDelta / Math.abs(meanFirst)) * 100
              : null;
          totalDeltaSegment = ` · ${t(
            "charts.totalDelta",
          )} ${formatSigned(splitHalfDelta)}${unitSuffix}${
            totalDeltaPct != null ? ` (${formatSigned(totalDeltaPct)} %)` : ""
          }`;
        }

        return `${getTypeLabel(type, valueMode, t)}: ${formatSigned(
          weeklyDelta,
        )}${unitSuffix}${t("charts.perWeek")}${
          weeklyPct != null
            ? ` (${formatSigned(weeklyPct)} %${t("charts.perWeek")})`
            : ""
        }${totalDeltaSegment}`;
      })
      .filter((entry): entry is string => entry !== null);
  }, [chartData, showTrend, types, unit, valueMode, t, fmt]);

  // The personal baseline (rolling 90-point median) per type, a faint dashed
  // "your normal" line, so each point reads against the person's own level.
  const personalBaselines = useMemo(() => {
    if (!chartData?.length) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const type of types) {
      const series = chartData
        .filter((d) => typeof d[type] === "number")
        .map((d) => ({ value: d[type] as number }));
      const baseline = computePersonalBaseline(series, 90);
      if (baseline !== null) map.set(type, baseline);
    }
    return map;
  }, [chartData, types]);

  // The labels drawn beside the plot (the average's, the target zones'), and
  // so the room the plot keeps for them on its right.
  const baselineLabel = baselineLabelText(
    showTrend,
    types,
    personalBaselines,
    yDomain,
    t,
  );

  return {
    visibleBands,
    visibleTargetZones,
    trendInfo,
    personalBaselines,
    rightRoom: rightLabelRoom([
      baselineLabel,
      ...visibleTargetZones.map((zone) => zone.label),
    ]),
  };
}

/**
 * The words around the plot: a spoken summary of the primary series (range,
 * latest value, direction) so a screen reader does not meet an unlabelled
 * graphic, and the data table's columns, one per series that has a value in
 * the window, named by the same helper as the legend.
 */
export function useHealthChartLabels({
  types,
  valueMode,
  t,
  fmt,
  chartData,
  chartDataWithCompare,
  visibleStatsByType,
  showDataTable,
  mini,
}: {
  types: string[];
  valueMode: "raw" | "bmi";
  t: Translate;
  fmt: Formatters;
  chartData: ChartDataPoint[] | undefined;
  chartDataWithCompare: ChartDataPoint[] | undefined;
  visibleStatsByType: Record<string, MetricWindowStats> | null;
  showDataTable: boolean;
  mini: boolean;
}) {
  const primaryType = types[0];
  const chartAriaLabel = useMemo(() => {
    const metric = getTypeLabel(primaryType, valueMode, t);
    const source = chartDataWithCompare ?? chartData;
    const values = (source ?? [])
      .map((point) => point[primaryType])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (values.length === 0) {
      return t("charts.a11y.noData", { metric });
    }
    const stats = visibleStatsByType?.[primaryType];
    const minVal = stats?.min ?? Math.min(...values);
    const maxVal = stats?.max ?? Math.max(...values);
    const latestVal = values[values.length - 1];
    const firstVal = values[0];
    const epsilon = Math.max(Math.abs(maxVal - minVal) * 0.02, 0.01);
    const delta = latestVal - firstVal;
    const trend =
      delta > epsilon
        ? t("charts.a11y.trendUp")
        : delta < -epsilon
          ? t("charts.a11y.trendDown")
          : t("charts.a11y.trendFlat");
    return t("charts.a11y.summary", {
      metric,
      min: fmt.number(minVal, 1),
      max: fmt.number(maxVal, 1),
      latest: fmt.number(latestVal, 1),
      trend,
    });
  }, [
    primaryType,
    valueMode,
    t,
    chartDataWithCompare,
    chartData,
    visibleStatsByType,
    fmt,
  ]);

  // A type with no value anywhere in the window gets no column: a column of
  // dashes states nothing the chart's own empty line does not.
  const dataTableColumns = useMemo<ChartDataTableColumn[]>(() => {
    if (!showDataTable || mini) return [];
    const source = chartDataWithCompare ?? chartData;
    if (!source?.length) return [];
    return types
      .filter((type) =>
        source.some(
          (point) =>
            typeof point[type] === "number" &&
            Number.isFinite(point[type] as number),
        ),
      )
      .map((type) => ({ key: type, label: getTypeLabel(type, valueMode, t) }));
  }, [
    showDataTable,
    mini,
    chartDataWithCompare,
    chartData,
    types,
    valueMode,
    t,
  ]);

  return { primaryType, chartAriaLabel, dataTableColumns };
}
