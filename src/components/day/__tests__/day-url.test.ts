import { describe, expect, it } from "vitest";

import {
  daysBetween,
  externalDayHref,
  isOpenableDay,
  parseDayParam,
  shiftDateKey,
  todayKeyInZone,
  withDayHref,
} from "../day-url";

/**
 * The day layer's address rules: which `?day=` values open, how a step to the
 * neighbouring day is spelled, and that the parameter travels beside a page's
 * own query instead of replacing it.
 */
describe("day URL rules", () => {
  it("opens a real calendar date up to today, nothing else", () => {
    const today = "2026-10-08";
    expect(parseDayParam("2026-01-03", today)).toBe("2026-01-03");
    expect(parseDayParam(today, today)).toBe(today);
    // Future days have no content: dropped.
    expect(parseDayParam("2026-10-09", today)).toBeNull();
    // Shape-valid but not a date.
    expect(parseDayParam("2026-02-30", today)).toBeNull();
    expect(parseDayParam("03.01.2026", today)).toBeNull();
    expect(parseDayParam("", today)).toBeNull();
    expect(parseDayParam(null, today)).toBeNull();
    expect(isOpenableDay(undefined, today)).toBe(false);
  });

  it("steps calendar days across month, year and DST boundaries", () => {
    expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateKey("2026-02-28", 1)).toBe("2026-03-01");
    expect(shiftDateKey("2024-02-28", 1)).toBe("2024-02-29");
    // Europe's spring-forward and fall-back days are ordinary calendar steps.
    expect(shiftDateKey("2026-03-28", 1)).toBe("2026-03-29");
    expect(shiftDateKey("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftDateKey("2026-10-25", -1)).toBe("2026-10-24");
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-26", "2026-10-24")).toBe(-2);
  });

  it("keeps the page's own query when setting or removing the day", () => {
    expect(withDayHref("/labs", "?analyte=ldl", "2025-12-12")).toBe(
      "/labs?analyte=ldl&day=2025-12-12",
    );
    expect(withDayHref("/labs", "?analyte=ldl&day=2025-12-12", null)).toBe(
      "/labs?analyte=ldl",
    );
    expect(withDayHref("/", "", null)).toBe("/");
    expect(externalDayHref("2026-01-03")).toBe("/?day=2026-01-03");
  });

  it("reads today in the record's zone, not the host's", () => {
    // 23:30 UTC on 7 Oct is already 8 Oct in Berlin and still 7 Oct in
    // New York.
    const now = new Date("2026-10-07T23:30:00Z");
    expect(todayKeyInZone("Europe/Berlin", now)).toBe("2026-10-08");
    expect(todayKeyInZone("America/New_York", now)).toBe("2026-10-07");
  });
});
