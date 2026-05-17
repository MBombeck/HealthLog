/**
 * v1.5.0 — unit tests for the rollup-read aggregation helpers.
 *
 * Pins the `count` / `min` / `max` / `mean` re-aggregation across
 * DAY buckets — the linearly-composable subset of the
 * comprehensive-aggregator's `DataSummary` shape that survives
 * round-tripping through the rollup table.
 */
import { describe, expect, it } from "vitest";

import { aggregateBuckets, type DailyMeanRow } from "../rollup-read";

const dayA: DailyMeanRow = {
  day: new Date("2026-05-08T00:00:00.000Z"),
  count: 2,
  mean: 80,
  minValue: 79,
  maxValue: 81,
};
const dayB: DailyMeanRow = {
  day: new Date("2026-05-09T00:00:00.000Z"),
  count: 3,
  mean: 82,
  minValue: 80,
  maxValue: 84,
};
const dayC: DailyMeanRow = {
  day: new Date("2026-05-10T00:00:00.000Z"),
  count: 5,
  mean: 83,
  minValue: 81,
  maxValue: 86,
};

describe("aggregateBuckets", () => {
  it("returns the empty-window shape when given no rows", () => {
    expect(aggregateBuckets([])).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null,
    });
  });

  it("sums count and folds min / max across days", () => {
    const result = aggregateBuckets([dayA, dayB, dayC]);
    expect(result.count).toBe(10);
    expect(result.min).toBe(79);
    expect(result.max).toBe(86);
  });

  it("weighs the mean by daily count (not equal-weight)", () => {
    const result = aggregateBuckets([dayA, dayB, dayC]);
    // Σ(count × mean) / Σcount = (2×80 + 3×82 + 5×83) / 10
    //                          = (160 + 246 + 415) / 10
    //                          = 82.1
    expect(result.mean).toBeCloseTo(82.1, 5);
  });

  it("handles a single bucket without arithmetic drift", () => {
    const result = aggregateBuckets([dayB]);
    expect(result.count).toBe(3);
    expect(result.min).toBe(80);
    expect(result.max).toBe(84);
    expect(result.mean).toBe(82);
  });
});
