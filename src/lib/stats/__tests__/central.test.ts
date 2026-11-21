import { describe, expect, it } from "vitest";

import { mean, median, medianAbsoluteDeviation, roundTo } from "../central";

describe("mean", () => {
  it("answers null for no values, never zero or NaN", () => {
    expect(mean([])).toBeNull();
  });

  it("averages the values", () => {
    expect(mean([2])).toBe(2);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("median", () => {
  it("answers null for no values, never zero or NaN", () => {
    expect(median([])).toBeNull();
  });

  it("takes the middle value of an odd count and the mean of two for an even one", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("leaves its input in order", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("medianAbsoluteDeviation", () => {
  it("is the median of the absolute deviations about the median", () => {
    // 1..5: median 3, deviations 2,1,0,1,2, so 1.
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
    expect(medianAbsoluteDeviation([])).toBeNull();
  });
});

describe("roundTo", () => {
  it("rounds to the named number of decimals", () => {
    expect(roundTo(1.25, 1)).toBe(1.3);
    expect(roundTo(1.234, 2)).toBe(1.23);
    expect(roundTo(7.5, 0)).toBe(8);
    expect(roundTo(-1.25, 1)).toBe(-1.2);
  });
});
