"use client";

/**
 * The mood chart's plot and tooltip, apart from the data and the card chrome
 * `MoodChart` owns. Pure rendering over the props it is handed.
 */
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  OPEN_DAY_LINE,
  type ChartDayLinks,
} from "@/components/day/chart-day-links";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";
import type { Formatters } from "@/lib/format-locale";
import { computeTickPositions } from "@/lib/charts/x-axis-density";
import {
  PERIOD_END_KEY,
  PERIOD_START_KEY,
  pointPeriodLabel,
  READINGS_KEY,
} from "@/lib/charts/range-grain";
import type { ChartBucketType } from "@/lib/charts/bucket-time-series";

import { RichChartTooltip, type RichTooltipRow } from "../chart-tooltip";

export interface ChartDataPoint {
  date: string;
  timestamp: number;
  pointIndex: number;
  score: number;
  ma?: number;
  trend?: number;
  /** The prior-period overlay value. */
  scoreCompare?: number;
  /** The days a week or month point covers, and the entries behind it. */
  [PERIOD_START_KEY]?: number;
  [PERIOD_END_KEY]?: number;
  [READINGS_KEY]?: number;
}

// Mood-level bands ride the same Dracula good→bad ramp the mood
// heatmap and distribution chart already use (red → orange → yellow →
// green), so the chart reads the same colour story as its neighbours.
const VALUE_BANDS = [
  { min: 1, max: 2, color: "var(--dracula-red)", opacity: 0.16 },
  { min: 2, max: 3, color: "var(--dracula-orange)", opacity: 0.18 },
  { min: 3, max: 3.5, color: "var(--dracula-yellow)", opacity: 0.18 },
  { min: 3.5, max: 5, color: "var(--dracula-green)", opacity: 0.2 },
] as const;

// The mood line + overlays use the same hues the rest of the Insights
// charts do — purple primary (matching HealthChart), pink moving average,
// cyan trend — as tokens rather than the former hand-picked hex.
const COLOR_MAIN = "var(--dracula-purple)";
const COLOR_MA = "var(--dracula-pink)";
const COLOR_TREND = "var(--dracula-cyan)";

/**
 * Six evenly-spaced grid lines inside the plot area (top + 4 intermediate +
 * bottom), the density of the BP / weight / pulse minis. The mood axis pins
 * five ticks, which Recharts would otherwise sync the grid to.
 */
function sixGridLines({
  offset,
}: {
  offset: { top?: number; height?: number };
}): number[] {
  const top = offset.top ?? 0;
  const height = offset.height ?? 0;
  if (height <= 0) return [];
  const lines = 6;
  return Array.from({ length: lines }, (_, i) =>
    Math.round(top + (height * i) / (lines - 1)),
  );
}

export interface MoodChartPlotProps {
  chartData: ChartDataPoint[];
  chartDataWithCompare: ChartDataPoint[] | undefined;
  mini: boolean;
  chartDays: ChartDayLinks;
  moodAriaLabel: string;
  showBands: boolean;
  showTrend: boolean;
  showMA: boolean;
  personalBaseline: number | null;
  maxPointIndex: number;
  tzFmt: Formatters;
  fmt: Formatters;
  viewportWidth: number;
  formatMoodTick: (value: number) => string;
  formatTooltipValue: (value: number) => string;
  effectiveCompareBaseline: ComparisonBaseline;
  hasComparisonData: boolean;
  animationsEnabled: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
  dayLinkSource: ChartDataPoint[] | undefined;
  /** The grain the points are drawn at, for the tooltip and `data-bucket`. */
  bucket: ChartBucketType;
}

