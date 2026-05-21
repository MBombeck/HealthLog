/**
 * Trend calculation utilities for health data.
 * All functions are pure and work on sorted arrays of {date, value} pairs.
 */

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
 * Linear regression slope over the last N days.
 * Uses least squares fit.
 *
 * Window is anchored on `Date.now()`, NOT on the most recent point — so a
 * stale series (no readings for weeks) returns `null` from this function the
 * same way `summarize().avg7/avg30` returns `null`. The v3 audit caught the
 * mismatch where `trendSlope` reported a "trend" from old data while the
 * dashboard tile correctly hid the average.
 */
export function trendSlope(
  data: DataPoint[],
  windowDays: number,
): TrendSlope | null {
  if (data.length < 2) return null;

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const window = sorted.filter((p) => p.date.getTime() >= cutoff);

  if (window.length < 2) return null;

  // Convert dates to days from start
  const startTime = window[0].date.getTime();
  const points = window.map((p) => ({
    x: (p.date.getTime() - startTime) / (24 * 60 * 60 * 1000),
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

  // R² calculation
  const meanY = sumY / n;
  const ssTotal = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssResidual = points.reduce(
    (s, p) => s + (p.y - (intercept + slope * p.x)) ** 2,
    0,
  );
  const rSquared = ssTotal === 0 ? 0 : 1 - ssResidual / ssTotal;

  const threshold = 0.01; // units per day threshold for "stable"
  const direction: "up" | "down" | "stable" =
    Math.abs(slope) < threshold ? "stable" : slope > 0 ? "up" : "down";

  return {
    slope: Math.round(slope * 1000) / 1000,
    direction,
    confidence: Math.round(rSquared * 100) / 100,
  };
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
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

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
  avg7: number | null;
  avg30: number | null;
  slope7: TrendSlope | null;
  slope30: TrendSlope | null;
  slope90: TrendSlope | null;
  anomalyCount: number;
  /**
   * v1.4.16 phase B8 — average value over the 30-day window starting
   * 30 days before today, i.e. the "last month" prior period the
   * dashboard tile delta callout compares against. Null when the
   * window has no data.
   */
  avg30LastMonth?: number | null;
  /**
   * v1.4.16 phase B8 — average value over the 30-day window starting
   * 365 days before today (one calendar year ago). Null when the
   * window has no data.
   */
  avg30LastYear?: number | null;
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
      avg7: null,
      avg30: null,
      slope7: null,
      slope30: null,
      slope90: null,
      anomalyCount: 0,
      avg30LastMonth: null,
      avg30LastYear: null,
    };
  }

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const values = sorted.map((p) => p.value);
  // v1.4.33 P0 — single-pass fold for sum/min/max replaces the previous
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

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const last7 = sorted.filter((p) => now - p.date.getTime() < 7 * DAY);
  const last30 = sorted.filter((p) => now - p.date.getTime() < 30 * DAY);

  // v1.4.16 phase B8 — prior-period 30-day means powering the tile
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
    slope90: trendSlope(data, 90),
    anomalyCount: detectAnomalies(data).length,
    avg30LastMonth,
    avg30LastYear,
  };
}
