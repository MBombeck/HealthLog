/**
 * The pure arithmetic behind `HealthChart`: series names, day keys, the
 * moving average, the personal baseline and where annotations and markers
 * land. No React and no Recharts, so each piece has direct unit coverage.
 */
import { chartPointDayKey } from "@/components/day/chart-day";
import { isWholeNumberType } from "@/components/day/use-day-value-format";
import { translateOrNull } from "@/lib/i18n/translate-code";

import {
  computeTickPositions,
  type TickLayout,
} from "@/lib/charts/x-axis-density";

import type { ChartDataPoint } from "./types";

const BASE_TYPE_LABEL_KEYS: Record<string, string> = {
  WEIGHT: "charts.weight",
  BLOOD_PRESSURE_SYS: "charts.systolic",
  BLOOD_PRESSURE_DIA: "charts.diastolic",
  PULSE: "charts.pulse",
  BODY_FAT: "charts.bodyFat",
  SLEEP_DURATION: "charts.sleep",
  ACTIVITY_STEPS: "charts.steps",
  BLOOD_GLUCOSE: "measurements.typeBloodGlucose",
  TOTAL_BODY_WATER: "charts.bodyWater",
  BONE_MASS: "charts.boneMass",
  OXYGEN_SATURATION: "charts.spo2",
};

/**
 * The measurement label key for a type outside the chart's short labels:
 * `RESTING_HEART_RATE` → `measurements.typeRestingHeartRate`. Derived rather
 * than imported, because the full label map would ride into every route that
 * draws a chart; `health-chart-type-label.test.tsx` pins that the derivation
 * matches `MEASUREMENT_TYPE_LABEL_KEYS` for every type it is used for.
 */
export function measurementLabelKey(type: string): string {
  return `measurements.type${type
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}`;
}

/**
 * The name a series carries in the trend line, the legend, the tooltip and
 * the spoken summary. The chart's own short labels come first; every other
 * type takes its measurement label, so no overlay ever shows the raw enum.
 */
export function getTypeLabel(
  type: string,
  valueMode: "raw" | "bmi",
  t: (key: string) => string,
): string {
  if (type === "WEIGHT" && valueMode === "bmi") {
    return "BMI";
  }
  const key = BASE_TYPE_LABEL_KEYS[type];
  if (key) return t(key);
  const measurementKey = measurementLabelKey(type);
  return translateOrNull(t, measurementKey) ?? type;
}

/**
 * A `YYYY-MM-DD` day-key formatter pinned to the time zone. Memoised per zone
 * by the caller so the per-row loop reuses one `Intl.DateTimeFormat`.
 */
export function makeDayKeyFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function toDayKey(
  value: string,
  formatter: Intl.DateTimeFormat,
): string {
  const parts = formatter.formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Could not derive day key for chart");
  }

  return `${year}-${month}-${day}`;
}

export function dayKeyToTimestamp(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

export function movingAverageByPoints(
  data: Array<{ date: Date; value: number }>,
  windowSize: number,
): Array<{ date: Date; value: number }> {
  if (data.length === 0) return [];

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());

  return sorted.map((point, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = sorted.slice(start, index + 1);
    const avg =
      window.reduce((sum, item) => sum + item.value, 0) / window.length;
    return {
      date: point.date,
      value: Math.round(avg * 100) / 100,
    };
  });
}

/**
 * The personal baseline: the median of a daily series, over at most its most
 * recent 90 points (the rolling window "your normal" is framed on). Null
 * under 5 points, since a baseline drawn from one or two readings misleads.
 */
