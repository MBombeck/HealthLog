/**
 * Timeline buckets and windows (v1.42, #613).
 */
import { describe, expect, it } from "vitest";

import {
  overlaps,
  parseSeriesKeys,
  rangeBucket,
  timelineBucket,
} from "../load-timeline";
import { coveredWeeks, READINESS_WEEKS } from "../readiness";
import { bucketKey, foldDays, foldMonths } from "../series";

describe("buckets", () => {
  it("names a bucket by its first local day, weeks from Monday", () => {
    expect(bucketKey("2026-03-29", "month")).toBe("2026-03-01");
    // 2026-03-29 is a Sunday; its week began on Monday the 23rd.
    expect(bucketKey("2026-03-29", "week")).toBe("2026-03-23");
    expect(bucketKey("2026-03-23", "week")).toBe("2026-03-23");
    expect(bucketKey("2026-03-29", "quarter")).toBe("2026-01-01");
    expect(bucketKey("2026-04-01", "quarter")).toBe("2026-04-01");
    expect(bucketKey("2026-12-31", "quarter")).toBe("2026-10-01");
  });

  it("weighs each day once in a bucket and counts the readings behind it", () => {
    const points = foldDays(
      new Map([
        ["2026-03-01", { value: 100, count: 3 }],
        ["2026-03-02", { value: 110, count: 1 }],
        ["2026-04-01", { value: 90, count: 1 }],
      ]),
      "month",
    );
    expect(points).toEqual([
      { t: "2026-03-01", mean: 105, count: 4 },
      { t: "2026-04-01", mean: 90, count: 1 },
    ]);
  });

  it("leaves a bucket without a reading out rather than filling it", () => {
    const points = foldDays(
      new Map([
        ["2026-02-10", { value: 120, count: 2 }],
        ["2026-06-10", { value: 130, count: 2 }],
        ["2026-08-10", { value: 125, count: 1 }],
      ]),
      "month",
    );
    expect(points.map((p) => p.t)).toEqual([
      "2026-02-01",
      "2026-06-01",
      "2026-08-01",
    ]);
  });

  it("folds rolled-up months into quarters, each month weighing its days", () => {
    expect(
      foldMonths(
        [
          { t: "2026-01-01", mean: 100, days: 30, count: 30 },
          { t: "2026-02-01", mean: 130, days: 10, count: 12 },
          { t: "2026-04-01", mean: 90, days: 2, count: 2 },
        ],
        "quarter",
      ),
    ).toEqual([
      // (100·30 + 130·10) / 40, not the plain mean of the two months (115).
      { t: "2026-01-01", mean: 107.5, count: 42 },
      { t: "2026-04-01", mean: 90, count: 2 },
    ]);
  });

  it("picks the bucket by zoom, quarters only for a long `all`", () => {
    expect(timelineBucket("quarter", "2026-01-01", "2026-03-31")).toBe("week");
    expect(timelineBucket("year", "2025-04-01", "2026-03-31")).toBe("month");
    expect(timelineBucket("all", "2025-01-01", "2026-03-31")).toBe("month");
    expect(timelineBucket("all", "2019-01-01", "2026-03-31")).toBe("quarter");
  });

  it("picks a chosen range's bucket by its length, down to days", () => {
    // Two years and more: quarters.
    expect(rangeBucket("2024-03-31", "2026-03-30")).toBe("quarter");
    expect(rangeBucket("2024-04-01", "2026-03-30")).toBe("month");
    // Four months (120 days) and more: months.
    expect(rangeBucket("2026-01-01", "2026-04-30")).toBe("month");
    expect(rangeBucket("2026-01-02", "2026-04-30")).toBe("week");
    // Six weeks and more: weeks.
    expect(rangeBucket("2026-03-01", "2026-04-11")).toBe("week");
    expect(rangeBucket("2026-03-02", "2026-04-11")).toBe("day");
    expect(rangeBucket("2026-03-01", "2026-03-01")).toBe("day");
    expect(timelineBucket("range", "2026-03-01", "2026-03-14")).toBe("day");
  });

  it("names a day bucket by the day itself", () => {
    expect(bucketKey("2026-03-05", "day")).toBe("2026-03-05");
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

  it("accepts up to six series and refuses a seventh", () => {
    const six = [
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "WEIGHT",
      "PULSE",
      "MOOD",
      "BODY_FAT",
    ];
    expect(parseSeriesKeys(six.join(","))).toEqual(six);
    expect(parseSeriesKeys([...six, "BLOOD_GLUCOSE"].join(","))).toBeNull();
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
