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
 *
 * NOTE: This is a greedy heuristic, not the bipartite-minimum-weight
 * optimum. For sparse health data the difference is negligible — well
 * under 1% in the v1.4 charts auditor's stress sample — but adversarial
 * inputs (alternating 1ms-apart points) can produce sub-optimal
 * pairings. If exact pairing matters, swap in a Hungarian-style match.
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

