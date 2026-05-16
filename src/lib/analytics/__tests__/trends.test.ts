import { describe, it, expect } from "vitest";
import {
  movingAverage,
  trendSlope,
  detectAnomalies,
  summarize,
  type DataPoint,
} from "../trends";

function makePoints(values: number[], startDaysAgo = 30): DataPoint[] {
  const now = Date.now();
  return values.map((value, i) => ({
    date: new Date(now - (startDaysAgo - i) * 24 * 60 * 60 * 1000),
    value,
  }));
}

describe("movingAverage", () => {
  it("returns empty for empty input", () => {
    expect(movingAverage([], 7)).toEqual([]);
  });

  it("calculates moving average over window", () => {
    const data = makePoints([70, 71, 72, 73, 74, 75, 76], 7);
    const result = movingAverage(data, 3);
    expect(result).toHaveLength(7);
    // Last point should be avg of last 3 days
    expect(result[result.length - 1].value).toBeCloseTo(75, 0);
  });

  it("handles single data point", () => {
    const data = makePoints([100], 1);
    const result = movingAverage(data, 7);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(100);
  });
});

describe("trendSlope", () => {
  it("returns null for insufficient data", () => {
    expect(trendSlope([], 7)).toBeNull();
    expect(trendSlope(makePoints([70]), 7)).toBeNull();
  });

  it("detects upward trend", () => {
    const data = makePoints([70, 71, 72, 73, 74, 75, 76], 7);
    const result = trendSlope(data, 7);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("up");
    expect(result!.slope).toBeGreaterThan(0);
    expect(result!.confidence).toBeGreaterThan(0.9);
  });

  it("detects downward trend", () => {
    const data = makePoints([80, 79, 78, 77, 76, 75, 74], 7);
    const result = trendSlope(data, 7);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("down");
    expect(result!.slope).toBeLessThan(0);
  });

  it("detects stable trend", () => {
    const data = makePoints([75, 75, 75, 75, 75, 75, 75], 7);
    const result = trendSlope(data, 7);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("stable");
    expect(Math.abs(result!.slope)).toBeLessThan(0.01);
  });
});

describe("detectAnomalies", () => {
  it("returns empty for insufficient data", () => {
    expect(detectAnomalies(makePoints([70, 71]))).toEqual([]);
  });

  it("detects outliers", () => {
    const values = [75, 75, 75, 75, 75, 75, 75, 75, 75, 100];
    const data = makePoints(values, 10);
    const anomalies = detectAnomalies(data, 2);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0].value).toBe(100);
  });

  it("returns empty for uniform data", () => {
    const data = makePoints([75, 75, 75, 75, 75], 5);
    const anomalies = detectAnomalies(data);
    expect(anomalies).toEqual([]);
  });
});

describe("summarize", () => {
  it("returns null stats (not zero) for empty input", () => {
    const summary = summarize([]);
    expect(summary.count).toBe(0);
    expect(summary.latest).toBeNull();
    // v3 audit fix: previously returned 0/0/0 sentinels which leaked into
    // chart axes and tile renders as "real" readings.
    expect(summary.min).toBeNull();
    expect(summary.max).toBeNull();
    expect(summary.mean).toBeNull();
    expect(summary.avg7).toBeNull();
    expect(summary.avg30).toBeNull();
  });

  it("calculates correct summary", () => {
    const data = makePoints([70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80], 11);
    const summary = summarize(data);
    expect(summary.count).toBe(11);
    expect(summary.latest).toBe(80);
    expect(summary.min).toBe(70);
    expect(summary.max).toBe(80);
    expect(summary.mean).toBe(75);
    expect(summary.avg7).not.toBeNull();
    expect(summary.slope7).not.toBeNull();
  });

  // v3 audit caught a divergence: summarize().avg7 used `now` as the
  // window anchor, while trendSlope() used the last point. A stale
  // series (no readings for weeks) reported a slope but no average.
  // Both are now `now`-anchored, so a stale series returns null
  // consistently across stat fields.
  it("aligns trendSlope and avg windows on `now`, not on the last point", () => {
    const stale = [70, 71, 72, 73, 74, 75, 76].map((value, i) => ({
      // 100 days ago, all consecutive — last point still 100 days old.
      date: new Date(Date.now() - (100 - i) * 24 * 60 * 60 * 1000),
      value,
    }));
    const summary = summarize(stale);
    expect(summary.avg7).toBeNull(); // no readings in last 7 days
    expect(summary.avg30).toBeNull(); // no readings in last 30 days
    expect(summary.slope7).toBeNull(); // window snaps to `now`, no points
    expect(summary.slope30).toBeNull(); // same
  });

  // v1.4.33 P0 regression — production stacktrace
  // `RangeError: Maximum call stack size exceeded` at index 3 of the
  // analytics route's per-type `Promise.all` (PULSE).
  //
  // Root cause: `Math.min(...values)` / `Math.max(...values)` spread the
  // whole series as function arguments. V8 caps function arity at
  // ~125 000-130 000; an Apple-Health-synced PULSE series easily
  // exceeds that for a multi-year power user. The fix folds min/max via
  // a single pass instead, keeping the working set bounded.
  it("survives a multi-hundred-thousand-row series without blowing the stack", () => {
    // 250 000 points — well above V8's spread-arg ceiling. The
    // unrolled values give us deterministic min/max so we can assert
    // both the safety contract AND the correctness contract in one go.
    const N = 250_000;
    const now = Date.now();
    const data: DataPoint[] = new Array(N);
    for (let i = 0; i < N; i++) {
      data[i] = {
        date: new Date(now - (N - i) * 1000),
        // Wave between 40 and 199; min=40, max=199.
        value: 40 + (i % 160),
      };
    }
    // Must not throw — before the fix this raised
    // `RangeError: Maximum call stack size exceeded`.
    const summary = summarize(data);
    expect(summary.count).toBe(N);
    expect(summary.min).toBe(40);
    expect(summary.max).toBe(199);
    expect(summary.latest).toBe(data[N - 1].value);
  });
});
