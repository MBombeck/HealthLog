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
  it("returns empty summary for empty input", () => {
    const summary = summarize([]);
    expect(summary.count).toBe(0);
    expect(summary.latest).toBeNull();
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
});
