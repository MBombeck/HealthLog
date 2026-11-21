import { describe, it, expect } from "vitest";
import {
  shiftDailySeriesForward,
  COMPARISON_SHIFT_DAYS,
} from "@/lib/charts/comparison-shift";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * v1.4.16 — comparison shift unit tests.
 *
 * The shift is integer-day forward addition; the helper does not care
 * about timezones because every input timestamp is already anchored at
 * UTC-noon of a Berlin calendar day (the chart's daily bucket key).
 */
describe("shiftDailySeriesForward()", () => {
  it("shifts every row's timestamp forward by 30 days for lastMonth", () => {
    const base = new Date("2026-01-15T12:00:00Z").getTime();
    const rows = [
      { timestamp: base, value: 10 },
      { timestamp: base + MS_PER_DAY, value: 11 },
    ];
    const shifted = shiftDailySeriesForward(rows, "lastMonth");
    expect(shifted).toHaveLength(2);
    expect(shifted[0].timestamp).toBe(base + 30 * MS_PER_DAY);
    expect(shifted[1].timestamp).toBe(base + 31 * MS_PER_DAY);
    // value field is preserved verbatim.
    expect(shifted[0].value).toBe(10);
    expect(shifted[1].value).toBe(11);
  });

  it("shifts every row's timestamp forward by 365 days for lastYear", () => {
    const base = new Date("2025-01-15T12:00:00Z").getTime();
    const rows = [{ timestamp: base, value: 7 }];
    const shifted = shiftDailySeriesForward(rows, "lastYear");
    expect(shifted[0].timestamp).toBe(base + 365 * MS_PER_DAY);
  });

  it("returns an empty array for an empty input", () => {
    expect(shiftDailySeriesForward([], "lastMonth")).toEqual([]);
    expect(shiftDailySeriesForward([], "lastYear")).toEqual([]);
  });

  it("preserves arbitrary additional row fields", () => {
    const base = new Date("2026-03-01T12:00:00Z").getTime();
    const rows = [
      { timestamp: base, label: "row-1", weight: 80, BLOOD_PRESSURE_SYS: 120 },
    ];
    const shifted = shiftDailySeriesForward(rows, "lastMonth");
    expect(shifted[0].label).toBe("row-1");
    expect(shifted[0].weight).toBe(80);
    expect(shifted[0].BLOOD_PRESSURE_SYS).toBe(120);
  });

  it("exposes the shift days as a stable public table", () => {
    expect(COMPARISON_SHIFT_DAYS.lastMonth).toBe(30);
    expect(COMPARISON_SHIFT_DAYS.lastYear).toBe(365);
  });
});