export function computePersonalBaseline(
  data: Array<{ value: number }>,
  windowPoints = 90,
): number | null {
  if (data.length < 5) return null;
  const recent = data.slice(-windowPoints);
  const sorted = recent.map((d) => d.value).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * An annotation placed on a visible point, with a 24-character truncation
 * precomputed for narrow screens.
 */
export interface ResolvedAnnotation {
  pointIndex: number;
  label: string;
  color: string;
  truncatedLabel: string;
}

/** A vertical marker placed on a visible point. */
export interface ResolvedVerticalMarker {
  pointIndex: number;
  color: string;
  label: string | undefined;
}

/**
 * Markers land only on a day the chart has a point for (matched by exact day
 * key): a line through a gap in the axis would hang with no data context and
 * read as a rendering bug. Off-window markers drop.
 */
export function resolveVerticalMarkerPositions(
  markers: Array<{ date: string; label?: string; color?: string }> | undefined,
  chartData: Array<{ date: string; timestamp?: number }> | undefined,
): ResolvedVerticalMarker[] {
  if (!markers || !chartData || chartData.length === 0) return [];
  const indexByDate = new Map<string, number>();
  for (const [i, point] of chartData.entries()) {
    // Last write wins. A drawn point's `date` is its display label
    // ("12.03."), so the day key comes from its timestamp, which a daily
    // point holds at noon UTC of its day; a bare `{ date }` (the pure-helper
    // tests) is the key.
    indexByDate.set(
      typeof point.timestamp === "number"
        ? chartPointDayKey(point.timestamp)
        : point.date,
      i,
    );
  }
  const out: ResolvedVerticalMarker[] = [];
  for (const marker of markers) {
    const idx = indexByDate.get(marker.date);
    if (idx === undefined) continue;
    out.push({
      pointIndex: idx,
      color: marker.color ?? "var(--success)",
      label: marker.label,
    });
  }
  return out;
}

/**
 * Annotations snap to the nearest visible point within 7 days; further off
 * they drop, or long buckets (monthly aggregation) would pull events from
 * months away onto one point and stack their labels.
 */
export function resolveAnnotationPositions(
  annotations:
    Array<{ date: string; label: string; color: string }> | undefined,
  chartData: Array<{ timestamp: number }> | undefined,
): ResolvedAnnotation[] {
  if (!annotations || !chartData || chartData.length === 0) return [];
  const out: ResolvedAnnotation[] = [];
  for (const annotation of annotations) {
    const targetMs = Date.parse(`${annotation.date}T12:00:00Z`);
    if (!Number.isFinite(targetMs)) continue;
    let bestIdx = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const [i, point] of chartData.entries()) {
      const delta = Math.abs(point.timestamp - targetMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestDelta > 7 * 24 * 60 * 60 * 1000) continue;
    const truncatedLabel =
      annotation.label.length > 24
        ? `${annotation.label.slice(0, 23)}…`
        : annotation.label;
    out.push({
      pointIndex: bestIdx,
      label: annotation.label,
      color: annotation.color,
      truncatedLabel,
    });
  }
  return out;
}

/**
 * The value axis's and the tooltip's number formats. One decimal on the axis
 * while the visible domain spans under 6 units, so two gridlines never round
 * to the same integer (82.8 vs 83.5 kg).
 */
export function axisValueFormatters(
  yDomain: [number, number] | undefined,
  fmt: {
    number: (value: number, digits: number) => string;
    integer: (value: number) => string;
  },
) {
  const span = yDomain ? yDomain[1] - yDomain[0] : null;
  const useDecimalAxis = span !== null && span < 6;
  return {
    useDecimalAxis,
    formatAxisValue: (value: number) =>
      useDecimalAxis ? fmt.number(value, 1) : fmt.integer(value),
    formatTooltipValue: (value: number) => fmt.number(value, 1),
  };
}

/**
 * What the day shows at its top when opened from a point: the chart's name
 * and the point's value as the tooltip reads it. A pressure or a pulse reads
 * in whole numbers on the day, as in every list; the rest keep the tooltip's
 * one decimal.
 */
export function dayFocusFor(
  point: ChartDataPoint | undefined,
  ctx: {
    types: string[];
    title: string;
    unit?: string;
    valueMode: "raw" | "bmi";
    fmt: { number: (value: number, digits: number) => string };
    formatTooltipValue: (value: number) => string;
  },
) {
  if (!point) return null;
  const parts = ctx.types
    .map((type) => ({ type, v: point[type] }))
    .filter((p): p is { type: string; v: number } => typeof p.v === "number");
  if (parts.length === 0) return null;
  return {
    label: ctx.title,
    value: parts
      .map(({ type, v }) =>
        ctx.valueMode === "raw" && isWholeNumberType(type)
          ? ctx.fmt.number(Math.round(v), 0)
          : ctx.formatTooltipValue(v),
      )
      .join("/"),
    unit: ctx.unit,
    types: ctx.valueMode === "raw" ? ctx.types : [],
  };
}

/**
 * Where the x labels are drawn: the plot's width (the container less the
 * chart margins, the y axis, the right-hand label room and the axis padding)
 * and the width a date label takes, with room between two. Null until the
 * container has been measured; the ticks then fall back to the count cap.
 */
export function xTickLayout(
  containerWidth: number | null,
  yAxisWidth: number,
  rightRoom: number,
): { plotWidth: number; labelWidth: number } | undefined {
  if (!containerWidth) return undefined;
  const plotWidth = containerWidth - 16 - yAxisWidth - rightRoom - 20;
  if (plotWidth <= 0) return undefined;
  // A day-month-year date at the axis's 11 px, with a gap of its own size
  // between two labels so the row reads as separate dates.
  return { plotWidth, labelWidth: 64 + 16 };
}

/**
 * The x axis's props: one point per index, labelled with its date. Recharts
 * ignores `interval` on a numeric axis, so the calendar grid arrives as
 * explicit tick positions (`computeTickPositions`).
 */
export function pointIndexXAxis({
  chartData,
  formatDate,
  viewportWidth,
  layout,
}: {
  chartData: ChartDataPoint[] | undefined;
  formatDate: (date: Date) => string;
  viewportWidth: number;
  layout: TickLayout | undefined;
}) {
  return {
    type: "number" as const,
    dataKey: "pointIndex",
    domain: [0, Math.max(0, (chartData?.length ?? 1) - 1)],
    allowDecimals: false,
    tick: { fontSize: 11, fill: "var(--muted-foreground)" },
    tickLine: false,
    axisLine: false,
    tickFormatter: (value: number) =>
      formatDate(
        new Date(chartData?.[Math.round(value)]?.timestamp ?? Date.now()),
      ),
    ticks: computeTickPositions(chartData ?? [], viewportWidth, layout),
    padding: { left: 10, right: 10 },
    tickMargin: 10,
  };
}
