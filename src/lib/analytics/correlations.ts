/**
 * Correlation analysis between health metrics.
 * Pure functions — no DB access.
 */

import type { DataPoint } from "./trends";

export interface PairedPoint {
  a: number;
  b: number;
  date: Date;
}

export interface CorrelationResult {
  r: number;
  strength: "stark" | "moderat" | "schwach" | "keine";
  n: number;
}

/**
 * Pair two time-series by matching timestamps within a maximum gap.
 * Each point is used at most once (greedy nearest-match).
 */
export function pairByTimestamp(
  seriesA: DataPoint[],
  seriesB: DataPoint[],
  maxGapMs: number = 24 * 60 * 60 * 1000, // default 1 day
): PairedPoint[] {
  if (seriesA.length === 0 || seriesB.length === 0) return [];

  const sortedA = [...seriesA].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const sortedB = [...seriesB].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  const usedB = new Set<number>();
  const pairs: PairedPoint[] = [];

  for (const a of sortedA) {
    let bestIdx = -1;
    let bestGap = Infinity;

    for (let i = 0; i < sortedB.length; i++) {
      if (usedB.has(i)) continue;
      const gap = Math.abs(a.date.getTime() - sortedB[i].date.getTime());
      if (gap <= maxGapMs && gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      usedB.add(bestIdx);
      pairs.push({
        a: a.value,
        b: sortedB[bestIdx].value,
        date: a.date,
      });
    }
  }

  return pairs.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Pearson correlation coefficient.
 * Returns null if fewer than minPairs data points.
 */
export function pearsonCorrelation(
  pairs: PairedPoint[],
  minPairs: number = 5,
): CorrelationResult | null {
  if (pairs.length < minPairs) return null;

  const n = pairs.length;
  const sumA = pairs.reduce((s, p) => s + p.a, 0);
  const sumB = pairs.reduce((s, p) => s + p.b, 0);
  const sumAB = pairs.reduce((s, p) => s + p.a * p.b, 0);
  const sumAA = pairs.reduce((s, p) => s + p.a * p.a, 0);
  const sumBB = pairs.reduce((s, p) => s + p.b * p.b, 0);

  const denominator = Math.sqrt(
    (n * sumAA - sumA * sumA) * (n * sumBB - sumB * sumB),
  );

  if (denominator === 0) return { r: 0, strength: "keine", n };

  const r = Math.round(((n * sumAB - sumA * sumB) / denominator) * 1000) / 1000;
  const absR = Math.abs(r);

  let strength: CorrelationResult["strength"];
  if (absR >= 0.7) strength = "stark";
  else if (absR >= 0.4) strength = "moderat";
  else if (absR >= 0.2) strength = "schwach";
  else strength = "keine";

  return { r, strength, n };
}

/**
 * Aggregate data into weekly averages (Monday-based weeks).
 */
export function weeklyAverages(data: DataPoint[]): DataPoint[] {
  if (data.length === 0) return [];

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());

  const weeks = new Map<string, { sum: number; count: number; date: Date }>();

  for (const point of sorted) {
    // ISO week key: find Monday of that week
    const d = new Date(point.date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
    const monday = new Date(d);
    monday.setDate(diff);
    monday.setHours(0, 0, 0, 0);
    const key = monday.toISOString().slice(0, 10);

    const existing = weeks.get(key);
    if (existing) {
      existing.sum += point.value;
      existing.count++;
    } else {
      weeks.set(key, { sum: point.value, count: 1, date: monday });
    }
  }

  return Array.from(weeks.values())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((w) => ({
      date: w.date,
      value: Math.round((w.sum / w.count) * 100) / 100,
    }));
}
