import { describe, it, expect } from "vitest";
import {
  shiftDailySeriesForward,
  averageValue,
  computeComparisonDelta,
} from "@/lib/charts/comparison-shift";

/**
 * v1.4.25 W6 — edge-case end-to-end pinning for the `comparisonBaseline`
 * overlay.
 *
 * The basic shift suite (`comparison-shift.test.ts`) already pins the
 * happy path: integer-day forward shifts, value preservation, empty
 * input → empty output. This file pins the corner cases Marc flagged
 * worry about, in particular:
 *
 *   1. DST transition days — the helper must NOT cross a calendar-day
 *      boundary when the Berlin clock shifts on the last Sunday of
 *      March / October. We anchor sample data at UTC-noon of each
 *      affected day (the dashboard's daily-bucket key contract) and
 *      assert the shifted timestamps still land on the correct
 *      Berlin-calendar day.
 *   2. Leap-year alignment (Feb 29 prior year). A `vs Vorjahr` shift of
 *      365 days from Feb 29 2024 → Feb 28 2025 (one day off because the
 *      calendar year is not 366 days). We pin that behaviour explicitly
 *      so a future refactor can't silently change it.
 *   3. Insufficient prior-period data — the chart's empty-state copy
 *      reads "Comparison unavailable …" only when `hasComparisonData`
 *      is false. Per Marc's directive 2026-05-14 the placeholder is
 *      gone; the renderer just suppresses the overlay cleanly. The
 *      helper supports that by returning empty arrays for empty input.
 *   4. 60-days-of-data, asks for `vs Vorjahr` — the shift moves every
 *      bucket forward 365 days, lands them outside any visible window,
 *      and the merge in `chartDataWithCompare` (verified at the chart
 *      layer) silently drops them. We pin the helper layer here.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("shiftDailySeriesForward — DST transitions", () => {
  it("preserves the calendar-day-of-month across the March DST forward shift", () => {
    // Berlin springs forward 02:00 → 03:00 on Sun 31 Mar 2024. Daily
    // buckets sit at UTC-noon, well clear of the 02:00-03:00 wall-clock
    // jump. We assert the shifted timestamp is still UTC-noon of the
    // expected calendar day.
    const beforeDst = new Date("2024-03-30T12:00:00.000Z").getTime();
    const onDst = new Date("2024-03-31T12:00:00.000Z").getTime();
    const afterDst = new Date("2024-04-01T12:00:00.000Z").getTime();

    const shifted = shiftDailySeriesForward(
      [
        { timestamp: beforeDst, weight: 80.1 },
        { timestamp: onDst, weight: 80.2 },
        { timestamp: afterDst, weight: 80.0 },
      ],
      "lastMonth",
    );

    expect(shifted[0].timestamp).toBe(beforeDst + 30 * MS_PER_DAY);
    expect(shifted[1].timestamp).toBe(onDst + 30 * MS_PER_DAY);
    expect(shifted[2].timestamp).toBe(afterDst + 30 * MS_PER_DAY);

    // The shifted DST point still resolves to UTC-noon on the target
    // day (Apr 30) — verifying that the integer-day add did not drift
    // the timestamp into the next/prev UTC day.
    const shiftedDst = new Date(shifted[1].timestamp);
    expect(shiftedDst.toISOString()).toBe("2024-04-30T12:00:00.000Z");
  });

  it("preserves the calendar-day-of-month across the October DST backward shift", () => {
    // Berlin falls back 03:00 → 02:00 on Sun 27 Oct 2024.
    const beforeDst = new Date("2024-10-26T12:00:00.000Z").getTime();
    const onDst = new Date("2024-10-27T12:00:00.000Z").getTime();
    const afterDst = new Date("2024-10-28T12:00:00.000Z").getTime();

    const shifted = shiftDailySeriesForward(
      [
        { timestamp: beforeDst, value: 1 },
        { timestamp: onDst, value: 2 },
        { timestamp: afterDst, value: 3 },
      ],
      "lastMonth",
    );

    expect(new Date(shifted[0].timestamp).toISOString()).toBe(
      "2024-11-25T12:00:00.000Z",
    );
    expect(new Date(shifted[1].timestamp).toISOString()).toBe(
      "2024-11-26T12:00:00.000Z",
    );
    expect(new Date(shifted[2].timestamp).toISOString()).toBe(
      "2024-11-27T12:00:00.000Z",
    );
  });
});

describe("shiftDailySeriesForward — leap year", () => {
  it("`lastYear` shift of Feb 29 2024 lands on Feb 28 2025 (365-day add)", () => {
    // The shift is integer-365-day forward; it does NOT account for the
    // leap-year extra day. This is intentional — the dashboard's prior
    // period is "365 days ago", not "the same calendar date last year".
    // We pin the behaviour so a future refactor doesn't silently change
    // the contract.
    const feb29 = new Date("2024-02-29T12:00:00.000Z").getTime();
    const shifted = shiftDailySeriesForward(
      [{ timestamp: feb29, value: 75 }],
      "lastYear",
    );
    expect(new Date(shifted[0].timestamp).toISOString()).toBe(
      "2025-02-28T12:00:00.000Z",
    );
  });

  it("`lastYear` shift of Mar 1 2024 lands on Mar 1 2025 (365-day add crosses Feb 28)", () => {
    const mar1 = new Date("2024-03-01T12:00:00.000Z").getTime();
    const shifted = shiftDailySeriesForward(
      [{ timestamp: mar1, value: 75 }],
      "lastYear",
    );
    expect(new Date(shifted[0].timestamp).toISOString()).toBe(
      "2025-03-01T12:00:00.000Z",
    );
  });
});

describe("hasComparisonData semantics — insufficient prior-period data", () => {
  /**
   * The chart layer derives `hasComparisonData` by checking whether any
   * visible day has a `${type}_compare` value. We model that here with
   * a tiny `mergeShifted` helper that mirrors the chart's behaviour:
   * a prior-period point only paints when its shifted timestamp lands
   * on a visible day-key.
   */
  function mergeShifted(
    visibleDayKeys: string[],
    shifted: Array<{ timestamp: number; value: number }>,
    dayKeyOf: (ms: number) => string,
  ): boolean {
    const set = new Set(visibleDayKeys);
    return shifted.some((row) => set.has(dayKeyOf(row.timestamp)));
  }

  const utcDayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it("60 days of current data + `lastYear` request → overlay drops cleanly (no overlap)", () => {
    // 60 visible days, ending today. The shifted-prior series is 365
    // days later than the input — so a 60-day input produces 60 points
    // that all land 365 days AFTER the visible window's start (not
    // ON it). With no prior-year input rows seeded, the shifted set
    // is empty → no overlay.
    const today = new Date("2026-05-14T12:00:00.000Z").getTime();
    const visibleDays: string[] = [];
    for (let i = 0; i < 60; i++) {
      visibleDays.push(utcDayKey(today - i * MS_PER_DAY));
    }

    // No prior-year data exists yet (user only has 60 days of history).
    const priorYearInput: Array<{ timestamp: number; value: number }> = [];
    const shifted = shiftDailySeriesForward(priorYearInput, "lastYear");
    expect(shifted).toHaveLength(0);
    expect(mergeShifted(visibleDays, shifted, utcDayKey)).toBe(false);
  });

  it("400 days of data + `lastYear` → some prior days align with visible window", () => {
    // 400 days of history means the prior-year window (365 days ago)
    // sits inside the visible 30-day chart window. The shift moves
    // those prior-year points forward 365 days and they should land on
    // the visible day-keys.
    const today = new Date("2026-05-14T12:00:00.000Z").getTime();
    const visibleStart = today - 30 * MS_PER_DAY;
    const visibleDays: string[] = [];
    for (let i = 0; i <= 30; i++) {
      visibleDays.push(utcDayKey(visibleStart + i * MS_PER_DAY));
    }
    // Seed prior-year data: 30 days at exactly 365 days back from the
    // visible window.
    const priorYearInput: Array<{ timestamp: number; value: number }> = [];
    for (let i = 0; i <= 30; i++) {
      priorYearInput.push({
        timestamp: visibleStart + i * MS_PER_DAY - 365 * MS_PER_DAY,
        value: 80 + i * 0.1,
      });
    }
    const shifted = shiftDailySeriesForward(priorYearInput, "lastYear");
    expect(shifted).toHaveLength(31);
    expect(mergeShifted(visibleDays, shifted, utcDayKey)).toBe(true);
  });

  it("partial prior-period coverage flags hasComparisonData = true (chart contract)", () => {
    // The chart's `hasComparisonData` is true when ANY visible day has
    // a prior value — partial overlap counts. Pin that contract here.
    const today = new Date("2026-05-14T12:00:00.000Z").getTime();
    const visibleDays = [utcDayKey(today), utcDayKey(today - MS_PER_DAY)];
    // Only the older of the two days has a prior-month value.
    const priorInput = [
      {
        timestamp: today - MS_PER_DAY - 30 * MS_PER_DAY,
        value: 70,
      },
    ];
    const shifted = shiftDailySeriesForward(priorInput, "lastMonth");
    expect(mergeShifted(visibleDays, shifted, utcDayKey)).toBe(true);
  });
});

describe("averageValue + computeComparisonDelta — tile caption math", () => {
  it("tile delta math survives a partial-data prior window", () => {
    const currentAvg = averageValue([80.5, 80.7, 80.9, 81.0, 81.2]);
    // Only 2 prior readings exist — averageValue handles that fine.
    const priorAvg = averageValue([82.0, 82.4]);
    expect(currentAvg).toBeCloseTo(80.86, 2);
    expect(priorAvg).toBe(82.2);
    expect(computeComparisonDelta(currentAvg, priorAvg)).toBeCloseTo(-1.34, 2);
  });

  it("tile delta math returns null when the prior window is empty", () => {
    const currentAvg = averageValue([80.5, 80.7, 80.9]);
    const priorAvg = averageValue([]);
    expect(currentAvg).toBeCloseTo(80.7, 2);
    expect(priorAvg).toBeNull();
    // The contract: if either side is null, the delta is null so the
    // tile suppresses the comparison callout cleanly.
    expect(computeComparisonDelta(currentAvg, priorAvg)).toBeNull();
  });
});
