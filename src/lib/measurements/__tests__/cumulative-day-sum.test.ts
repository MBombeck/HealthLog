import { describe, expect, it } from "vitest";

import {
  CUMULATIVE_DAY_SUM_TYPES,
  isCumulativeDaySumType,
  pickCumulativeDaySum,
} from "../cumulative-day-sum";

/**
 * v1.4.36 W4c — pickCumulativeDaySum unit tests.
 *
 * The helper bucket-and-sums a series of cumulative samples per
 * `dayKey(measuredAt)`. Tested in pure ISO-date space so the
 * tz-aware caller (analytics route) can layer its own `userDayKey`
 * on top without dragging a TZ runtime into the helper.
 */

// Use an ISO-date key so the test stays deterministic without a TZ.
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

describe("pickCumulativeDaySum", () => {
  it("returns an empty array when the input is empty", () => {
    expect(pickCumulativeDaySum([], isoDay)).toEqual([]);
  });

  it("sums a single source within one day to one point", () => {
    const result = pickCumulativeDaySum(
      [
        { measuredAt: new Date("2026-05-17T08:00:00Z"), value: 1200 },
        { measuredAt: new Date("2026-05-17T12:30:00Z"), value: 2500 },
        { measuredAt: new Date("2026-05-17T19:45:00Z"), value: 4300 },
      ],
      isoDay,
    );
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(8000);
    // The bucket's date is the latest measuredAt in that bucket.
    expect(result[0].date.toISOString()).toBe("2026-05-17T19:45:00.000Z");
  });

  it("preserves source-priority ordering by ignoring it (caller's job)", () => {
    // The helper does not look at `source`. Two sources collapsed in
    // ONE bucket would double-count — the analytics route prevents
    // that by running `pickCanonicalSourceRows` first. The helper's
    // contract is: trust the input order, just bucket-and-sum.
    const result = pickCumulativeDaySum(
      [
        { measuredAt: new Date("2026-05-17T08:00:00Z"), value: 1000 },
        { measuredAt: new Date("2026-05-17T08:00:00Z"), value: 1500 },
      ],
      isoDay,
    );
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(2500);
  });

  it("buckets multiple days and only sums within each day", () => {
    const result = pickCumulativeDaySum(
      [
        // Day 1 — total 5000
        { measuredAt: new Date("2026-05-15T08:00:00Z"), value: 2000 },
        { measuredAt: new Date("2026-05-15T20:00:00Z"), value: 3000 },
        // Day 2 — total 1200
        { measuredAt: new Date("2026-05-16T09:00:00Z"), value: 700 },
        { measuredAt: new Date("2026-05-16T11:00:00Z"), value: 500 },
        // Day 3 — total 9000 (today)
        { measuredAt: new Date("2026-05-17T07:00:00Z"), value: 4000 },
        { measuredAt: new Date("2026-05-17T13:00:00Z"), value: 5000 },
      ],
      isoDay,
    );
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.value)).toEqual([5000, 1200, 9000]);
    // Output is sorted ascending by date.
    expect(result[0].date.toISOString()).toBe("2026-05-15T20:00:00.000Z");
    expect(result[2].date.toISOString()).toBe("2026-05-17T13:00:00.000Z");
  });

  it("each bucket's date is the latest measuredAt in that bucket", () => {
    const result = pickCumulativeDaySum(
      [
        { measuredAt: new Date("2026-05-17T07:00:00Z"), value: 100 },
        { measuredAt: new Date("2026-05-17T15:00:00Z"), value: 200 },
        { measuredAt: new Date("2026-05-17T10:00:00Z"), value: 50 },
      ],
      isoDay,
    );
    expect(result).toHaveLength(1);
    expect(result[0].date.toISOString()).toBe("2026-05-17T15:00:00.000Z");
    expect(result[0].value).toBe(350);
  });
});

describe("isCumulativeDaySumType", () => {
  it("returns true for every metric in the canonical list", () => {
    for (const t of CUMULATIVE_DAY_SUM_TYPES) {
      expect(isCumulativeDaySumType(t)).toBe(true);
    }
  });

  it("returns false for non-cumulative types", () => {
    expect(isCumulativeDaySumType("BLOOD_PRESSURE_SYSTOLIC")).toBe(false);
    expect(isCumulativeDaySumType("WEIGHT")).toBe(false);
    expect(isCumulativeDaySumType("SLEEP_DURATION")).toBe(false);
    expect(isCumulativeDaySumType("MOOD")).toBe(false);
  });
});
