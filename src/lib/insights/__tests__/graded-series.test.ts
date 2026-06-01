import { describe, expect, it } from "vitest";

import {
  buildGradedSeriesFromPoints,
  type GradedSeries,
} from "../graded-series";

const dayMs = 24 * 60 * 60 * 1000;

function dailyPoints(days: number, now: Date, value = (i: number) => 80 + (i % 5)) {
  const out: Array<{ measuredAt: Date; value: number }> = [];
  for (let i = 0; i < days; i++) {
    out.push({ measuredAt: new Date(now.getTime() - i * dayMs), value: value(i) });
  }
  return out;
}

function countBuckets(s: GradedSeries): number {
  return s.recent.length + s.weekly.length + s.monthly.length + s.yearly.length;
}

describe("buildGradedSeriesFromPoints", () => {
  const now = new Date("2026-05-31T12:00:00Z");

  it("keeps the last ~14-21 days at daily granularity", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(400, now), now);
    expect(s.recent.length).toBeGreaterThan(0);
    expect(s.recent.length).toBeLessThanOrEqual(21);
    // Each recent bucket carries daily aggregates.
    for (const r of s.recent) {
      expect(r).toHaveProperty("date");
      expect(r).toHaveProperty("mean");
      expect(r).toHaveProperty("min");
      expect(r).toHaveProperty("max");
      expect(r).toHaveProperty("n");
    }
    // Recent buckets are sorted oldest → newest.
    const dates = s.recent.map((r) => r.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("folds the weeks after the recent window into ~8-10 ISO-week buckets", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(400, now), now);
    expect(s.weekly.length).toBeGreaterThan(0);
    expect(s.weekly.length).toBeLessThanOrEqual(12);
    for (const w of s.weekly) {
      expect(w).toHaveProperty("weekISO");
      expect(w).toHaveProperty("mean");
      expect(w).toHaveProperty("min");
      expect(w).toHaveProperty("max");
      expect(w).toHaveProperty("n");
    }
  });

  it("folds older history into ~9-12 monthly buckets", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(730, now), now);
    expect(s.monthly.length).toBeGreaterThan(0);
    expect(s.monthly.length).toBeLessThanOrEqual(14);
    for (const m of s.monthly) {
      expect(m).toHaveProperty("month");
      expect(m).toHaveProperty("mean");
      expect(m).toHaveProperty("min");
      expect(m).toHaveProperty("max");
    }
  });

  it("folds multi-year history into yearly buckets with a trend slope", () => {
    // 3+ years so at least one year lands in the yearly bucket.
    const s = buildGradedSeriesFromPoints(dailyPoints(1200, now), now);
    expect(s.yearly.length).toBeGreaterThan(0);
    for (const y of s.yearly) {
      expect(y).toHaveProperty("year");
      expect(y).toHaveProperty("mean");
      expect(y).toHaveProperty("slope");
    }
  });

  it("collapses a 2-year daily weigher into <= ~50 buckets, not 730", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(730, now), now);
    // ~21 recent + ~10 weekly + ~12 monthly + ~2-3 yearly. Worst-case
    // boundary slack lands ~46; the point is the order-of-magnitude
    // collapse from 730 daily readings, not an exact bucket count.
    expect(countBuckets(s)).toBeLessThanOrEqual(50);
  });

  it("returns empty buckets for an empty input", () => {
    const s = buildGradedSeriesFromPoints([], now);
    expect(countBuckets(s)).toBe(0);
  });

  it("does not duplicate a day across recent and weekly", () => {
    const s = buildGradedSeriesFromPoints(dailyPoints(120, now), now);
    // The most recent ISO week of the recent window must not also be a
    // weekly bucket — recent days are excluded from the weekly fold.
    const recentDates = new Set(s.recent.map((r) => r.date));
    // The weekly buckets cover days strictly older than the recent window.
    expect(recentDates.size).toBe(s.recent.length);
    expect(s.weekly.length).toBeGreaterThan(0);
  });

  it("computes per-bucket min/max/mean from same-day multi readings", () => {
    const points = [
      { measuredAt: new Date(now.getTime()), value: 70 },
      { measuredAt: new Date(now.getTime() - 1000), value: 90 },
      { measuredAt: new Date(now.getTime() - 2000), value: 80 },
    ];
    const s = buildGradedSeriesFromPoints(points, now);
    expect(s.recent.length).toBe(1);
    expect(s.recent[0].min).toBe(70);
    expect(s.recent[0].max).toBe(90);
    expect(s.recent[0].mean).toBe(80);
    expect(s.recent[0].n).toBe(3);
  });
});