function renderMoodTooltip(props: unknown, p: MoodChartPlotProps) {
  const {
    active,
    payload,
    label: rechartsLabel,
  } = props as unknown as {
    active?: boolean;
    payload?: Array<{
      name?: string;
      value?: number;
      color?: string;
      dataKey?: string;
      payload?: ChartDataPoint;
    }>;
    label?: number;
  };
  if (!active || !payload?.length) return null;
  const ts =
    payload[0]?.payload?.timestamp ??
    (typeof rechartsLabel === "number"
      ? p.chartData?.[Math.round(rechartsLabel)]?.timestamp
      : undefined);
  const hoverPoint = payload[0]?.payload as ChartDataPoint | undefined;
  // A week or month names the days it covers and that it is an average, as
  // the measurement chart's tooltip does.
  const dateLabel = hoverPoint
    ? pointPeriodLabel(hoverPoint, p.tzFmt.date, p.t)
    : ts
      ? p.tzFmt.date(new Date(ts))
      : "";
  const caption =
    p.bucket === "week"
      ? p.t("charts.bucketWeekly")
      : p.bucket === "month"
        ? p.t("charts.bucketMonthly")
        : null;
  const readings = hoverPoint?.[READINGS_KEY];
  const label = [
    dateLabel,
    caption,
    caption && typeof readings === "number"
      ? p.t("charts.bucketEntries", { count: p.fmt.integer(readings) })
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  const rows: RichTooltipRow[] = [];
  for (const item of payload) {
    if (typeof item.value !== "number") continue;
    const dataKey = String(item.dataKey ?? "");
    // Skip auxiliary lines (`ma`, `trend`,
    // `scoreCompare`). Comparison value rendered as
    // delta on the primary row + own row below.
    if (dataKey === "ma" || dataKey === "trend" || dataKey === "scoreCompare")
      continue;
    let delta: string | undefined;
    const compareValue =
      p.effectiveCompareBaseline !== "none" && hoverPoint
        ? hoverPoint.scoreCompare
        : undefined;
    if (
      p.effectiveCompareBaseline !== "none" &&
      typeof compareValue === "number" &&
      Number.isFinite(compareValue)
    ) {
      const diff = item.value - compareValue;
      if (Math.abs(diff) < 0.05) {
        delta = p.t("charts.deltaUnchanged");
      } else {
        const sign = diff > 0 ? "+" : "−";
        const formatted = `${sign}${p.fmt.number(Math.abs(diff), 1)}`;
        delta = p
          .t(
            p.effectiveCompareBaseline === "lastMonth"
              ? "comparison.deltaVs.lastMonth"
              : "comparison.deltaVs.lastYear",
          )
          .replace("{delta}", formatted);
      }
    } else if (p.personalBaseline != null) {
      const diff = item.value - p.personalBaseline;
      if (Math.abs(diff) < 0.05) {
        delta = p.t("charts.deltaUnchanged");
      } else {
        const sign = diff > 0 ? "+" : "−";
        const formatted = `${sign}${p.fmt.number(Math.abs(diff), 1)}`;
        delta = p.t("charts.deltaVsBaseline").replace("{delta}", formatted);
      }
    }
    rows.push({
      name: p.t("charts.moodScore"),
      value: p.formatTooltipValue(item.value),
      color: item.color ?? COLOR_MAIN,
      delta,
    });
    if (
      p.effectiveCompareBaseline !== "none" &&
      typeof compareValue === "number" &&
      Number.isFinite(compareValue)
    ) {
      rows.push({
        name: `${p.t("charts.moodScore")}, ${p.t("comparison.tooltipPrior")}`,
        value: p.formatTooltipValue(compareValue),
        color: item.color ?? COLOR_MAIN,
      });
    }
  }
  if (rows.length === 0) return null;
  return (
    <RichChartTooltip
      active
      label={label}
      rows={rows}
      action={p.chartDays.tooltipAction(
        hoverPoint ? p.dayLinkSource?.indexOf(hoverPoint) : undefined,
      )}
    />
  );
}

export function MoodChartPlot(p: MoodChartPlotProps) {
  return (
    <div
      // The mood line plots a 1–5 score band; the former
      // 240/280 px full-mode height left a tall dead strip below the
      // line on the mood subpage. Tighten the default to 200/220 px so
      // the chart fits its content without the empty gap. A per-mount
      // `--chart-height` override (trends-row mini, etc.) still wins, so
      // only the unoverridden full-mode mount shrinks.
      className={`${
        p.mini
          ? "h-[var(--chart-height,140px)]"
          : "h-[var(--chart-height,200px)] md:h-[var(--chart-height-md,220px)]"
      } touch-pan-y ${p.chartDays.plotClassName}`}
      {...p.chartDays.plotProps}
      // Same stable hook as the measurement chart: rendered by the data
      // branch only, so the browser suite can gate on it instead of on
      // Recharts' own class names.
      data-slot="chart-plot"
      data-bucket={p.bucket}
      role="img"
      aria-label={p.moodAriaLabel}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={p.chartDataWithCompare ?? p.chartData}
          margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
          accessibilityLayer
          onClick={p.chartDays.onChartClick}
        >
          {/* The mood chart's YAxis is pinned to
                    five mood-score ticks ([1,2,3,4,5]), which Recharts
                    syncs with CartesianGrid by default. That left the
                    mini variant painting five horizontal lines while
                    the BP / Weight / Pulse minis painted six (their
                    auto-generated YAxis ticks land on six bands in
                    typical health ranges). The explicit coordinates
                    generator below produces six evenly-spaced lines
                    so the trends row reads as a single rhythm. */}
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.5}
            horizontalCoordinatesGenerator={sixGridLines}
          />
          {p.showBands &&
            VALUE_BANDS.map((band) => (
              <ReferenceArea
                key={`band-${band.min}-${band.max}`}
                y1={band.min}
                y2={band.max}
                fill={band.color}
                fillOpacity={band.opacity}
                strokeOpacity={0}
                ifOverflow="discard"
              />
            ))}
          {/* Personal-baseline gated behind the
                    Trend toggle (maintainer: "only when a trend is being
                    displayed"). Default OFF. */}
          {p.showTrend && p.personalBaseline != null && (
            <ReferenceLine
              y={p.personalBaseline}
              stroke={COLOR_MAIN}
              strokeDasharray="2 4"
              strokeOpacity={0.4}
              strokeWidth={1}
              ifOverflow="discard"
              label={{
                value: p.t("charts.personalBaseline"),
                position: "insideTopLeft",
                fill: "var(--muted-foreground)",
                fontSize: 10,
                opacity: 0.7,
              }}
            />
          )}
          <XAxis
            type="number"
            dataKey="pointIndex"
            domain={[0, p.maxPointIndex]}
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) =>
              p.tzFmt.date(
                new Date(
                  p.chartData[Math.round(value)]?.timestamp ?? Date.now(),
                ),
              )
            }
            // Recharts ignores `interval` on numeric
            // axes; pass explicit tick positions instead.
            ticks={computeTickPositions(p.chartData ?? [], p.viewportWidth)}
            padding={{ left: 10, right: 10 }}
            tickMargin={10}
          />
          <YAxis
            domain={[1, 5]}
            ticks={[1, 2, 3, 4, 5]}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={65}
            tickMargin={10}
            tickFormatter={p.formatMoodTick}
          />
          {p.chartDays.openIndex !== undefined ? (
            <ReferenceLine
              key="open-day"
              x={p.chartDays.openIndex}
              {...OPEN_DAY_LINE}
            />
          ) : null}
          <Tooltip
            {...p.chartDays.tooltipProps}
            cursor={{
              stroke: "var(--muted-foreground)",
              strokeOpacity: 0.3,
              strokeDasharray: "3 3",
            }}
            content={(props) => renderMoodTooltip(props, p)}
          />
          <Line
            type="monotone"
            dataKey="score"
            name="score"
            stroke={COLOR_MAIN}
            strokeWidth={2}
            dot={{ r: 3, fill: COLOR_MAIN }}
            activeDot={{ r: 5 }}
            connectNulls
            isAnimationActive={p.animationsEnabled}
            animationDuration={p.animationsEnabled ? 600 : 0}
            animationEasing="ease-out"
          />
          {p.showMA && (
            <Line
              type="monotone"
              dataKey="ma"
              name="ma"
              stroke={COLOR_MA}
              strokeWidth={1.5}
              strokeDasharray="5 5"
              dot={false}
              connectNulls
            />
          )}
          {p.showTrend && (
            <Line
              type="linear"
              dataKey="trend"
              name="trend"
              stroke={COLOR_TREND}
              strokeWidth={1}
              strokeDasharray="8 4"
              dot={false}
              connectNulls
            />
          )}
          {/* Comparison overlay (mood). Same
                    dimmed dashed treatment the BP/weight/pulse chart
                    uses; mood is a single metric so we only render
                    one overlay line. Suppressed when there's no prior
                    data via hasComparisonData. */}
          {p.effectiveCompareBaseline !== "none" && p.hasComparisonData && (
            <Line
              type="monotone"
              dataKey="scoreCompare"
              name="scoreCompare"
              stroke={COLOR_MAIN}
              strokeWidth={1.25}
              strokeDasharray="4 3"
              strokeOpacity={0.45}
              dot={false}
              connectNulls
              isAnimationActive={p.animationsEnabled}
              animationDuration={p.animationsEnabled ? 600 : 0}
              animationEasing="ease-out"
              legendType="none"
              data-slot="chart-compare-line-mood"
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
