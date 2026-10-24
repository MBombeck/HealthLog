/**
 * Trend calculation utilities for health data.
 * All functions are pure and work on sorted arrays of {date, value} pairs.
 */

import { READING_SPREAD, standardDeviation } from "@/lib/stats/spread";
import { linearFit } from "@/lib/stats/linear-fit";
import {
  isTrendWindowSufficient,
  trendEvidenceOf,
  type TrendEvidence,
} from "@/lib/analytics/window-confidence";

export interface DataPoint {
  date: Date;
  value: number;
}

// ── Trend Slope ──────────────────────────────────────────

export interface TrendSlope {
  slope: number; // units per day
  direction: "up" | "down" | "stable";
  confidence: number; // R² value 0-1
}

/**
 * The one place a fitted slope becomes a published trend, shared by the JS
 * fit below and the rollup / live-SQL summaries (which fit in Postgres or
 * compose the fit from stored accumulators). `null` when the window's
 * readings do not cover enough days for a trend (`isTrendWindowSufficient`),
 * so slope, direction and confidence are present or absent together on
 * every path.
 */
export function toTrendSlope(
  slope: number | null,
  rSquared: number | null,
  evidence: TrendEvidence,
  windowDays: number,
): TrendSlope | null {
  if (slope === null || !Number.isFinite(slope)) return null;
  if (!isTrendWindowSufficient(evidence, windowDays)) return null;

  const threshold = 0.01; // units per day threshold for "stable"
  const direction: "up" | "down" | "stable" =
    Math.abs(slope) < threshold ? "stable" : slope > 0 ? "up" : "down";

  return {
    slope: Math.round(slope * 1000) / 1000,
    direction,
    // No variance in y: a flat line explains nothing, as it always read.
    confidence: rSquared === null ? 0 : Math.round(rSquared * 100) / 100,
  };
}

/**
 * Linear regression slope over the last N days.
 * Uses least squares fit.
 *
 * Window is anchored on `Date.now()`, NOT on the most recent point — so a
 * stale series (no readings for weeks) returns `null` from this function the
 * same way `summarize().avg7/avg30` returns `null`. The v3 audit caught the
 * mismatch where `trendSlope` reported a "trend" from old data while the
 * dashboard tile correctly hid the average.
 *
 * `null` too when the in-window readings fall on fewer than three days or
 * span less than half the window: a fit across readings minutes apart turns
 * a few mmHg into thousands per day (see `MIN_TREND_DAYS`).
 */
export function trendSlope(
  data: DataPoint[],
  windowDays: number,
  now: number = Date.now(),
): TrendSlope | null {
  if (data.length < 2) return null;

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  const window = sorted.filter((p) => p.date.getTime() >= cutoff);
  if (window.length < 2) return null;

  const evidence = trendEvidenceOf(window.map((p) => p.date.getTime()));
  if (!isTrendWindowSufficient(evidence, windowDays)) return null;

  // Convert dates to days from start
  const startTime = window[0].date.getTime();
  const points = window.map((p) => ({
    x: (p.date.getTime() - startTime) / (24 * 60 * 60 * 1000),
    y: p.value,
  }));

  const fit = linearFit(
    points.map((p) => p.x),
    points.map((p) => p.y),
  );
  if (!fit) return null;
  return toTrendSlope(fit.slope, fit.r2, evidence, windowDays);
}

// ── Anomaly Detection ────────────────────────────────────

export interface Anomaly {
  date: Date;
  value: number;
  zScore: number;
}

/**
 * Simple z-score anomaly detection.
 * Returns points with |z-score| > threshold.
 */
export function detectAnomalies(data: DataPoint[], threshold = 2.0): Anomaly[] {
  if (data.length < 3) return [];

  const values = data.map((p) => p.value);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const stdDev = standardDeviation(values, READING_SPREAD) ?? 0;

  if (stdDev === 0) return [];

  return data
    .map((p) => ({
      date: p.date,
      value: p.value,
      zScore: Math.round(((p.value - mean) / stdDev) * 100) / 100,
    }))
    .filter((a) => Math.abs(a.zScore) > threshold);
}

// ── Summary Statistics ───────────────────────────────────

export interface DataSummary {
  count: number;
  latest: number | null;
  /** Null when the series is empty (vs the previous 0 sentinel). */
  min: number | null;
  /** Null when the series is empty (vs the previous 0 sentinel). */
  max: number | null;
  /** Null when the series is empty (vs the previous 0 sentinel). */
  mean: number | null;
  /**
   * v1.8.5 — 50th percentile (median) of the value series. Surfaced on
   * the insights category-page stat strip alongside min / max / mean so
   * a skewed series (a few very high or very low readings dragging the
   * mean) reads honestly. Null when the series is empty.
   *
   * Window: caller-defined. `summarize()` computes the median over the
   * full `DataPoint[]` it is handed, so the window is whatever the caller
   * passed (full history for `/api/measurements/series`, per-day means
   * for the snapshot builder, …). It is NOT guaranteed to be the trailing
   * 90-day window. The insights stat strip does not read this value — its
   * median comes from the SQL `summaries-slice` path, which fixes the
   * window to the trailing 90 days (`PERCENTILE_CONT(0.5) … FILTER (WHERE
   * measured_at >= NOW() - INTERVAL '90 days')`). A consumer comparing the
   * two must account for the differing windows. The percentile *algorithm*
   * matches (linear-interpolated midpoint), only the window differs.
   */
  median: number | null;
  avg7: number | null;
  avg30: number | null;
  slope7: TrendSlope | null;
  slope30: TrendSlope | null;
  /**
   * In-process only — the insights feature builder reads it as the
   * outlier/anomaly figure for its prompt blocks. The `/api/analytics`
   * wire never serialises it (the slim SQL path cannot compute it and
   * always reported 0), and no client component reads it. `slope90` was
   * removed from this shape entirely in v1.37.19 for the same reason:
   * computed on every request, read by nobody.
   */
  anomalyCount?: number;
  /**
   * v1.4.16 — average value over the 30-day window starting
   * 30 days before today, i.e. the "last month" prior period the
   * dashboard tile delta callout compares against. Null when the
   * window has no data.
   */
  avg30LastMonth?: number | null;
  /**
   * v1.4.16 — average value over the 30-day window starting
   * 365 days before today (one calendar year ago). Null when the
   * window has no data.
   */
  avg30LastYear?: number | null;
}

