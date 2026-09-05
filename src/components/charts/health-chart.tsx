"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ReferenceArea,
  ReferenceDot,
} from "recharts";
import {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  type ComponentType,
} from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { RichChartTooltip, type RichTooltipRow } from "./chart-tooltip";
import { ChartEmptyState } from "./chart-empty-state";
import { ChartErrorState } from "./chart-error-state";
import { TileHeader } from "@/components/insights/tile-header";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { computePaddedYDomain } from "@/lib/insights/chart-y-domain";
import { Button } from "@/components/ui/button";
import {
  useDateFormatPreference,
  useTranslations,
  useFormatters,
} from "@/lib/i18n/context";
import { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import {
  bucketTimeSeries,
  pickBucket,
  type ChartBucketType,
} from "@/lib/charts/bucket-time-series";
import {
  computeWindowTrend,
  SPLIT_HALF_THRESHOLD_DAYS,
} from "@/lib/analytics/window-trend";
import { resolveMiniRangePoints, type DataWindow } from "./mini-window";
import { shiftDailySeriesForward } from "@/lib/charts/comparison-shift";
import type {
  ChartOverlayKey,
  ComparisonBaseline,
} from "@/lib/dashboard-layout";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import type { MeasurementType } from "@/generated/prisma/client";
import { ChartOverlayControls } from "./chart-overlay-controls";
import { ChartDataTable, type ChartDataTableColumn } from "./chart-data-table";
import { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import { useViewportWidth } from "@/hooks/use-viewport-width";
import { computeTickPositions } from "@/lib/charts/x-axis-density";
import {
  computeWindowStats,
  type MetricWindowStats,
} from "@/lib/charts/window-stats";
import { shouldFireDataReady } from "@/lib/charts/data-ready-latch";

// The range tabs select a CALENDAR-DAY window ending now — `days: 7` is
// "the last 7 days", not "the last 7 readings". The labels said "points"
// until v1.37.29 while the fetch below always treated the value as a day
// window; a user who weighs in twice a week picked "7 pts" and saw two.
// The persisted preference field keeps its historical name `rangePoints`
// (it crosses the chart-overlay-prefs wire), but its value has always
// been days.
const TIME_RANGES_KEYS = [
  {
    labelKey: "charts.days7Label",
    days: 7,
    titleKey: "charts.days7Title",
  },
  {
    labelKey: "charts.days30Label",
    days: 30,
    titleKey: "charts.days30Title",
  },
  {
    labelKey: "charts.days90Label",
    days: 90,
    titleKey: "charts.days90Title",
  },
  {
    labelKey: "charts.daysAllLabel",
    days: 0,
    titleKey: "charts.daysAllTitle",
  },
] as const;

/**
 * v1.19.0 — day-span the "All" range tab (`rangePoints === 0`) fetches.
 * A generous fixed bound (~10 years) that is clearly larger than any
 * other range tab, so "All" means "all of my history" rather than the
 * old silent 365-day truncation. Fixed (not per-account derived) so the
 * fetch-window cache key stays stable across the session.
 *
 * v1.19.2 — the server's daily-aggregate reader now steps UP the bucket
 * tier (DAY → WEEK → MONTH) for windows wider than the DAY cap, so a
 * multi-year "All" range returns whole-history coverage downsampled to
 * the tier the chart's `bucketTimeSeries` would render anyway, instead of
 * truncating to the most recent ~365 daily buckets. The render cost stays
 * flat — the coarse tier bounds the point count.
 */
const ALL_RANGE_DAYS = 3650;

interface HealthChartProps {
  types: string[];
  title: string;
  colors?: string[];
  unit?: string;
  yAxisUnit?: string;
  valueMode?: "raw" | "bmi";
  yAxisWidth?: number;
  showYAxisUnit?: boolean;
  valueBands?: Array<{
    min: number;
    max: number;
    color: string;
    opacity?: number;
    strokeOpacity?: number;
  }>;
  targetZones?: Array<{
    min: number;
    max: number;
    color: string;
    opacity?: number;
    label?: string;
    textColor?: string;
    lineOpacity?: number;
  }>;
  /**
   * v1.4.16 phase B5c — compact chart mode used by the Oura-style
   * rationale card. Drops the range tabs, the moving-average / trend
   * / target-band toggle row, and shrinks padding. Tooltip + gradient
   * + personal-baseline behaviour stay intact so the small chart
   * still tells the same visual story.
   */
  mini?: boolean;
  /**
   * v1.4.16 phase B5c — pin the chart to a specific rationale data
   * window regardless of any parent UI state. Used by the rec-card's
   * mini-chart so it always renders the window the rec is based on.
   */
  windowOverride?: DataWindow;
  /**
   * v1.4.16 phase B8 — when set to "lastMonth" / "lastYear", paint a
   * dimmed prior-period overlay beneath the current series. The chart
   * already fetches the full measurement history; the overlay is
   * computed by `shiftDailySeriesForward` so the prior-period day at
   * 30 / 365 days back lands directly under its current-period sibling
   * on the visible x-axis.
   *
   * "none" or undefined renders the chart exactly as before — no
   * regression for users who keep the toggle off.
   */
  compareBaseline?: ComparisonBaseline;
  /**
   * v1.4.18 — per-chart overlay-prefs key. When supplied, the chart
   * mounts an overlay-controls dropdown in the header and reads its
   * three toggle states from the persisted user prefs. When omitted
   * (mini mode, ad-hoc usage) the chart renders without controls and
   * its toggles default to OFF (clean line).
   */
  chartKey?: ChartOverlayKey;
  /**
   * v1.4.20 phase B4 — additive storyboard annotations.
   *
   * Each entry pins a vertical reference line + label to the data point
   * whose Berlin-day key matches `date` (`YYYY-MM-DD`). The chart line
   * + tooltip + tooltip-deltas remain untouched — Recharts' source-order
   * layering paints `<ReferenceLine>` between the cartesian grid and
   * the data lines so the annotation reads as orientation, not data.
   *
   * Annotations whose date falls outside the visible window silently
   * drop (we already use `ifOverflow="discard"` on every reference line
   * that needs the same behaviour).
   */
  annotations?: Array<{ date: string; label: string; color: string }>;
  /**
   * v1.4.25 W6 — vertical injection-day markers.
   *
   * Each entry pins a thin dashed vertical reference line on the chart
   * at the data point whose Berlin/user-tz day-key matches `date`
   * (`YYYY-MM-DD`). Designed for the GLP-1 dashboard tile + the
   * Insights /medikamente sub-page so users can see "I injected on
   * these days; here's how my weight responded". Differs from
   * `annotations` in three ways:
   *   1. No text label by default — these markers represent events
   *      the user already saw the chart-line shape for; an inline
   *      label per marker would crowd the canvas.
   *   2. A small filled dot sits at the x-axis intersection (mood-
   *      chart style emoji-on-axis pattern repurposed) so a row of
   *      green dots reads as "injection cadence" at a glance.
   *   3. Default green (`var(--success)`) to match the strip-tile palette
   *      for active medications; callers can override per marker.
   *
   * Off-window markers silently drop via `ifOverflow="discard"`,
   * matching the existing annotations contract.
   */
  verticalMarkers?: Array<{ date: string; label?: string; color?: string }>;
  /**
   * v1.4.25 W7b — per-user display timezone. When passed (mount sites
   * thread `useAuth().user?.timezone`), x-axis tick labels and the
   * per-day bucket keys both render in the user's zone instead of the
   * legacy Europe/Berlin pin. Defaults to "Europe/Berlin" so older
   * callers that haven't yet adopted the prop keep their previous
   * behaviour bit-for-bit.
   */
  userTimezone?: string;
  /**
   * v1.7.0 — display-time scalar applied to every raw value before it
   * enters the chart pipeline (bucketing, y-domain, personal baseline,
   * trend, tooltip). Used by the unit-fix mounts to render a metric in
   * a derived display unit (e.g. WALKING_SPEED m/s → km/h via
   * `valueScale={3.6}`) while raw storage stays canonical SI.
   *
   * Defaults to `1` — the identity scale — so every existing chart
   * renders byte-identical to the pre-v1.7.0 behaviour. Recharts is
   * untouched; the scale is folded into the value at the single read
   * boundary so all downstream math operates on the scaled series
   * uniformly.
   */
  valueScale?: number;
  /**
   * v1.32.26 — display-time additive offset folded in alongside
   * `valueScale` at the same read boundary: `display = raw * valueScale +
   * valueOffset`. Required for the affine °C→°F conversion (a shift, not
   * just a scale). Defaults to `0`. Because every tooltip delta / trend
   * slope is computed as a DIFFERENCE of two offset values, the offset
   * cancels there automatically — a rate never inherits the +32 shift.
   */
  valueOffset?: number;
  /**
   * v1.12.8 — chart-reactive metric statistics. When supplied, the chart
   * reports the per-type Min / Max / Median / Mean of the data currently
   * visible under the active range tab (the 7 / 30 / 90 / All selector),
   * keyed by `MeasurementType`. It fires on mount and whenever the range tab
   * (or the underlying series) changes, so the `<MetricStatStrip>` a sub-page
   * lifts the callback into always reflects the same window the chart paints.
   *
   * Mini mode never reports — the rationale card pins its own window and has
   * no stat strip. The dashboard / ad-hoc mounts simply omit the callback.
   */
  onVisibleStats?: (stats: Record<string, MetricWindowStats> | null) => void;
  /**
   * v1.12.8 — optional leading glyph for the chart card's `<TileHeader>`.
   * When supplied, the chart header renders the canonical icon + title row
   * (same size + spacing as every other Insights tile) instead of the bare
   * `<h2>`. Omitted on the dashboard / mini mounts, which keep the compact
   * heading. Accepts any component that takes a `className` (the contract
   * `<TileHeader>` and the stat strip's `icon` already use), so a page can
   * thread the same glyph it hands the stat strip.
   */
  titleIcon?: ComponentType<{ className?: string }>;
  /**
   * v1.16.0 — fires once the chart's data query has settled (initial
   * load finished, success or error). The dashboard's shared reveal
   * gate listens here so every chart cell swaps from skeleton to
   * content in one frame instead of popping in one after another.
   * Optional and repeat-safe: the dashboard's `markReady` is
   * idempotent; non-dashboard mounts simply omit it.
   */
  onDataReady?: () => void;
  /**
   * v1.18.6 — pre-fetched daily series, keyed by `MeasurementType`. When
   * the dashboard batches every visible chart's series into ONE
   * `/api/measurements/series-batch` round-trip (audit finding #2), it
   * passes each chart its slice here. When supplied, the chart's queryFn
   * consumes these rows for the covered types instead of issuing its own
   * per-type `/api/measurements` fetch. Omitted on non-dashboard mounts
   * (insights sub-pages, mini cards) which keep self-fetching.
   * SLEEP_DURATION is never pre-fetched (it rides the per-night `/series`
   * adapter), so a sleep chart self-fetches that branch regardless.
   *
   * The rows must already be scoped to the chart's active fetch window;
   * the prop is keyed into the query cache so a range-tab change (wider
   * window) re-fetches cleanly rather than blending a batched slice with
   * a self-fetched one.
   */
  preloadedSeries?: Record<string, MeasurementApiRow[]>;
  /**
   * v1.19.0 — the day-span the `preloadedSeries` slice actually covers
   * (the window the dashboard's batched fetch requested). The chart reads
   * the preloaded slice ONLY when the active range tab's window fits
   * within this coverage; a wider tab (90 / All on a 30-day batch) falls
   * through to a real fetch for the requested window instead of silently
   * re-rendering the narrow batched slice.
   *
   * Required whenever `preloadedSeries` is supplied. Mount sites set it to
   * the exact day-span their batch fetches (the dashboard batch spans 31
   * days). Omitted on self-fetching mounts.
   */
  preloadedCoverageDays?: number;
  /**
   * Render the drawn points as a table beneath the chart, behind a
   * collapsed disclosure. Opt-in: the metric sub-pages want it (a chart
   * shows the shape and hides the numbers, and an appointment needs the
   * numbers), the dashboard tiles do not — a table under every tile would
   * bury the dashboard it is meant to summarise.
   */
  showDataTable?: boolean;
}

interface ChartDataPoint {
  date: string;
  timestamp: number;
  pointIndex?: number;
  // v1.8.5 — `${type}__range` keys carry a `[min, max]` tuple for the
  // range-band <Area>; every other key stays a scalar.
  [key: string]: string | number | undefined | [number, number];
}

interface MeasurementApiRow {
  measuredAt: string;
  value: number;
  // v1.8.5 — per-day min / max emitted by the rollup daily-aggregate
  // path (non-cumulative metrics only). Drive the Apple-Health-style
  // range band shaded around the mean line. Absent on the raw-row path
  // (windows ≤ 7 days) and on cumulative metrics.
  // v1.18.6 — `null` accepted alongside `undefined` so the batched
  // series endpoint's row shape (which carries `number | null`) feeds
  // `preloadedSeries` directly. The bucketing loop already guards each
  // with a `typeof … === "number"` check, so a null is ignored exactly
  // like an absent value.
  minValue?: number | null;
  maxValue?: number | null;
  // v1.4.43 W2-CHART-GATE — the rollup / daily-aggregate paths return
  // the underlying raw-row count per bucket. Used downstream to gate
  // the "more days needed" empty-state copy on the actual measurement
  // count rather than the number of distinct calendar days. Optional
  // because the short-window raw-row path does not populate it (each
  // row already represents one measurement, count = 1).
  count?: number;
}

interface VisibleTargetZone {
  key: string;
  low: number;
  high: number;
  topPct: number;
  heightPct: number;
  color: string;
  opacity: number;
  label: string | undefined;
  textColor: string | undefined;
  lineOpacity: number;
}

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

function getTypeLabel(
  type: string,
  valueMode: "raw" | "bmi",
  t: (key: string) => string,
): string {
  if (type === "WEIGHT" && valueMode === "bmi") {
    return "BMI";
  }
  const key = BASE_TYPE_LABEL_KEYS[type];
  return key ? t(key) : type;
}

/**
 * Build a `YYYY-MM-DD` day-key formatter pinned to the requested
 * timezone. Memoised per-tz inside the component so we don't allocate a
 * new `Intl.DateTimeFormat` on every measurement-row pass.
 */
function makeDayKeyFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function toDayKey(value: string, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Could not derive day key for chart");
  }

  return `${year}-${month}-${day}`;
}

function dayKeyToTimestamp(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

function movingAverageByPoints(
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
 * v1.4.16 B1a — personal-baseline helper.
 *
 * Computes the median (50th-percentile) value of a daily-aggregated
 * series, capped at the most-recent 90 daily points (Apple Health uses
 * the rolling-90-day window for "your normal" framing). Returns `null`
 * when fewer than 5 points exist — a baseline drawn off 1-2 readings is
 * misleading; surface nothing instead.
 *
 * Pure & deterministic so the unit test pins exact medians.
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
 * v1.4.20 phase B4 — pure helper that maps storyboard annotations to
 * visible chart pointIndex positions. Exported so the unit suite can
 * pin behaviour without rendering Recharts. Returns the subset of
 * annotations that fall on (or within 7 days of) a visible bucketed
 * point, with a 24-char truncation precomputed for `<sm` rendering.
 */
export interface ResolvedAnnotation {
  pointIndex: number;
  label: string;
  color: string;
  truncatedLabel: string;
}

/**
 * v1.4.25 W6 — pure helper for the GLP-1 injection-day vertical
 * markers. Exported so the unit suite can pin behaviour without
 * spinning Recharts. The shape mirrors `resolveAnnotationPositions`
 * minus the truncated-label slot.
 *
 * `chartData[i].date` is the `YYYY-MM-DD` day-key the chart already
 * computed when bucketing measurements; we match by exact key so a
 * marker only lands on a day the chart actually has a data point for.
 * This is intentional — drawing a vertical line through a gap in the
 * x-axis paints a hanging line with no data context, which reads as a
 * rendering bug not as orientation.
 *
 * Off-window markers silently drop (the chart's `<ReferenceLine>` also
 * uses `ifOverflow="discard"` as a belt-and-braces guard).
 */
export interface ResolvedVerticalMarker {
  pointIndex: number;
  color: string;
  label: string | undefined;
}

export function resolveVerticalMarkerPositions(
  markers: Array<{ date: string; label?: string; color?: string }> | undefined,
  chartData: Array<{ date: string }> | undefined,
): ResolvedVerticalMarker[] {
  if (!markers || !chartData || chartData.length === 0) return [];
  const indexByDate = new Map<string, number>();
  for (const [i, point] of chartData.entries()) {
    // Last-write-wins — multiple bucket-aggregated points should never
    // share the same day key, but defensively keep the latest if they
    // do.
    indexByDate.set(point.date, i);
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
    // Drop annotations more than 7 days off any visible point — long
    // bucket windows (monthly aggregation) would otherwise snap multi-
    // month events to the closest visible bucket and stack labels.
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

function buildTrendSeriesByTime(data: Array<{ date: Date; value: number }>): {
  points: Array<{ date: Date; value: number }>;
  slopePerDay: number;
} | null {
  if (data.length < 2) return null;

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const startTime = sorted[0].date.getTime();
  const points = sorted.map((p) => ({
    x: (p.date.getTime() - startTime) / 86400000,
    y: p.value,
  }));

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return {
    points: sorted.map((p) => ({
      date: p.date,
      value:
        Math.round(
          (intercept + slope * ((p.date.getTime() - startTime) / 86400000)) *
            100,
        ) / 100,
    })),
    slopePerDay: slope,
  };
}

export function HealthChart({
  types,
  title,
  colors = ["var(--chart-1)", "var(--chart-3)", "var(--chart-4)"],
  unit,
  yAxisUnit,
  valueMode = "raw",
  yAxisWidth = 76,
  showYAxisUnit = true,
  valueBands,
  targetZones,
  mini = false,
  windowOverride,
  compareBaseline = "none",
  chartKey,
  annotations,
  verticalMarkers,
  userTimezone = "Europe/Berlin",
  valueScale = 1,
  valueOffset = 0,
  onVisibleStats,
  titleIcon,
  onDataReady,
  preloadedSeries,
  preloadedCoverageDays,
  showDataTable = false,
}: HealthChartProps) {
  const { isAuthenticated, user } = useAuth();
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  // Issue #490 — x-axis tick + tooltip date labels. Every timestamp this
  // chart formats encodes a CALENDAR DAY (noon-UTC of a profile-tz day
  // key, or a `bucketTimeSeries` Berlin-day UTC-midnight bucket start),
  // so labels render UTC-pinned via `makeBucketLabelFormatters` — the
  // encoded day paints verbatim in every profile zone. Rendering these
  // encodings through a profile-tz formatter shifted week/month bucket
  // labels a day/month back for zones west of Berlin. Day-key BUCKETING
  // below still uses `userTimezone` — only labels are pinned.
  // Issue #922 — the UTC pin decides WHICH day the label names; the
  // profile's date order decides how it is spelled. Both travel.
  const dateFormat = useDateFormatPreference();
  const tzFmt = useMemo(
    () => makeBucketLabelFormatters(locale, dateFormat),
    [locale, dateFormat],
  );
  // v1.4.25 W7b — per-row day-key formatter used to bucket measurement
  // rows by the user's local calendar day. Memoised on userTimezone so
  // the inner per-row loop reuses a single Intl.DateTimeFormat.
  const dayKeyFormatter = useMemo(
    () => makeDayKeyFormatter(userTimezone),
    [userTimezone],
  );
  // v1.4.16 B5c: when a windowOverride is supplied, seed the range
  // state from it so the chart pins to that window. Mini mode also
  // hides the range tabs, so the user can't change it.
  const initialRangePoints = windowOverride
    ? resolveMiniRangePoints(windowOverride)
    : 30;
  const [rangePoints, setRangePoints] = useState(initialRangePoints);

  // v1.4.18 — three overlay toggles (showTrendIndicator / showTrendArrow
  // / showTargetRange) are persisted per chart via the new
  // `useChartOverlayPrefs` hook. When the chart isn't bound to a
  // persistent key (mini mode / ad-hoc render) the hook short-circuits
  // to the clean-line default and skips its dashboard-layout fetch.
  const overlayPrefs = useChartOverlayPrefs(chartKey);
  const showMA = overlayPrefs.prefs.showTrendIndicator;
  const showTrend = overlayPrefs.prefs.showTrendArrow;
  const showBands = overlayPrefs.prefs.showTargetRange;
  const effectiveCompareBaseline = chartKey
    ? overlayPrefs.prefs.comparisonBaseline
    : compareBaseline;

  // v1.30.1 M2 — hydrate the range tab from the persisted prefs once
  // they arrive, mirroring the overlay toggles above. A plain
  // `useState(30)` initializer can't see the persisted value because
  // the dashboard-layout query resolves after mount; `rangePoints` also
  // drives several derived memos below by identity, so it stays local
  // state (unlike the toggles, which read `overlayPrefs.prefs` live)
  // and is synced in exactly once. `windowOverride` charts (mini mode)
  // are pinned and never adopt a persisted range. Adjusted during
  // render (React's documented "adjust state during render" escape
  // hatch, not an effect — the lint rule that bans ref reads during
  // render is why this is a second piece of state rather than a ref)
  // so the very first render that sees the resolved prefs already
  // reflects them; `rangeHydrated` guards against re-running past the
  // first hit, so a later cache refetch can't stomp a range the user
  // already picked this session.
  const [rangeHydrated, setRangeHydrated] = useState(false);
  if (
    !windowOverride &&
    chartKey &&
    !rangeHydrated &&
    typeof overlayPrefs.prefs.rangePoints === "number"
  ) {
    setRangeHydrated(true);
    setRangePoints(overlayPrefs.prefs.rangePoints);
  }

  // v1.4.19 A2 — viewport-aware tick density. Recharts' default is one
  // tick per data point; the helper caps that at 4-10 visible labels
  // depending on viewport width so the X-axis reads consistently across
  // every chart card.
  const viewportWidth = useViewportWidth();

  // v1.36.1 — `useAuth()` answers about the person at the keyboard, and under a
  // switch that is the delegate. Dividing the OWNER's weights by the
  // DELEGATE's height squared produces a plausible-looking BMI that is simply
  // somebody else's, shaded by fixed category bands, on a page that names the
  // owner. The same substitution was fixed for the reference bands in this
  // release; this is the same mistake one component over, and a wrong health
  // figure is worse than an absent one.
  //
  // Inside a shared record the chart therefore draws no BMI at all rather than
  // a wrong one. Publishing the owner's height to every client that can read
  // their weights is a bigger decision than this fix, and it belongs with the
  // per-module scope work rather than here.
  const { inSharedRecord } = useRecordCapabilities();
  const bmiDivisor =
    valueMode === "bmi" && !inSharedRecord && user?.heightCm
      ? (user.heightCm / 100) ** 2
      : null;

  // v1.4.28 FB-D2 (R1.2 H0) — derive a bounded date window from the
  // active range selector so the chart fetches only what it will
  // actually render. The legacy `while (true)` paginated walk pulled
  // tens of thousands of pulse rows on every visit; the bounded
  // window + the server-side aggregation hint keeps every navigation
  // payload-flat regardless of underlying density.
  //
  // Comparison overlays (lastMonth / lastYear) extend the `from`
  // boundary backwards by the shift distance so the prior-period
  // slice rides the same fetch and `shiftDailySeriesForward` finds
  // its input.
  //
  // v1.19.0 — "All" range (rangePoints === 0) requests `ALL_RANGE_DAYS`
  // (~10 years) rather than the old 365-day cap, which silently truncated
  // any account holding more than a year of history. The window is a
  // generous fixed bound (not derived per-account) so the cache key stays
  // stable across the session.
  //
  // v1.19.2 — the server reader steps the bucket tier up to WEEK / MONTH
  // for windows past the DAY cap, so the "All" tab now returns coverage
  // across the whole history (downsampled by tier) rather than the most
  // recent ~365 daily buckets. The client folds those coarse buckets and
  // `bucketTimeSeries` re-buckets to the visible range as before.
  const fetchWindow = useMemo(() => {
    const to = new Date();
    const windowDays = rangePoints > 0 ? rangePoints : ALL_RANGE_DAYS;
    const compareShift =
      effectiveCompareBaseline === "lastMonth"
        ? 30
        : effectiveCompareBaseline === "lastYear"
          ? 365
          : 0;
    const totalDays = windowDays + compareShift;
    const from = new Date(to.getTime() - totalDays * 86_400_000);
    // Use ISO strings so the cache key is stable across the day; the
    // server treats `to` as the upper bound and the chart re-applies the
    // same day window client-side (see `visibleSlice`).
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      windowDays: totalDays,
    };
  }, [rangePoints, effectiveCompareBaseline]);

  // v1.18.6 — honour the dashboard's batched slice ONLY for the
  // daily-aggregate window (`windowDays > 7`, the rollup path) and ONLY
  // when EVERY non-sleep type the chart renders is present in the slice.
  // SLEEP_DURATION is never batched (per-night `/series`), so a chart
  // that includes it always self-fetches. A range-tab change to a ≤7-day
  // window (raw rows) drops batched coverage and self-fetches.
  //
  // v1.19.0 — also require that the requested window FITS within the
  // batch's actual coverage. The dashboard batches only a ~30-day slice;
  // pre-fix, picking the 90 / All tab kept reading that 30-day slice
  // (`usePreloaded` never compared windows), so the chart showed ~30 days
  // no matter the tab. The mount now threads `preloadedCoverageDays`; a
  // tab wider than the coverage falls through to a real fetch for the
  // requested window. Without an explicit coverage (legacy mount), treat
  // it as 0 so any preloaded slice is bypassed rather than trusted blindly.
  const usePreloaded = useMemo(() => {
    if (!preloadedSeries) return false;
    if (fetchWindow.windowDays <= 7) return false;
    const coverage = preloadedCoverageDays ?? 0;
    if (fetchWindow.windowDays > coverage) return false;
    return types.every(
      (type) => type === "SLEEP_DURATION" || preloadedSeries[type] != null,
    );
  }, [preloadedSeries, preloadedCoverageDays, fetchWindow.windowDays, types]);

  const { data, isLoading, isError, isPlaceholderData, refetch } = useQuery({
    // A range-tab change re-keys the query; without placeholder data every
    // switch dropped the painted chart to a skeleton for the fetch round-trip.
    // Keeping the previous range's series visible is only honest because the
    // render below pairs it with a visual dimming while `isPlaceholderData`
    // is true — the old range must never masquerade as the new one.
    placeholderData: keepPreviousData,
    // v1.4.40 W-RSC — route the chart-data key through `queryKeys.chartData`
    // so the `["chart-data"]` prefix lands in `measurementDependentKeys`
    // and a fresh measurement evicts every per-chart daily cache in one
    // pass (audit C2). The factory-packed tuple is byte-identical with
    // the pre-v1.4.40 inline literal so the cache layout stays stable.
    // v1.15.20 — BMI is a pure transformation of the WEIGHT series
    // (value / height²), so the BMI view shares the raw series' cache
    // entry instead of re-fetching the same window under its own key.
    // The key pins the literal "raw" / "no-bmi" discriminators (the
    // factory tuple shape is unchanged) and the BMI division happens in
    // the `select` callback below — the factory rule stays intact and
    // the cached data is mode-agnostic.
    queryKey: queryKeys.chartData(
      types.join(","),
      "raw",
      "no-bmi",
      // v1.4.25 W7b — bucket keys + tick labels depend on the active
      // user timezone, so re-key the cache when it changes. Without
      // this, a tz change inside a session would render stale buckets.
      userTimezone,
      // v1.4.28 FB-D2 — bound the cache by the active fetch window so
      // a range-tab change re-fetches the right slice rather than
      // re-running the unbounded walk.
      fetchWindow.from,
      fetchWindow.to,
      // v1.7.0 — re-key when the display scale changes so a km/h chart
      // never reads a m/s-scaled sibling out of the cache.
      valueScale,
      // v1.18.6 — discriminate a batched-slice render from a self-fetch
      // ONLY on the dashboard mounts that pass `preloadedSeries`. When the
      // prop is absent (insights sub-pages, mini cards) the empty string
      // keeps the factory tuple byte-identical with the pre-v1.18.6
      // 8-element key, so those callers' cache layout is unchanged. On a
      // dashboard mount the discriminator flips "preloaded" → "fetch" when
      // a range-tab change drops batched coverage, re-fetching cleanly.
      preloadedSeries ? (usePreloaded ? "preloaded" : "fetch") : "",
    ),
    // v1.4.28 FB-D2 — cache the bounded window for a minute so tab
    // navigation between insights sub-pages does not re-fire every
    // chart's fetch. `gcTime` keeps the inactive cache for five
    // minutes so a quick back-and-forth doesn't repay the cost.
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async () => {
      const dailyAggregates = new Map<
        string,
        {
          timestamp: number;
          values: Record<
            string,
            {
              sum: number;
              count: number;
              // v1.8.5 — per-bucket spread for the range band. Seeded
              // from the rollup daily-aggregate's min / max columns;
              // null when the API row carries no spread (raw-row path
              // or cumulative metric).
              min: number | null;
              max: number | null;
            }
          >;
        }
      >();

      // v1.11.5 — SLEEP_DURATION is stored one row per sleep STAGE per night
      // (minutes). The generic `/api/measurements` daily-aggregate path
      // averages those stage rows, which neither sums a night nor isolates
      // the asleep stages — it surfaced a ~2× inflated, mislabeled chart. The
      // `/api/measurements/series?kind=sleep` adapter reconstructs ONE point
      // per night carrying the night's TIME-ASLEEP in HOURS (CORE + DEEP + REM,
      // bare-ASLEEP only when no granular stage exists, IN_BED + AWAKE
      // excluded, dual-source nights collapsed to one source). Routing the
      // sleep chart through it keeps every sleep surface on the same
      // reconstruction. One point per night → `sum/count` yields the night's
      // hours unchanged.
      async function fetchSleepNights() {
        const sleepParams = new URLSearchParams();
        sleepParams.set("kind", "sleep");
        // The series route caps sleep at 365 days regardless; clamp the
        // request so a longer comparison window still resolves.
        sleepParams.set(
          "days",
          String(
            Math.max(1, Math.min(3650, Math.ceil(fetchWindow.windowDays))),
          ),
        );
        // v1.16.8 — a failed fetch rejects the whole query instead of
        // silently resolving an empty series: the swallowed-catch
        // variant cached the empty result as fresh success, so an
        // outage painted "no data in this range" with no retry path.
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
        const typeParams = new URLSearchParams();
        typeParams.set("type", type);
        typeParams.set("sortBy", "measuredAt");
        typeParams.set("sortDir", "asc");
        typeParams.set("from", fetchWindow.from);
        typeParams.set("to", fetchWindow.to);
        typeParams.set("limit", "5000");
        // v1.4.29 C3 — windows over 7 days ask the server to bucket
        // daily. Caps the chart's per-type payload at ~365 rows
        // instead of ~5 000 for high-density types (pulse), and drops
        // Recharts paint cost ~50× on continuous-monitoring accounts.
        // Short windows keep raw fetching so hour-by-hour detail
        // stays visible.
        //
        // v1.4.36 W1 — also route the daily aggregate through the
        // persistent rollup buckets via `source=rollup`. The route
        // reads from `measurement_rollups` instead of running a live
        // `date_trunc` scan over the raw measurements table; the
        // three parallel daily fetches on the Insights trends row
        // (BP_SYS / BP_DIA / WEIGHT) drop from ~3 s each to a small
        // indexed read against the ~5 k-row rollup table. The server
        // falls back to live SQL when the rollup is empty for the
        // requested window so brand-new accounts still see a chart
        // on their first render.
        //
        // v1.19.2 — the `aggregate=daily` ask still holds, but for windows
        // wider than the DAY bucket cap the server steps the rollup tier
        // up to WEEK / MONTH and returns whole-history coverage at that
        // tier. Each returned row is one coarse bucket; the daily fold +
        // `bucketTimeSeries` below downsample it to the visible range, so
        // the request contract is unchanged.
        if (fetchWindow.windowDays > 7) {
          typeParams.set("aggregate", "daily");
          typeParams.set("source", "rollup");
        }

        // v1.18.6 — when the dashboard handed this chart a batched slice
        // for the type, fold those rows instead of a per-type fetch. The
        // rows came from `/api/measurements/series-batch`, which reads
        // through the SAME rollup path the per-type daily fetch hits, so
        // the bucketed result is byte-identical. `usePreloaded` already
        // gated the window (`> 7`) + per-type coverage above; default to
        // an empty slice (paints the no-data card) rather than fetching,
        // so a covered chart never issues a network request.
        const page =
          usePreloaded && preloadedSeries
            ? (preloadedSeries[type] ?? [])
            : await (async () => {
                // v1.16.8 — a failed per-type fetch rejects the whole
                // query instead of silently dropping the series: the
                // swallowed-catch variant cached the partial/empty result
                // as fresh success, so an outage painted the empty state
                // (or a half chart) with no retry path. Rejecting lets
                // TanStack's retry semantics and the in-card error state
                // below do their jobs.
                const data = await apiGet<{
                  measurements?: MeasurementApiRow[];
                }>(`/api/measurements?${typeParams}`);
                return data?.measurements ?? [];
              })();

        for (const measurement of page) {
          // v1.7.0 — fold the display-time scale into the raw value at
          // the single read boundary so bucketing, the y-domain, the
          // personal baseline, the trend, and the tooltip all operate
          // on the scaled series uniformly. `valueScale` defaults to 1
          // (identity), so non-unit-fixed charts read byte-identical.
          // v1.15.20 — the BMI division moved into the query's `select`
          // callback so the cached series stays raw and the WEIGHT and
          // BMI views share one cache entry.
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
          // v1.8.5 — carry the rollup bucket's min / max through when the
          // API supplies them (daily-aggregate path, non-cumulative).
          // `valueScale` already folded into `value` above; apply the
          // same scale to the spread so the band tracks the line. The
          // BMI view drops the range tuple in its `select` callback (it
          // has never rendered the band), so the raw cache always
          // carries the spread.
          if (
            typeof measurement.minValue === "number" &&
            typeof measurement.maxValue === "number"
          ) {
            const scaledMin = measurement.minValue * valueScale + valueOffset;
            const scaledMax = measurement.maxValue * valueScale + valueOffset;
            current.min =
              current.min === null
                ? scaledMin
                : Math.min(current.min, scaledMin);
            current.max =
              current.max === null
                ? scaledMax
                : Math.max(current.max, scaledMax);
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
            // v1.4.29.1 — cumulative HealthKit types (steps, active energy,
            // distance, flights, daylight) must reduce with sum, not the
            // per-sample average. The server already does this when the
            // chart fetches with `aggregate=daily` (windows over 7 days);
            // the 7-day path still pulls raw rows and aggregates here,
            // so the same distinction must hold client-side.
            const isCumulative = CUMULATIVE_HK_TYPES.has(
              type as MeasurementType,
            );
            point[type] = isCumulative ? stats.sum : stats.sum / stats.count;
            // v1.8.5 — emit the day's spread as a `[min, max]` tuple key
            // so the range-band <Area> can shade it. Only when the
            // rollup supplied both bounds and the metric is not
            // cumulative (a SUM has no meaningful intra-day spread).
            if (!isCumulative && stats.min !== null && stats.max !== null) {
              point[`${type}__range`] = [stats.min, stats.max] as never;
            }
          }

          return point;
        })
        .sort((a, b) => a.timestamp - b.timestamp);

      return allData;
    },
    // v1.15.20 — BMI view: transform the cached raw WEIGHT series into
    // BMI at read time. The transformation lives in `select` (not the
    // queryFn) so the cache entry stays raw and is shared with the
    // weight chart; tanstack re-runs the projection without a refetch.
    // No height on the profile → empty series (matches the previous
    // behaviour where every point was skipped). The `${type}__range`
    // tuples are dropped — the BMI view has never rendered the band.
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
    enabled: isAuthenticated,
  });

  // v1.16.0 — report the settled data query to the dashboard's shared
  // reveal gate. `isLoading` only covers the INITIAL fetch (a later
  // range-tab change creates a new cache entry but the gate has long
  // latched by then), so this fires exactly when the first paintable
  // state — chart, empty-window card, or error fallback — is available.
  //
  // v1.20.1 — fire exactly once, gated on a ref rather than on the
  // `onDataReady` prop identity. The dashboard passes an inline
  // `() => markChartReady(id)` closure, so `onDataReady` is a NEW
  // reference on every parent render; keying the effect on it re-ran the
  // notify on every commit (e.g. a snapshot refetch on tab-resume), and
  // that per-commit passive effect kept the chart-row's Radix-Popper
  // anchors re-committing until React tripped its update-depth guard
  // (#185). The ready signal is monotonic — once a chart has settled it
  // stays settled — so latch it behind a ref and depend on `isLoading`
  // alone. `onDataReady` is read through a ref so a late-arriving handler
  // still fires without re-arming the effect.
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

  // v1.4.6: aggregate to weekly / monthly when the visible range is
  // long enough that drawing every daily point would clutter the
  // chart. Picking the bucket from the *visible* range, not the
  // total dataset, so a "30 days" toggle still shows daily even on
  // a five-year-old account.
  //
  // Held in its own memo so the grain has ONE source. `chartData` bucket
  // by it, and the data table below the chart captions its rows with it —
  // a table that said "daily" over a weekly mean would be a lie, and
  // recomputing the decision separately is how that lie starts.
  //
  // v1.37.29 — the slice is a CALENDAR-DAY window, matching what the
  // range tabs promise and what the fetch window requests. The previous
  // `slice(-rangePoints)` was a no-op on the self-fetched path (the fetch
  // is already bounded to the window) but silently switched to
  // "last N readings" on the dashboard's preloaded ~30-day batch slice —
  // the same tab meant two different things depending on the mount path.
  const visibleSlice = useMemo(() => {
    if (!data?.length) return null;
    const cutoff = new Date().getTime() - rangePoints * 86_400_000;
    const sliced =
      rangePoints > 0
        ? data.filter((point) => point.timestamp >= cutoff)
        : [...data];
    // An empty window stays an empty slice (renders as "no data in this
    // range") — returning null here would drop chartData back to the
    // UNFILTERED series and quietly widen the window instead.
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

    const { sliced, bucketType } = visibleSlice;

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
            const existing = enriched.find(
              (d) => d.timestamp === pointTimestamp,
            );
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
          const trend = buildTrendSeriesByTime(typeData);
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
  }, [data, visibleSlice, showMA, showTrend, types, tzFmt, userTimezone]);

  // v1.12.8 — chart-reactive metric statistics.
  //
  // Compute the per-type Min / Max / Median / Mean over the data currently
  // visible under the active range tab — i.e. the day-window-filtered,
  // bucketed `chartData` the chart already holds (no re-fetch). The result
  // recomputes whenever the range tab changes the visible slice, so the
  // `<MetricStatStrip>` a sub-page lifts the callback into always reflects the
  // same window the chart paints. Skipped in mini mode (no stat strip).
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

  // Report the visible-range stats up to the sub-page so the shared
  // `<MetricStatStrip>` can read them. Effect (not render-time call) so the
  // parent state update never fires during this component's render.
  useEffect(() => {
    if (mini) return;
    onVisibleStats?.(visibleStatsByType);
  }, [mini, visibleStatsByType, onVisibleStats]);

  // v1.4.16 phase B8 — comparison overlay.
  //
  // When the toggle is active, derive a prior-period series from the
  // ALREADY-FETCHED daily aggregates (`data`), shift the timestamps
  // forward by 30 / 365 days, and stamp the values into the visible
  // `chartData` under `${type}_compare` keys. The Recharts <Line>
  // children below render those keys as dimmed dashed lines beneath
  // the current series, and the tooltip picks them up so the user can
  // read both numbers + the delta in one place.
  //
  // The merge is point-equal-day: a prior-period point only paints
  // when its shifted timestamp lands on a visible day. Sparse prior
  // periods are silently dropped (the chart's empty caption surfaces
  // "Comparison unavailable — no data from last month yet" via the
  // hasComparisonData flag below).
  const chartDataWithCompare = useMemo(() => {
    if (!chartData || effectiveCompareBaseline === "none") return chartData;
    if (!data?.length) return chartData;

    const shifted = shiftDailySeriesForward(
      data.map((row) => ({
        timestamp: row.timestamp,
        values: Object.fromEntries(
          types.map((type) => [type, row[type] as number | undefined]),
        ),
      })),
      effectiveCompareBaseline,
    );

    // Index shifted rows by the same day-key the chart already uses.
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
  }, [chartData, effectiveCompareBaseline, data, types, tzFmt]);

  /**
   * v1.4.16 phase B8 — true when at least one visible day has a prior-
   * period value to overlay. Drives the "Comparison unavailable" caption
   * fallback in the chart header. Empty input → false → caption shows;
   * a partial overlay (some days have prior data, some don't) is treated
   * as "available" so we don't surprise the user with a missing caption
   * when they can clearly see SOME dimmed history.
   */
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

  // v1.37.29 — the header chip reads the SAME grain decision `chartData`
  // and the data table use. This was a second memo re-deriving the bucket
  // from a `slice(-rangePoints)` of its own — exactly the "recomputing
  // the decision separately" drift the visibleSlice doc-comment warns
  // about, and the two had already diverged on the windowing semantics.
  const activeBucket: ChartBucketType = visibleSlice?.bucketType ?? "day";

  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (!chartDataWithCompare?.length) return undefined;

    const keys = [...types];
    if (showMA) keys.push(...types.map((type) => `${type}_ma`));
    if (showTrend) keys.push(...types.map((type) => `${type}_trend`));
    // v1.4.16 phase B8 — extend the y-domain to fit the prior-period
    // overlay. Without this the dimmed line can clip outside the
    // visible range when last-month / last-year had a different scale.
    if (effectiveCompareBaseline !== "none") {
      keys.push(...types.map((type) => `${type}_compare`));
    }

    const values = chartDataWithCompare
      .flatMap((point) => keys.map((key) => point[key]))
      .filter((value): value is number => typeof value === "number")
      .filter((value) => Number.isFinite(value));

    return computePaddedYDomain(values, types);
  }, [
    chartDataWithCompare,
    effectiveCompareBaseline,
    showMA,
    showTrend,
    types,
  ]);

  const visibleBands = useMemo(() => {
    if (!showBands || !valueBands?.length || !yDomain) return [];

    const [domainMin, domainMax] = yDomain;
    const span = domainMax - domainMin;
    if (!Number.isFinite(span) || span <= 0) return [];

    return valueBands
      .map((band, index) => {
        const low = Math.max(Math.min(band.min, band.max), domainMin);
        const high = Math.min(Math.max(band.min, band.max), domainMax);
        if (high <= low) return null;

        const topPct = ((domainMax - high) / span) * 100;
        const heightPct = ((high - low) / span) * 100;

        return {
          key: `${band.min}-${band.max}-${index}`,
          topPct,
          heightPct,
          color: band.color,
          opacity: band.opacity ?? 0.2,
          strokeOpacity: band.strokeOpacity ?? 0.35,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          key: string;
          topPct: number;
          heightPct: number;
          color: string;
          opacity: number;
          strokeOpacity: number;
        } => entry !== null && entry.heightPct > 0,
      );
  }, [showBands, valueBands, yDomain]);

  const visibleTargetZones = useMemo<VisibleTargetZone[]>(() => {
    if (!showBands || !targetZones?.length || !yDomain) return [];
    const [domainMin, domainMax] = yDomain;
    const span = domainMax - domainMin;
    if (!Number.isFinite(span) || span <= 0) return [];

    const zones: Array<{
      key: string;
      low: number;
      high: number;
      topPct: number;
      heightPct: number;
      color: string;
      opacity: number;
      label: string | undefined;
      textColor: string | undefined;
      lineOpacity: number;
    }> = [];

    for (const [index, zone] of targetZones.entries()) {
      const low = Math.max(Math.min(zone.min, zone.max), domainMin);
      const high = Math.min(Math.max(zone.min, zone.max), domainMax);
      if (high <= low) continue;
      const topPct = ((domainMax - high) / span) * 100;
      const heightPct = ((high - low) / span) * 100;

      zones.push({
        key: `${zone.min}-${zone.max}-${index}`,
        low,
        high,
        topPct,
        heightPct,
        color: zone.color,
        opacity: zone.opacity ?? 0.3,
        label: zone.label ?? undefined,
        textColor: zone.textColor ?? undefined,
        lineOpacity: zone.lineOpacity ?? 0.42,
      });
    }

    return zones;
  }, [showBands, targetZones, yDomain]);

  // v1.4.33 F10 — preserve one decimal when the visible Y-domain span is
  // narrow enough that two distinct gridlines would otherwise round to
  // the same integer (e.g. weight at 82.8 vs 83.5 both rendering as
  // "83 kg"). The threshold matches the body-composition cluster: any
  // domain spanning < 6 units gets `0.1`-precision ticks; wider domains
  // keep the integer formatter so BP / glucose / steps stay clean.
  const yDomainSpan = yDomain ? yDomain[1] - yDomain[0] : null;
  const useDecimalAxis = yDomainSpan !== null && yDomainSpan < 6;
  const formatAxisValue = (value: number) =>
    useDecimalAxis ? fmt.number(value, 1) : fmt.integer(value);

  const formatTooltipValue = (value: number) => fmt.number(value, 1);

  // Accessibility — a concise spoken summary of the primary series so a screen
  // reader announces the shape of the chart (range, latest value, direction)
  // instead of an unlabelled graphic. Mirrors the visible-range stats the
  // chart already holds; falls back to the raw min/max when the stat strip
  // is suppressed (mini mode).
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

  // Columns for the data table below the chart: one per series the chart
  // actually drew a value for, labelled by the SAME helper that names the
  // Recharts <Line>, so a header and a legend entry can never disagree. A
  // type with no value anywhere in the visible window gets no column — a
  // column of dashes states nothing the chart's own empty line does not.
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

        // v1.4.16 Fix A8b — delegate to the pure helper so the long-
        // window split-half delta gets a unit-test that doesn't depend
        // on Recharts. See `src/lib/analytics/window-trend.ts`.
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

        // v1.4.16 Fix A8b: when the visible window is long (e.g. "All"
        // on a multi-year account), the per-week delta becomes vanishingly
        // small and rounds to ±0.0 in the formatter — the maintainer's complaint
        // "Wenn ich alle anklicke, dann wird einfach Null Veränderung
        // angezeigt" was exactly this: a slope of ~0.5 kg/year prints
        // as "+0.0 kg/week" and the user reads it as "no change". For
        // windows ≥ SPLIT_HALF_THRESHOLD_DAYS we additionally surface
        // the first-half vs. second-half mean delta — a single,
        // meaningful number that cannot round to zero unless the metric
        // truly didn't move.
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

  // v1.4.16 B1a — personal baseline (90-day rolling median) per type.
  // Painted as a faint dashed reference line labelled "Your normal" so
  // the user can read each point against their own baseline, not an
  // absolute value the chart axis happens to render.
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

  // v1.4.43 W11-M6 — keep the card shell mounted even when the loaded
  // payload is empty. Pre-fix the early `return null` here erased the
  // whole widget (header + range tabs + chart) and the user saw an
  // unexplained gap on the dashboard. The in-card render branch below
  // now paints a "no data in this range" empty state so the user
  // understands the chart loaded but the selected window holds no
  // measurements — distinct copy from the < 3-points "more days
  // needed" hint so the two situations don't blur.

  const maxPointIndex = Math.max(0, (chartData?.length ?? 1) - 1);

  // v1.4.20 phase B4 — derive visible annotations via the pure helper
  // (`resolveAnnotationPositions`). Drops anything outside the
  // visible window so the chart line + tooltip stay untouched.
  const annotationPositions = resolveAnnotationPositions(
    annotations,
    chartData,
  );

  // v1.4.25 W6 — GLP-1 injection-day vertical markers. Pure-helper
  // pattern lets the chart-tests pin the marker resolution without
  // mounting Recharts. Off-window markers silently drop here so the
  // <ReferenceLine> below never paints a line for an out-of-range
  // day.
  const verticalMarkerPositions = resolveVerticalMarkerPositions(
    verticalMarkers,
    chartData,
  );

  const showContextDetails = showMA || showTrend || showBands;
  const animationsEnabled = !prefersReducedMotion();

  // v1.4.16 B5c — mini mode tunes padding + margins so the chart fits
  // inside the rationale card without overwhelming the surrounding
  // rows. Range tabs + toggle row are suppressed entirely; the chart
  // pins to `windowOverride` (or the default 30pt) instead.
  const containerClass = mini
    ? "bg-card border-border rounded-md border p-2"
    : "bg-card border-border rounded-xl border p-4 md:p-6";
  // v1.4.27 MB7 / CF-43 — chart height now reads from a CSS variable
  // (`--chart-height`) so consumers can override the default per-mount
  // without re-styling the component. The `mini` branch keeps the
  // 140 px contract; the regular branch defaults to 240 px on mobile
  // and 280 px from `md:` upwards (the wider container can absorb a
  // taller chart without crowding the tile strip above).
  const chartHeightClass = mini
    ? "h-[var(--chart-height,140px)]"
    : "h-[var(--chart-height,240px)] md:h-[var(--chart-height-md,280px)]";

  return (
    <div className={containerClass} data-slot={mini ? "chart-mini" : undefined}>
      {!mini && (
        /* v1.4.19 A2 — mobile-first header layout.

           Pre-fix: title + bucket chip + comparison chip + 4 range tabs +
           cog all sat on a single justify-between flex row. On Pixel 5
           the chips ate enough horizontal space that the range tabs
           wrapped to a second row INSIDE that flex (header height
           jumped from 44 px → 92 px); on Galaxy Fold compact (280 px)
           the tabs split into 3-4 rows.

           Mobile (default): two stacked rows. Title + non-essential
           chips on row 1; range tabs + cog right-aligned on row 2.
           Bucket-aggregation + comparison chips hide entirely below
           `sm:` because they're decorative and the chart's range tabs
           already communicate the visible window. The cog dropdown
           stays accessible to surface those overlays explicitly.

           ≥sm: original side-by-side layout, all chips visible. */
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {/* v1.12.8 — when a `titleIcon` is supplied (every Insights
                metric subpage), the chart card leads with the canonical
                `<TileHeader>` (icon + title at `text-base`, foreground
                colour, h-5 w-5) so it matches the assessment / target /
                stat tiles. The dashboard / ad-hoc mounts omit the icon and
                keep the compact heading.

                That compact heading is an `<h2>`, not an `<h3>`. The card is
                a sibling of the other cards in the same grid, and those name
                themselves at the second level already — the dashboard's
                "Recent unlocks" and "Recent workouts" tiles both render
                `<TileHeader titleAs="h2">`, and the metric subpages' target /
                usual-range cards are `<h2>` too. Sitting one level lower made
                the chart card the odd one out AND skipped a level under the
                page `<h1>`: the dashboard's rendered ladder read h1 → h3 →
                h3 → h3 → h2 → h2, and /insights/bmi read h1 → h3 → h2. A
                heading level is a claim about nesting, and the chart card is
                not nested inside anything. */}
            {titleIcon ? (
              <TileHeader icon={titleIcon} title={title} />
            ) : (
              <h2 className="text-sm font-semibold">{title}</h2>
            )}
            {activeBucket !== "day" && (
              <span className="bg-muted/40 text-muted-foreground text-2xs hidden rounded-md px-1.5 py-0.5 font-medium tracking-wide uppercase sm:inline-flex">
                {t(
                  activeBucket === "week"
                    ? "charts.bucketWeekly"
                    : "charts.bucketMonthly",
                )}
              </span>
            )}
            {/* v1.4.16 phase B8 — comparison caption. Inline with the
                bucket-aggregation chip so the user reads "what window
                am I looking at" + "what comparison is overlaid" in one
                glance. The "Comparison unavailable" fallback uses
                neutral muted styling so it doesn't read as an error.

                v1.4.19 A2 — hidden on mobile to free up the title row. */}
            {effectiveCompareBaseline !== "none" && hasComparisonData && (
              <span
                className="text-dose-accent bg-dose-accent/10 text-2xs hidden rounded-md border border-current/30 px-1.5 py-0.5 font-medium tracking-wide uppercase sm:inline-flex"
                data-slot="chart-compare-caption"
              >
                {t(
                  effectiveCompareBaseline === "lastMonth"
                    ? "comparison.captionLastMonth"
                    : "comparison.captionLastYear",
                )}
              </span>
            )}
            {effectiveCompareBaseline !== "none" && !hasComparisonData && (
              <span
                className="text-muted-foreground bg-muted/40 text-2xs hidden rounded-md px-1.5 py-0.5 font-medium tracking-wide sm:inline-flex"
                data-slot="chart-compare-unavailable"
              >
                {t(
                  effectiveCompareBaseline === "lastMonth"
                    ? "comparison.unavailable.lastMonth"
                    : "comparison.unavailable.lastYear",
                )}
              </span>
            )}
            {/* v1.16.8 — the in-header "adjust targets" link is gone.
                The page-level target-adjust control in the sub-page
                header (`<TargetAdjustButton>`) owns the affordance; the
                chart card stays a read surface. */}
          </div>
          <div
            className="flex flex-nowrap items-center justify-end gap-1 self-end sm:self-auto"
            data-slot="chart-header-controls"
          >
            {TIME_RANGES_KEYS.map((r) => (
              <Button
                key={r.labelKey}
                variant={rangePoints === r.days ? "default" : "ghost"}
                aria-pressed={rangePoints === r.days}
                size="sm"
                className="min-h-11 px-2 text-xs sm:px-3"
                onClick={() => {
                  // v1.12.8 — a range-tab change re-slices `chartData`; the
                  // visible-range stats memo recomputes off the new slice and
                  // the stat strip follows automatically.
                  setRangeHydrated(true);
                  setRangePoints(r.days);
                  // v1.30.1 M2 — persist the pick per chart, same model
                  // as the overlay toggles, so the range survives a
                  // remount instead of resetting to 30 d every visit.
                  if (chartKey && !windowOverride) {
                    overlayPrefs.setPrefs({
                      ...overlayPrefs.prefs,
                      rangePoints: r.days,
                    });
                  }
                }}
                title={t(r.titleKey)}
                data-slot="chart-range-tab"
              >
                {t(r.labelKey)}
              </Button>
            ))}
            {/* v1.4.18 — overlay-controls dropdown anchored next to
                the range tabs. Only painted when the chart is bound
                to a persistent chartKey; ad-hoc usages keep the
                clean-line default. */}
            {chartKey ? (
              <ChartOverlayControls
                prefs={overlayPrefs.prefs}
                onChange={overlayPrefs.setPrefs}
                hasComparisonData={hasComparisonData}
              />
            ) : null}
          </div>
        </div>
      )}

      {mini && (
        <div className="text-muted-foreground text-2xs mb-1 font-medium tracking-wider uppercase">
          {title}
        </div>
      )}

      {!mini && showTrend && trendInfo.length > 0 ? (
        <div className="text-muted-foreground mb-3 flex flex-wrap gap-3 text-xs">
          {trendInfo.map((info) => (
            <span key={info}>{info}</span>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        // v1.16.0 — height-matched skeleton band instead of the former
        // `h-48` spinner box. The loading state now occupies the exact
        // box the painted chart will (same `chartHeightClass`), so the
        // card height never jumps when the data lands — the dashboard's
        // shared-reveal overlay and every insights mount stay
        // layout-shift-free.
        <Skeleton className={`w-full ${chartHeightClass}`} />
      ) : isError ? (
        // v1.16.8 — a failed query paints as an ERROR with a retry
        // affordance, not as the "no data in this range" empty state.
        // Pre-fix `isError` fell through to the empty branch and an
        // outage read as "you have no measurements".
        <ChartErrorState
          title={t("charts.errorTitle")}
          actionLabel={t("common.retry")}
          actionContext={title}
          onAction={() => void refetch()}
        />
      ) : !chartData?.length ? (
        // v1.4.43 W11-M6 — empty-window state.
        //
        // The chart only withholds rendering when the selected range
        // holds zero daily points. Any real data — even a single day —
        // renders the points below; a sparse-data caption (rather than
        // a withholding card) explains that more days fill out the
        // trend. The genuinely-empty window paints a distinct empty
        // state so the user reaches for the range tabs or the quick-add
        // instead of suspecting a broken widget.
        <ChartEmptyState
          title={t("charts.noDataInRangeTitle")}
          description={t("charts.noDataInRangeDescription")}
        />
      ) : (
        <>
          <div
            // The truth half of `placeholderData: keepPreviousData` above:
            // while the re-keyed range is still fetching, the previous
            // range's series stays painted but visibly dimmed and inert, so
            // it cannot masquerade as the new range.
            aria-busy={isPlaceholderData}
            className={`relative ${chartHeightClass} transition-opacity ${
              isPlaceholderData ? "pointer-events-none opacity-50" : ""
            }`}
          >
            {visibleBands.length > 0 ? (
              // v1.4.27 R3d MB2 — band overlay positioning fix. The
              // overlay used to inset `right: 18px` while the chart
              // margin is `right: 8`, so the band rectangle drifted left
              // of the plotted line by 10 px on every viewport. Pin the
              // overlay to the same right edge the ComposedChart uses so
              // the band tracks the line exactly.
              <div
                className="pointer-events-none absolute"
                style={{
                  left: `${8 + yAxisWidth}px`,
                  right: "8px",
                  top: "10px",
                  bottom: "32px",
                  zIndex: 0,
                }}
              >
                {visibleBands.map((band) => (
                  <div
                    key={band.key}
                    className="absolute right-0 left-0"
                    style={{
                      top: `${band.topPct}%`,
                      height: `${band.heightPct}%`,
                      backgroundColor: band.color,
                      opacity: band.opacity,
                      borderTop: `1px solid ${band.color}`,
                      borderBottom: `1px solid ${band.color}`,
                    }}
                  />
                ))}
              </div>
            ) : null}

            <div
              className="relative z-10 h-full touch-pan-y"
              role="img"
              aria-label={chartAriaLabel}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartDataWithCompare ?? chartData}
                  margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
                  accessibilityLayer
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    opacity={0.5}
                  />
                  <XAxis
                    type="number"
                    dataKey="pointIndex"
                    domain={[0, maxPointIndex]}
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) =>
                      tzFmt.date(
                        new Date(
                          chartData?.[Math.round(value)]?.timestamp ??
                            Date.now(),
                        ),
                      )
                    }
                    // v1.4.29 — Recharts ignores `interval` on numeric
                    // axes (`type="number"`). Hand explicit tick
                    // positions through the `ticks` prop so the legacy
                    // day-aware density policy stays effective on the
                    // pulse chart.
                    ticks={computeTickPositions(chartData ?? [], viewportWidth)}
                    padding={{ left: 10, right: 10 }}
                    tickMargin={10}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    width={yAxisWidth}
                    tickMargin={10}
                    domain={yDomain}
                    tickFormatter={(value) =>
                      typeof value === "number"
                        ? formatAxisValue(
                            useDecimalAxis ? value : Math.round(value),
                          )
                        : String(value)
                    }
                    unit={
                      showYAxisUnit && (yAxisUnit ?? unit)
                        ? ` ${yAxisUnit ?? unit}`
                        : undefined
                    }
                  />
                  {visibleTargetZones.map((zone) => (
                    <ReferenceArea
                      key={`${zone.key}-fill`}
                      x1={0}
                      x2={maxPointIndex}
                      y1={zone.low}
                      y2={zone.high}
                      fill={zone.color}
                      fillOpacity={zone.opacity}
                      strokeOpacity={0}
                      ifOverflow="discard"
                    />
                  ))}
                  {visibleTargetZones.map((zone) => (
                    <ReferenceLine
                      key={`${zone.key}-low`}
                      y={zone.low}
                      stroke={zone.color}
                      strokeDasharray="6 4"
                      strokeWidth={1.75}
                      strokeOpacity={zone.lineOpacity}
                    />
                  ))}
                  {visibleTargetZones.map((zone) => (
                    <ReferenceLine
                      key={`${zone.key}-high`}
                      y={zone.high}
                      stroke={zone.color}
                      strokeDasharray="6 4"
                      strokeWidth={1.75}
                      strokeOpacity={zone.lineOpacity}
                      label={
                        zone.label
                          ? {
                              value: zone.label,
                              position: "right",
                              fill: zone.textColor ?? zone.color,
                              fontSize: 10,
                            }
                          : undefined
                      }
                    />
                  ))}
                  {/* v1.4.20 phase B4 — storyboard annotations.
                    Vertical reference lines pinned to a specific
                    visible pointIndex; the label sits above with a
                    short truncation on `<sm` (24 chars) and the full
                    label on >=sm. Annotations off-window silently
                    drop via `ifOverflow="discard"`. */}
                  {annotationPositions.map((annotation, i) => (
                    <ReferenceLine
                      key={`storyboard-${i}-${annotation.pointIndex}`}
                      x={annotation.pointIndex}
                      stroke={annotation.color}
                      strokeDasharray="4 4"
                      strokeWidth={1.25}
                      strokeOpacity={0.7}
                      ifOverflow="discard"
                      label={{
                        value:
                          viewportWidth < 640
                            ? annotation.truncatedLabel
                            : annotation.label,
                        position: "insideTopRight",
                        fill: annotation.color,
                        fontSize: 10,
                        fontWeight: 500,
                      }}
                    />
                  ))}
                  {/* v1.4.25 W6 — GLP-1 injection-day vertical markers.
                    Thin dashed line + a small filled dot at the x-axis
                    intersection so a row of markers reads as "injection
                    cadence" without crowding the canvas. Optional label
                    rendered only when the caller passed one; the
                    dashboard tile leaves it undefined (the date is
                    redundant — the chart's x-axis already shows it). */}
                  {verticalMarkerPositions.map((marker, i) => (
                    <ReferenceLine
                      key={`vmarker-${i}-${marker.pointIndex}`}
                      x={marker.pointIndex}
                      stroke={marker.color}
                      strokeDasharray="3 3"
                      strokeWidth={1.1}
                      strokeOpacity={0.55}
                      ifOverflow="discard"
                      label={
                        marker.label
                          ? {
                              value: marker.label,
                              position: "insideTopRight",
                              fill: marker.color,
                              fontSize: 10,
                              fontWeight: 500,
                            }
                          : undefined
                      }
                    />
                  ))}
                  {yDomain &&
                    verticalMarkerPositions.map((marker, i) => (
                      <ReferenceDot
                        key={`vmarker-dot-${i}-${marker.pointIndex}`}
                        x={marker.pointIndex}
                        y={yDomain[0]}
                        r={3}
                        fill={marker.color}
                        stroke="none"
                        ifOverflow="discard"
                      />
                    ))}
                  {/* v1.4.18 — personal-baseline reference line is now
                    opt-in via the Trend toggle. the maintainer rejected the
                    always-on dashed mean line; it now only paints when
                    the user actively shows the trend overlay (matching
                    his rule: "only when a trend is being displayed").
                    90-day rolling median per type, faint dashed line,
                    only the first type gets the inline label so
                    multi-type charts don't paint duplicate labels. */}
                  {showTrend &&
                    types.map((type, i) => {
                      const baseline = personalBaselines.get(type);
                      if (baseline == null) return null;
                      return (
                        <ReferenceLine
                          key={`baseline-${type}`}
                          y={baseline}
                          stroke={colors[i % colors.length]}
                          strokeDasharray="2 4"
                          strokeOpacity={0.4}
                          strokeWidth={1}
                          ifOverflow="discard"
                          label={
                            i === 0
                              ? {
                                  value: t("charts.personalBaseline"),
                                  position: "insideTopLeft",
                                  fill: "var(--muted-foreground)",
                                  fontSize: 10,
                                  opacity: 0.7,
                                }
                              : undefined
                          }
                        />
                      );
                    })}
                  <Tooltip
                    filterNull={false}
                    cursor={{
                      stroke: "var(--muted-foreground)",
                      strokeOpacity: 0.3,
                      strokeDasharray: "3 3",
                    }}
                    content={(props) => {
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
                          ? chartData?.[Math.round(rechartsLabel)]?.timestamp
                          : undefined);
                      const dateLabel = ts ? tzFmt.date(new Date(ts)) : "";
                      const rows: RichTooltipRow[] = [];
                      // Build a quick lookup of compare values for this
                      // hover-day so the current-period row can attach
                      // a "vs. last month / year" delta inline. Same-day
                      // current ↔ compare values come from the SAME
                      // payload object.
                      const hoverPoint = payload[0]?.payload as
                        ChartDataPoint | undefined;
                      for (const item of payload) {
                        if (typeof item.value !== "number") continue;
                        const dataKey = String(item.dataKey ?? "");
                        // Skip auxiliary lines (`*_ma`, `*_trend`,
                        // `*_compare`) — the comparison value is rendered
                        // inline as the delta on the current-period row,
                        // and ma / trend already appear as dashed overlays
                        // on the chart itself.
                        if (
                          dataKey.endsWith("_ma") ||
                          dataKey.endsWith("_trend") ||
                          dataKey.endsWith("_compare")
                        )
                          continue;
                        const baseline = personalBaselines.get(dataKey);
                        let delta: string | undefined;
                        // v1.4.16 phase B8 — prefer the comparison delta
                        // ("Δ −7 vs. last month") over the personal
                        // baseline delta when comparison is active and we
                        // have a prior value for this day. Otherwise fall
                        // back to the existing baseline-delta path.
                        const compareValue =
                          effectiveCompareBaseline !== "none" && hoverPoint
                            ? (hoverPoint[`${dataKey}_compare`] as
                                number | undefined)
                            : undefined;
                        if (
                          effectiveCompareBaseline !== "none" &&
                          typeof compareValue === "number" &&
                          Number.isFinite(compareValue)
                        ) {
                          const diff = item.value - compareValue;
                          if (Math.abs(diff) < 0.05) {
                            delta = t("charts.deltaUnchanged");
                          } else {
                            const sign = diff > 0 ? "+" : "−";
                            const formatted = `${sign}${fmt.number(
                              Math.abs(diff),
                              1,
                            )}${unit ? ` ${unit}` : ""}`;
                            delta = t(
                              effectiveCompareBaseline === "lastMonth"
                                ? "comparison.deltaVs.lastMonth"
                                : "comparison.deltaVs.lastYear",
                            ).replace("{delta}", formatted);
                          }
                        } else if (baseline != null) {
                          const diff = item.value - baseline;
                          if (Math.abs(diff) < 0.05) {
                            delta = t("charts.deltaUnchanged");
                          } else {
                            const sign = diff > 0 ? "+" : "−";
                            const formatted = `${sign}${fmt.number(
                              Math.abs(diff),
                              1,
                            )}${unit ? ` ${unit}` : ""}`;
                            delta = t("charts.deltaVsBaseline").replace(
                              "{delta}",
                              formatted,
                            );
                          }
                        }
                        rows.push({
                          name: item.name ?? dataKey,
                          value: `${formatTooltipValue(item.value)}${
                            unit ? ` ${unit}` : ""
                          }`,
                          color: item.color ?? "var(--dracula-purple)",
                          delta,
                        });
                        // v1.4.16 phase B8 — also surface the prior-period
                        // value as its own row so the user reads both
                        // numbers (current AND last-month / last-year)
                        // alongside the delta.
                        if (
                          effectiveCompareBaseline !== "none" &&
                          typeof compareValue === "number" &&
                          Number.isFinite(compareValue)
                        ) {
                          rows.push({
                            name: `${item.name ?? dataKey} · ${t(
                              "comparison.tooltipPrior",
                            )}`,
                            value: `${formatTooltipValue(compareValue)}${
                              unit ? ` ${unit}` : ""
                            }`,
                            color: item.color ?? "var(--dracula-purple)",
                          });
                        }
                      }
                      if (rows.length === 0) return null;
                      return (
                        <RichChartTooltip
                          active
                          label={dateLabel}
                          rows={rows}
                        />
                      );
                    }}
                  />
                  {showContextDetails && (
                    <Legend
                      wrapperStyle={{
                        fontSize: "0.875rem",
                        fontFamily: "inherit",
                        fontWeight: "normal",
                      }}
                    />
                  )}
                  {/* v1.8.5 — min–max range band. An Apple-Health-style
                    shaded area between each day's min and max, painted
                    behind the mean line so it reads as context, not a
                    second series. Gated on `!mini` (the dashboard
                    sparkline stays clean) and on the daily-aggregate
                    path supplying a `[min, max]` tuple per point — single
                    non-cumulative metrics with intra-day spread (pulse,
                    weight, glucose, BP). The toggle rides the existing
                    target-range pref so the user controls both bands
                    from one switch. */}
                  {!mini &&
                    showBands &&
                    types.map((type, i) => (
                      <Area
                        key={`${type}__range`}
                        type="monotone"
                        dataKey={`${type}__range`}
                        name={`${getTypeLabel(type, valueMode, t)} (${t("charts.rangeBand")})`}
                        stroke="none"
                        fill={colors[i % colors.length]}
                        fillOpacity={0.12}
                        connectNulls
                        isAnimationActive={animationsEnabled}
                        legendType="none"
                        tooltipType="none"
                      />
                    ))}
                  {types.map((type, i) => (
                    <Line
                      key={type}
                      type="monotone"
                      dataKey={type}
                      name={getTypeLabel(type, valueMode, t)}
                      stroke={colors[i % colors.length]}
                      strokeWidth={2}
                      dot={{ r: 3, fill: colors[i % colors.length] }}
                      activeDot={{ r: 5 }}
                      connectNulls
                      isAnimationActive={animationsEnabled}
                      animationDuration={animationsEnabled ? 600 : 0}
                      animationEasing="ease-out"
                    />
                  ))}
                  {showMA &&
                    types.map((type, i) => (
                      <Line
                        key={`${type}_ma`}
                        type="monotone"
                        dataKey={`${type}_ma`}
                        name={`${getTypeLabel(type, valueMode, t)} (${t("charts.movingAverage7d")})`}
                        stroke={colors[i % colors.length]}
                        strokeWidth={1.5}
                        strokeDasharray="5 5"
                        strokeOpacity={0.7}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  {showTrend &&
                    types.map((type) => (
                      <Line
                        key={`${type}_trend`}
                        type="linear"
                        dataKey={`${type}_trend`}
                        name={`${getTypeLabel(type, valueMode, t)} (${t("charts.trend")})`}
                        stroke="var(--muted-foreground)"
                        strokeWidth={1}
                        strokeDasharray="8 4"
                        dot={false}
                        connectNulls
                      />
                    ))}
                  {/* v1.4.16 phase B8 — comparison overlay.
                    A dimmed dashed line per type for the prior period
                    (lastMonth / lastYear), painted BENEATH the current
                    series via Recharts' source-order layering. Same
                    base colour as the current line but with reduced
                    stroke opacity (45%) and a thinner stroke (1.25)
                    so the user reads the current line first and the
                    overlay as orientation. */}
                  {effectiveCompareBaseline !== "none" &&
                    hasComparisonData &&
                    types.map((type, i) => (
                      <Line
                        key={`${type}_compare`}
                        type="monotone"
                        dataKey={`${type}_compare`}
                        name={`${getTypeLabel(type, valueMode, t)} (${t(
                          effectiveCompareBaseline === "lastMonth"
                            ? "comparison.captionLastMonth"
                            : "comparison.captionLastYear",
                        )})`}
                        stroke={colors[i % colors.length]}
                        strokeWidth={1.25}
                        strokeDasharray="4 3"
                        strokeOpacity={0.45}
                        dot={false}
                        connectNulls
                        isAnimationActive={animationsEnabled}
                        animationDuration={animationsEnabled ? 600 : 0}
                        animationEasing="ease-out"
                        legendType="none"
                        data-slot={`chart-compare-line-${type}`}
                      />
                    ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {/* Sparse-data caption. With fewer than three daily points the
              chart still paints every reading (a single marker for one
              day, a line for two), and this subtle note sets the
              expectation that more days fill out the trend — rather than
              withholding the data behind a placeholder card. */}
            {!mini && (chartData?.length ?? 0) < 3 ? (
              <p
                className="text-muted-foreground mt-2 text-center text-xs"
                data-slot="chart-sparse-caption"
              >
                {t("charts.sparseDataCaption")}
              </p>
            ) : null}
          </div>
          {/* The points the chart just drew, as a table. Reads the SAME
              expression `<ComposedChart data>` is handed above, so the two
              cannot disagree. Sits inside this branch on purpose: an empty
              window paints the empty state and no table at all, because
              `<ChartEmptyState>` already says there is nothing here and a
              disclosure opening onto nothing would say it twice. */}
          {showDataTable && !mini && dataTableColumns.length > 0 ? (
            <ChartDataTable
              points={chartDataWithCompare ?? chartData ?? []}
              columns={dataTableColumns}
              unit={unit}
              formatValue={formatTooltipValue}
              formatDate={tzFmt.date}
              bucket={visibleSlice?.bucketType ?? "day"}
              metricLabel={getTypeLabel(primaryType, valueMode, t)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
