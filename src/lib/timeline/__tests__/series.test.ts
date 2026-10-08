/**
 * Timeline buckets and windows (v1.42, #613).
 */
import { describe, expect, it } from "vitest";

import { overlaps, parseSeriesKeys } from "../load-timeline";
import { coveredWeeks, READINESS_WEEKS } from "../readiness";
import { bucketKey, foldDays } from "../series";

describe("buckets", () => {
  it("names a bucket by its first local day, weeks from Monday", () => {
    expect(bucketKey("2026-03-29", "month")).toBe("2026-03-01");
    // 2026-03-29 is a Sunday; its week began on Monday the 23rd.
    expect(bucketKey("2026-03-29", "week")).toBe("2026-03-23");
    expect(bucketKey("2026-03-23", "week")).toBe("2026-03-23");
    expect(bucketKey("2026-03-29", "day")).toBe("2026-03-29");
  });

  it("weighs each day once in a bucket", () => {
    const points = foldDays(
      new Map([
        ["2026-03-01", 100],
        ["2026-03-02", 110],
        ["2026-04-01", 90],
      ]),
      "month",
    );
    expect(points).toEqual([
      { t: "2026-03-01", mean: 105 },
      { t: "2026-04-01", mean: 90 },
    ]);
  });
});

describe("window", () => {
  it("keeps an open span up to today and drops what lies outside", () => {
    const open = { start: "2020-01-01", end: null, open: true };
    expect(overlaps(open, "2026-01-01", "2026-03-31", "2026-03-31")).toBe(true);
    const point = { start: "2025-12-31", end: null, open: false };
    expect(overlaps(point, "2026-01-01", "2026-03-31", "2026-03-31")).toBe(
      false,
    );
    const closed = { start: "2025-06-01", end: "2026-01-05", open: false };
    expect(overlaps(closed, "2026-01-01", "2026-03-31", "2026-03-31")).toBe(
      true,
    );
  });

  it("accepts known series only", () => {
    expect(parseSeriesKeys(undefined)).toEqual([
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "WEIGHT",
    ]);
    expect(parseSeriesKeys("WEIGHT,MOOD,WEIGHT")).toEqual(["WEIGHT", "MOOD"]);
    expect(parseSeriesKeys("WEIGHT,DROP TABLE")).toBeNull();
  });
});

describe("readiness weeks", () => {
  it("counts the weeks of the last thirteen that hold a day", () => {
    const today = "2026-03-29";
    expect(
      coveredWeeks(["2026-03-29", "2026-03-23", "2026-03-22"], today),
    ).toBe(2);
    expect(coveredWeeks(["2025-01-01"], today)).toBe(0);
    expect(READINESS_WEEKS).toBe(13);
  });
});