/**
 * A summary as `/api/analytics` publishes it: without `anomalyCount`.
 *
 * The SQL summaries path cannot compute the figure, so the route's published
 * summary has not carried it since v1.37.19. Two of its summaries are still
 * built by `summarize()` (the per-night sleep series and the glucose
 * meal-context split), and both put it back on the wire until they were run
 * through this.
 */
export function wireSummary(summary: DataSummary): DataSummary {
  const { anomalyCount: _inProcessOnly, ...wire } = summary;
  return wire;
}

export function summarize(data: DataPoint[]): DataSummary {
  if (data.length === 0) {
    // Empty series — return null for stats so callers can render an explicit
    // "no data" state instead of treating 0/0/0 as a real reading. v3 audit
    // caught the previous {min:0,max:0,mean:0} producing nonsense chart axes.
    return {
      count: 0,
      latest: null,
      min: null,
      max: null,
      mean: null,
      median: null,
      avg7: null,
      avg30: null,
      slope7: null,
      slope30: null,
      anomalyCount: 0,
      avg30LastMonth: null,
      avg30LastYear: null,
    };
  }

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const values = sorted.map((p) => p.value);
  // v1.4.33 — single-pass fold for sum/min/max replaces the previous
  // `Math.min(...values)` / `Math.max(...values)` spread. V8 caps
  // function arity at ~125k-130k; Apple-Health-synced PULSE series for
  // a multi-year power user routinely exceed that, and the spread
  // surfaced as `RangeError: Maximum call stack size exceeded` from the
  // `/api/analytics` route's per-type `Promise.all` aggregator. Folding
  // the three reductions into one walk keeps the working set bounded
  // (no transient argument array) and is also cheaper than three
  // separate passes.
  let sum = 0;
  let minVal = values[0];
  let maxVal = values[0];
  for (const v of values) {
    sum += v;
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  const mean = sum / values.length;

  // v1.8.5 — median (50th percentile) over the FULL series handed to
  // this function (the window is caller-defined; see the `median` doc on
  // DataSummary). A separate numeric sort from the date-ordered `sorted`
  // array above so the percentile is taken over values, not timestamps.
  // Linear-interpolated midpoint on an even-length series (the standard
  // PERCENTILE_CONT definition) so the *algorithm* matches the SQL
  // `PERCENTILE_CONT(0.5)` the rollup-tier slim slice emits — but note
  // the SQL path windows to the trailing 90 days while this path does
  // not, so the two are byte-comparable only when the caller already
  // passed a 90-day series.
  const valueSorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(valueSorted.length / 2);
  const median =
    valueSorted.length % 2 === 0
      ? (valueSorted[mid - 1] + valueSorted[mid]) / 2
      : valueSorted[mid];

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const last7 = sorted.filter((p) => now - p.date.getTime() < 7 * DAY);
  const last30 = sorted.filter((p) => now - p.date.getTime() < 30 * DAY);

  // v1.4.16 — prior-period 30-day means powering the tile
  // delta callout. The lastMonth window is days [30, 60) ago; the
  // lastYear window is days [365, 395) ago. Both align to the 30-day
  // shift the chart overlay uses so the tile delta and the chart
  // overlay narrate the same comparison.
  const meanOfWindow = (
    minDaysAgo: number,
    maxDaysAgo: number,
  ): number | null => {
    const slice = sorted.filter((p) => {
      const ageMs = now - p.date.getTime();
      return ageMs >= minDaysAgo * DAY && ageMs < maxDaysAgo * DAY;
    });
    if (slice.length === 0) return null;
    const sum = slice.reduce((s, p) => s + p.value, 0);
    return Math.round((sum / slice.length) * 100) / 100;
  };
  const avg30LastMonth = meanOfWindow(30, 60);
  const avg30LastYear = meanOfWindow(365, 395);

  return {
    count: data.length,
    latest: sorted[sorted.length - 1].value,
    min: minVal,
    max: maxVal,
    mean: Math.round(mean * 100) / 100,
    median: Math.round(median * 100) / 100,
    avg7:
      last7.length > 0
        ? Math.round(
            (last7.reduce((s, p) => s + p.value, 0) / last7.length) * 100,
          ) / 100
        : null,
    avg30:
      last30.length > 0
        ? Math.round(
            (last30.reduce((s, p) => s + p.value, 0) / last30.length) * 100,
          ) / 100
        : null,
    slope7: trendSlope(data, 7),
    slope30: trendSlope(data, 30),
    anomalyCount: detectAnomalies(data).length,
    avg30LastMonth,
    avg30LastYear,
  };
}
