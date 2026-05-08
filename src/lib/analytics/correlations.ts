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

const BERLIN_DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

/**
 * Aggregate data into weekly averages, ISO-Monday-based, in Europe/Berlin.
 *
 * v3 audit caught a TZ bug here: the previous implementation used
 * `Date.getDay()` / `Date.getDate()` (system local) so on a UTC server, a
 * Sunday-evening Berlin reading bucketed into the next week. We now derive
 * year/month/day/weekday in Berlin via Intl.DateTimeFormat and rebuild the
 * Monday key from there. The returned `date` for each bucket is the Monday
 * UTC midnight — sortable, comparable across DST.
 */
export function weeklyAverages(data: DataPoint[]): DataPoint[] {
  if (data.length === 0) return [];

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());

  const weeks = new Map<string, { sum: number; count: number; date: Date }>();

  const WEEKDAY_INDEX: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };

  for (const point of sorted) {
    const parts = BERLIN_DATE_PARTS.formatToParts(point.date);
    const yearStr = parts.find((p) => p.type === "year")?.value ?? "1970";
    const monthStr = parts.find((p) => p.type === "month")?.value ?? "01";
    const dayStr = parts.find((p) => p.type === "day")?.value ?? "01";
    const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Mon";

    const isoWeekday = WEEKDAY_INDEX[weekdayStr] ?? 1;
    // Days to subtract to land on Monday of the same ISO week in Berlin.
    const offsetDays = isoWeekday - 1;

    const dayUtc = new Date(`${yearStr}-${monthStr}-${dayStr}T00:00:00.000Z`);
    const monday = new Date(dayUtc.getTime() - offsetDays * 86_400_000);
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
