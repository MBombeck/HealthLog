/**
 * Trend calculation utilities for health data.
 * All functions are pure and work on sorted arrays of {date, value} pairs.
 */

export interface DataPoint {
  date: Date;
  value: number;
}

// ── Moving Average ───────────────────────────────────────

export function movingAverage(
  data: DataPoint[],
  windowDays: number,
): DataPoint[] {
  if (data.length === 0) return [];

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const result: DataPoint[] = [];
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  for (const point of sorted) {
    const windowStart = point.date.getTime() - windowMs;
    const windowPoints = sorted.filter(
      (p) =>
        p.date.getTime() > windowStart &&
        p.date.getTime() <= point.date.getTime(),
    );
    const avg =
      windowPoints.reduce((sum, p) => sum + p.value, 0) / windowPoints.length;
    result.push({ date: point.date, value: Math.round(avg * 100) / 100 });
  }

  return result;
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
 */
export function trendSlope(
  data: DataPoint[],
  windowDays: number,
): TrendSlope | null {
  if (data.length < 2) return null;

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const cutoff =
    sorted[sorted.length - 1].date.getTime() - windowDays * 24 * 60 * 60 * 1000;
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

// ── Trend Line Points ────────────────────────────────────

/**
 * Generate two data points representing the linear trend line endpoints.
 * Used by chart components to overlay a regression line.
 */
export function trendLinePoints(
  data: DataPoint[],
  windowDays: number,
): { start: DataPoint; end: DataPoint } | null {
  if (data.length < 2) return null;

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const cutoff =
    sorted[sorted.length - 1].date.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const window = sorted.filter((p) => p.date.getTime() >= cutoff);

  if (window.length < 2) return null;

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

  const endDays = points[points.length - 1].x;

  return {
    start: {
      date: window[0].date,
      value: Math.round(intercept * 100) / 100,
    },
    end: {
      date: window[window.length - 1].date,
      value: Math.round((intercept + slope * endDays) * 100) / 100,
    },
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
  min: number;
  max: number;
  mean: number;
  avg7: number | null;
  avg30: number | null;
  slope7: TrendSlope | null;
  slope30: TrendSlope | null;
  slope90: TrendSlope | null;
  anomalyCount: number;
}

export function summarize(data: DataPoint[]): DataSummary {
  if (data.length === 0) {
    return {
      count: 0,
      latest: null,
      min: 0,
      max: 0,
      mean: 0,
      avg7: null,
      avg30: null,
      slope7: null,
      slope30: null,
      slope90: null,
      anomalyCount: 0,
    };
  }

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const values = sorted.map((p) => p.value);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;

  const now = Date.now();
  const last7 = sorted.filter(
    (p) => now - p.date.getTime() < 7 * 24 * 60 * 60 * 1000,
  );
  const last30 = sorted.filter(
    (p) => now - p.date.getTime() < 30 * 24 * 60 * 60 * 1000,
  );

  return {
    count: data.length,
    latest: sorted[sorted.length - 1].value,
    min: Math.min(...values),
    max: Math.max(...values),
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
  };
}
