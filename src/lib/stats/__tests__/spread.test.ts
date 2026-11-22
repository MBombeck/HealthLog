import { describe, expect, it } from "vitest";

import {
  READING_SPREAD,
  standardDeviation,
  variance,
  varianceOfCounts,
} from "../spread";

describe("spread", () => {
  const values = [120, 130, 140];

  it("divides by n for a population and by n - 1 for a sample", () => {
    expect(variance(values, "population")).toBeCloseTo(200 / 3, 10);
    expect(variance(values, "sample")).toBe(100);
    expect(standardDeviation(values, "sample")).toBe(10);
  });

  it("is undefined below what the kind needs", () => {
    expect(variance([], "population")).toBeNull();
    expect(variance([5], "population")).toBe(0);
    expect(variance([5], "sample")).toBeNull();
  });

  it("reports readings as a population", () => {
    expect(READING_SPREAD).toBe("population");
  });

  it("gives readings folded to value counts the variance of the readings", () => {
    const counts: Array<[number, number]> = [
      [120, 2],
      [130, 1],
      [140, 3],
    ];
    const readings = [120, 120, 130, 140, 140, 140];
    for (const kind of ["population", "sample"] as const) {
      expect(varianceOfCounts(counts, kind)).toBeCloseTo(
        variance(readings, kind)!,
        10,
      );
    }
    expect(varianceOfCounts([], "population")).toBeNull();
    expect(varianceOfCounts([[5, 1]], "sample")).toBeNull();
  });
});
