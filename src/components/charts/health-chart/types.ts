import type { ComponentType } from "react";

import type {
  ChartOverlayKey,
  ComparisonBaseline,
} from "@/lib/dashboard-layout";
import type { MetricWindowStats } from "@/lib/charts/window-stats";

import type { DataWindow } from "../mini-window";

/** A shaded value band behind the series (an HTML overlay under the plot). */
export interface ChartValueBand {
  min: number;
  max: number;
  color: string;
  opacity?: number;
  strokeOpacity?: number;
}

/** A target zone drawn inside the plot, with dashed edges and a label. */
export interface ChartTargetZone {
  min: number;
  max: number;
  color: string;
  opacity?: number;
  label?: string;
  textColor?: string;
  lineOpacity?: number;
}

export interface HealthChartProps {
  types: string[];
  title: string;
  colors?: string[];
  unit?: string;
  yAxisUnit?: string;
  valueMode?: "raw" | "bmi";
  yAxisWidth?: number;
  showYAxisUnit?: boolean;
  valueBands?: ChartValueBand[];
  targetZones?: ChartTargetZone[];
  /**
   * Compact chart for the rationale card: no range tabs, no overlay toggles,
   * tighter padding. Tooltip, gradient and personal baseline stay, so the
   * small chart tells the same story.
   */
  mini?: boolean;
  /**
   * Pin the chart to a rationale data window regardless of any parent UI
   * state (the recommendation card's mini chart).
   */
  windowOverride?: DataWindow;
  /**
   * "lastMonth" / "lastYear" paints a dimmed prior-period overlay beneath the
   * current series, shifted so the prior day lands under its current-period
   * sibling. "none" or undefined draws the chart without it.
   */
  compareBaseline?: ComparisonBaseline;
  /**
   * Per-chart overlay-prefs key. With it the chart offers the overlay
   * controls and reads its toggles and range from the persisted prefs;
   * without it (mini mode, ad-hoc use) the toggles default to off.
   */
  chartKey?: ChartOverlayKey;
  /**
   * Whether a chart bound to a `chartKey` also shows the overlay dropdown.
   * Off for a chart that persists only its range tab (the score histories).
   * Defaults to on.
   */
  overlayControls?: boolean;
  /**
   * Storyboard annotations: a vertical reference line and label on the point
   * whose day key matches `date` (`YYYY-MM-DD`). The series and tooltip are
   * untouched; an annotation outside the visible window drops.
   */
  annotations?: Array<{ date: string; label: string; color: string }>;
  /**
   * Injection-day markers: a thin dashed line and a dot on the x axis at the
   * point whose day key matches `date`, with no label unless one is given.
   * Default colour `var(--success)`. Off-window markers drop.
   */
  verticalMarkers?: Array<{ date: string; label?: string; color?: string }>;
  /**
   * The display time zone for tick labels and day buckets. Without it the
   * chart uses the signed-in account's zone, and before that has loaded the
   * server's default.
   */
  userTimezone?: string;
  /**
   * Display-time scale applied to every raw value at the one read boundary
   * (bucketing, y domain, baseline, trend and tooltip all see the scaled
   * series), e.g. m/s → km/h. Defaults to 1.
   */
  valueScale?: number;
  /**
   * Display-time offset folded in beside `valueScale`
   * (`display = raw * valueScale + valueOffset`), for °C → °F. Defaults to 0.
   * Every delta and slope is a difference, so the offset cancels there.
   */
  valueOffset?: number;
  /**
   * Reports the per-type min / max / median / mean of the data visible under
   * the active range tab, on mount and on every change, for the stat strip a
   * sub-page lifts it into. Mini mode never reports.
   */
  onVisibleStats?: (stats: Record<string, MetricWindowStats> | null) => void;
  /**
   * Leading glyph for the card's `<TileHeader>`. Without it the card keeps
   * the compact heading.
   */
  titleIcon?: ComponentType<{ className?: string }>;
  /**
   * Fires once the data query has settled (success or error), for the
   * dashboard's shared reveal. Repeat-safe.
   */
  onDataReady?: () => void;
  /**
   * Pre-fetched daily series keyed by `MeasurementType`, from the dashboard's
   * one batched read. Read for the covered types instead of a per-type fetch
   * while the active window fits `preloadedCoverageDays`; SLEEP_DURATION is
   * never pre-fetched.
   */
  preloadedSeries?: Record<string, MeasurementApiRow[]>;
  /**
   * The day span the `preloadedSeries` slice covers. A wider range tab falls
   * through to a real fetch. Required with `preloadedSeries`.
   */
  preloadedCoverageDays?: number;
  /**
   * The drawn points as a table under the chart, behind a collapsed
   * disclosure. Opt-in: the metric pages want the numbers, the dashboard
   * tiles do not.
   */
  showDataTable?: boolean;
  /**
   * The chart as a door to its days: a click on a point opens that day, the
   * open day is marked, and dots under the axis mark the days that hold
   * anything. Only while drawn in days, never in `mini` mode.
   */
  dayLinks?: boolean;
}

export interface ChartDataPoint {
  date: string;
  timestamp: number;
  pointIndex?: number;
  // `${type}__range` keys carry a `[min, max]` tuple for the range band;
  // every other key is a scalar.
  [key: string]: string | number | undefined | [number, number];
}

export interface MeasurementApiRow {
  measuredAt: string;
  value: number;
  // The day's min / max from the rollup daily aggregate (non-cumulative
  // metrics only), for the range band around the mean line. Never drawn on
  // the 7-day range. `null` is accepted beside `undefined` because the
  // batched series carries `number | null`.
  minValue?: number | null;
  maxValue?: number | null;
  // The raw-row count per bucket, for the "more days needed" copy. Absent on
  // the per-night sleep series.
  count?: number;
}

export interface VisibleValueBand {
  key: string;
  topPct: number;
  heightPct: number;
  color: string;
  opacity: number;
  strokeOpacity: number;
}

export interface VisibleTargetZone {
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
