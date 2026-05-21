import { describe, it, expect } from "vitest";
import type { DataPoint } from "../trends";
import { pairByTimestamp, pearsonCorrelation } from "../correlations";

function makePoints(values: number[], startDaysAgo = 30): DataPoint[] {
  const now = Date.now();
  return values.map((value, i) => ({
    date: new Date(now - (startDaysAgo - i) * 24 * 60 * 60 * 1000),
    value,
  }));
}

describe("pairByTimestamp", () => {
  it("returns empty for empty input", () => {
    expect(pairByTimestamp([], [], 86400000)).toEqual([]);
    expect(pairByTimestamp(makePoints([1]), [], 86400000)).toEqual([]);
  });

  it("pairs points within the gap", () => {
    const a = makePoints([70, 71, 72], 3);
    const b = makePoints([120, 130, 140], 3);
    const pairs = pairByTimestamp(a, b);
    expect(pairs).toHaveLength(3);
    expect(pairs[0].a).toBe(70);
    expect(pairs[0].b).toBe(120);
  });

  it("does not pair points beyond maxGap", () => {
    const now = Date.now();
    const a: DataPoint[] = [{ date: new Date(now), value: 70 }];
    const b: DataPoint[] = [
      { date: new Date(now - 3 * 24 * 60 * 60 * 1000), value: 120 },
    ];
    const pairs = pairByTimestamp(a, b, 24 * 60 * 60 * 1000);
    expect(pairs).toHaveLength(0);
  });

  it("uses each point at most once", () => {
    const now = Date.now();
    const a: DataPoint[] = [
      { date: new Date(now), value: 70 },
      { date: new Date(now + 1000), value: 71 },
    ];
    const b: DataPoint[] = [{ date: new Date(now), value: 120 }];
    const pairs = pairByTimestamp(a, b);
    expect(pairs).toHaveLength(1);
  });
});

describe("pearsonCorrelation", () => {
  it("returns null for fewer than minPairs", () => {
    const pairs = [
      { a: 1, b: 2, date: new Date() },
      { a: 2, b: 4, date: new Date() },
    ];
    expect(pearsonCorrelation(pairs)).toBeNull();
  });

  it("detects perfect positive correlation", () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({
      a: i,
      b: i * 2,
      date: new Date(),
    }));
    const result = pearsonCorrelation(pairs)!;
    expect(result.r).toBe(1);
    expect(result.strength).toBe("stark");
    expect(result.n).toBe(10);
  });

  it("detects perfect negative correlation", () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({
      a: i,
      b: 100 - i * 2,
      date: new Date(),
    }));
    const result = pearsonCorrelation(pairs)!;
    expect(result.r).toBe(-1);
    expect(result.strength).toBe("stark");
  });

  it("detects no correlation for random-like data", () => {
    const pairs = [
      { a: 1, b: 5, date: new Date() },
      { a: 2, b: 3, date: new Date() },
      { a: 3, b: 7, date: new Date() },
      { a: 4, b: 2, date: new Date() },
      { a: 5, b: 6, date: new Date() },
    ];
    const result = pearsonCorrelation(pairs)!;
    expect(Math.abs(result.r)).toBeLessThan(0.4);
  });

  it("returns keine for constant values", () => {
    const pairs = Array.from({ length: 5 }, () => ({
      a: 5,
      b: 5,
      date: new Date(),
    }));
    const result = pearsonCorrelation(pairs)!;
    expect(result.r).toBe(0);
    expect(result.strength).toBe("keine");
  });
});

