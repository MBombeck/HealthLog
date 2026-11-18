import { describe, it, expect } from "vitest";

import {
  composeDelta,
  rangeTrend,
  rangeWindowDays,
  sliceWindowDelta,
  type WindowAggregate,
} from "@/lib/analytics/range-delta";
import type { RollupBucketRow } from "@/lib/rollups/measurement-read-wmy";

/**
 * v1.9.0 — the period-over-period range delta is two reads composed into one
 * caption. The composition (slice the buckets into the current vs previous
 * halves, aggregate each, derive the delta) is the load-bearing logic and is
 * pure over the bucket rows — pinned here without a DB.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function bucket(daysAgo: number, count: number, mean: number): RollupBucketRow {
  return {
    bucketStart: new Date(Date.now() - daysAgo * DAY_MS),
    count,
    mean,
    sd: null,
    slope: null,
    r2: null,
    sumValue: count * mean,
    minValue: mean,
    maxValue: mean,
  };
}

describe("rangeWindowDays", () => {
  it("maps each range onto its trailing-window length", () => {
    expect(rangeWindowDays("7d")).toBe(7);
    expect(rangeWindowDays("30d")).toBe(30);
    expect(rangeWindowDays("90d")).toBe(90);
    expect(rangeWindowDays("1y")).toBe(365);
  });
});

describe("sliceWindowDelta", () => {
  it("splits buckets into the current and previous halves by bucketStart", () => {
    const now = Date.now();
    // 30d window: current = [now-30, now), previous = [now-60, now-30).
    const rows = [
      bucket(5, 2, 80), // current
      bucket(20, 3, 82), // current
      bucket(40, 2, 70), // previous
      bucket(55, 2, 74), // previous
    ];
    const { current, previous } = sliceWindowDelta(rows, 30, now);
    expect(current.count).toBe(5);
    expect(previous.count).toBe(4);
    // Count-weighted means compose linearly across buckets.
    expect(current.mean).toBeCloseTo((2 * 80 + 3 * 82) / 5, 6);
    expect(previous.mean).toBeCloseTo((2 * 70 + 2 * 74) / 4, 6);
  });

  it("excludes buckets outside the 2N span", () => {
    const now = Date.now();
    const rows = [
      bucket(5, 1, 90), // current
      bucket(40, 1, 80), // previous
      bucket(200, 1, 50), // outside both halves
    ];
    const { current, previous } = sliceWindowDelta(rows, 30, now);
    expect(current.count).toBe(1);
    expect(previous.count).toBe(1);
  });

  it("yields empty aggregates when no bucket falls in a half", () => {
    const now = Date.now();
    const rows = [bucket(5, 4, 100)]; // only current half populated
    const { current, previous } = sliceWindowDelta(rows, 30, now);
    expect(current.count).toBe(4);
    expect(previous.count).toBe(0);
    expect(previous.mean).toBeNull();
  });
});

describe("composeDelta", () => {
  const win = (count: number, mean: number | null): WindowAggregate => ({
    count,
    min: mean,
    max: mean,
    mean,
    sum: mean === null ? null : count * mean,
  });

  it("computes the signed delta and percentage", () => {
    const { delta, deltaPct } = composeDelta(win(5, 103), win(5, 100));
    expect(delta).toBeCloseTo(3, 6);
    expect(deltaPct).toBeCloseTo(0.03, 6);
  });

  it("returns null delta when either window is empty", () => {
    expect(composeDelta(win(0, null), win(5, 100))).toEqual({
      delta: null,
      deltaPct: null,
    });
    expect(composeDelta(win(5, 100), win(0, null))).toEqual({
      delta: null,
      deltaPct: null,
    });
  });

  it("returns null deltaPct (not Infinity) when the prior mean is zero", () => {
    const { delta, deltaPct } = composeDelta(win(5, 4), win(3, 0));
    expect(delta).toBeCloseTo(4, 6);
    expect(deltaPct).toBeNull();
  });

  it("captures a negative move", () => {
    const { delta, deltaPct } = composeDelta(win(5, 90), win(5, 100));
    expect(delta).toBeCloseTo(-10, 6);
    expect(deltaPct).toBeCloseTo(-0.1, 6);
  });
});

describe("rangeTrend — the one direction the tile and the page share (#176)", () => {
  it("reads a change at or above the noise floor as a direction", () => {
    expect(rangeTrend(0.1)).toBe("up");
    expect(rangeTrend(-0.05)).toBe("down");
  });

  it("reads a change under the floor as flat, and no comparison as unknown", () => {
    expect(rangeTrend(0.049)).toBe("flat");
    expect(rangeTrend(-0.01)).toBe("flat");
    expect(rangeTrend(0)).toBe("flat");
    expect(rangeTrend(null)).toBe("unknown");
  });
});
