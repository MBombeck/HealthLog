import { describe, it, expect } from "vitest";
import {
  trendSlope,
  detectAnomalies,
  summarize,
  wireSummary,
  type DataPoint,
} from "../trends";
import { summaryToTrend7Delta } from "../trend-delta";

function makePoints(values: number[], startDaysAgo = 30): DataPoint[] {
  const now = Date.now();
  return values.map((value, i) => ({
    date: new Date(now - (startDaysAgo - i) * 24 * 60 * 60 * 1000),
    value,
  }));
}

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

/**
 * A window earns a trend only when its readings cover enough days. A
 * dashboard blood-pressure tile read "7-Tage-Trend: 125 (−11.412)" because
 * the only readings of the week were taken minutes apart: the fit's x-span
 * was minutes, the slope per day exploded, and the tile multiplied it by 7.
 */
describe("trendSlope minimum evidence", () => {
  const NOW = Date.UTC(2026, 9, 24, 18, 0, 0);
  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;
  const at = (msAgo: number, value: number): DataPoint => ({
    date: new Date(NOW - msAgo),
    value,
  });

  it("withholds the slope when the readings are minutes apart", () => {
    // Three readings in one sitting this morning: 130, 124, 118 mmHg.
    const sitting = [
      at(10 * MINUTE, 130),
      at(8 * MINUTE, 124),
      at(6 * MINUTE, 118),
    ];
    expect(trendSlope(sitting, 7, NOW)).toBeNull();
    expect(trendSlope(sitting, 30, NOW)).toBeNull();
  });

  it("withholds the slope across midnight even though two days are touched", () => {
    const today = Math.floor(NOW / DAY) * DAY;
    const straddle = [
      { date: new Date(today - 2 * MINUTE), value: 130 },
      { date: new Date(today + 2 * MINUTE), value: 118 },
    ];
    expect(trendSlope(straddle, 7, NOW)).toBeNull();
  });

  it("withholds the slope for two readings on two days", () => {
    // Two days five days apart: a line through two points says nothing
    // about noise, so it is not a trend.
    const two = [at(5 * DAY, 130), at(0, 120)];
    expect(trendSlope(two, 7, NOW)).toBeNull();
    expect(trendSlope(two, 30, NOW)).toBeNull();
  });

  it("withholds the slope when three days cover too little of the window", () => {
    // Three consecutive days: a span of 2 against the 4 a 7-day window
    // needs, and the 15 a 30-day window needs.
    const consecutive = [at(2 * DAY, 128), at(1 * DAY, 126), at(0, 124)];
    expect(trendSlope(consecutive, 7, NOW)).toBeNull();
    expect(trendSlope(consecutive, 30, NOW)).toBeNull();
  });

  it("fits sparse 30-day data that spans the window, not the empty week", () => {
    // Three readings 25, 14 and 9 days ago: nothing in the 7-day window,
    // 16 days of span in the 30-day one.
    const sparse = [at(25 * DAY, 130), at(14 * DAY, 127), at(9 * DAY, 125)];
    expect(trendSlope(sparse, 7, NOW)).toBeNull();
    const slope30 = trendSlope(sparse, 30, NOW);
    expect(slope30).not.toBeNull();
    expect(slope30!.direction).toBe("down");
    // About −0.31 mmHg per day: a plausible drift, not thousands.
    expect(slope30!.slope).toBeGreaterThan(-0.5);
    expect(slope30!.slope).toBeLessThan(-0.2);
  });

  it("fits normal daily data", () => {
    const daily = [0, 1, 2, 3, 4, 5, 6].map((d) => at((6 - d) * DAY, 80 + d));
    const slope7 = trendSlope(daily, 7, NOW);
    expect(slope7).toEqual({ slope: 1, direction: "up", confidence: 1 });
  });

  it("keeps a same-session cluster from dominating a window that earned a trend", () => {
    // A week of single daily readings, rising one mmHg a day, plus a
    // morning session of three readings minutes apart that wobble by 12.
    const week = [0, 1, 2, 3, 4, 5].map((d) => at((7 - d) * DAY, 120 + d));
    const sitting = [
      at(10 * MINUTE, 130),
      at(8 * MINUTE, 124),
      at(6 * MINUTE, 118),
    ];
    const slope7 = trendSlope([...week, ...sitting], 7, NOW);
    expect(slope7).not.toBeNull();
    expect(Math.abs(slope7!.slope)).toBeLessThan(2);
  });

  it("leaves the dashboard tile without a 7-day delta for one sitting", () => {
    // The tile's delta is `summaryToTrend7Delta(summary)`: slope7 × 7,
    // else slope30 × 7. Before the minimum-evidence rule this summary
    // yielded about −15,000 mmHg; now neither window carries a slope.
    const sitting = [
      { date: new Date(Date.now() - 10 * MINUTE), value: 130 },
      { date: new Date(Date.now() - 8 * MINUTE), value: 124 },
      { date: new Date(Date.now() - 6 * MINUTE), value: 118 },
    ];
    const summary = summarize(sitting);
    expect(summary.avg7).toBe(124);
    expect(summary.slope7).toBeNull();
    expect(summary.slope30).toBeNull();
    expect(summaryToTrend7Delta(summary)).toBeNull();
  });

  it("falls back to a sane 30-day delta when only the week is one sitting", () => {
    // Earlier readings across the month earn the 30-day window a trend;
    // the week's sitting does not earn the 7-day window one. The tile
    // shows the 30-day slope projected onto 7 days: a few mmHg.
    const month = [28, 21, 14, 9].map((d, i) => ({
      date: new Date(Date.now() - d * DAY),
      value: 132 - i,
    }));
    const sitting = [
      { date: new Date(Date.now() - 10 * MINUTE), value: 130 },
      { date: new Date(Date.now() - 8 * MINUTE), value: 124 },
      { date: new Date(Date.now() - 6 * MINUTE), value: 118 },
    ];
    const summary = summarize([...month, ...sitting]);
    expect(summary.slope7).toBeNull();
    expect(summary.slope30).not.toBeNull();
    const delta = summaryToTrend7Delta(summary);
    expect(delta).not.toBeNull();
    expect(Math.abs(delta!)).toBeLessThan(10);
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
    expect(summary.median).toBeNull();
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
    // 11 values — odd length, median is the 6th value (75).
    expect(summary.median).toBe(75);
    expect(summary.avg7).not.toBeNull();
    expect(summary.slope7).not.toBeNull();
  });

  // v1.8.5 — median powers the category-page stat strip. It must be the
  // 50th percentile over VALUES (not timestamps) and must resist a skew
  // the mean would otherwise hide.
  it("computes the median over an even-length series as the midpoint", () => {
    // Four values; median = (72 + 74) / 2 = 73. Insertion order is
    // intentionally not sorted to prove the helper sorts by value.
    const data = makePoints([74, 70, 72, 76], 4);
    const summary = summarize(data);
    expect(summary.median).toBe(73);
  });

  it("median diverges from the mean on a right-skewed series", () => {
    // One large outlier drags the mean up; the median stays at the
    // central reading — exactly the honesty the stat strip surfaces.
    const data = makePoints([10, 11, 12, 13, 200], 5);
    const summary = summarize(data);
    expect(summary.median).toBe(12);
    expect(summary.mean).not.toBe(summary.median);
    expect(summary.mean as number).toBeGreaterThan(summary.median as number);
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

describe("wireSummary", () => {
  it("drops the in-process anomaly count and keeps every published statistic", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, i + 1)),
      value: i === 9 ? 400 : 70 + i,
    }));
    const full = summarize(data);
    expect(full).toHaveProperty("anomalyCount");

    const wire = wireSummary(full);
    expect(wire).not.toHaveProperty("anomalyCount");
    const { anomalyCount: _dropped, ...rest } = full;
    expect(wire).toEqual(rest);
  });
});
