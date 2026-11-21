import { describe, expect, it } from "vitest";

import { isOpenableDay, parseDayParam, todayKeyInZone } from "../day-url";

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

  it("reads today in the record's zone, not the host's", () => {
    // 23:30 UTC on 7 Oct is already 8 Oct in Berlin and still 7 Oct in
    // New York.
    const now = new Date("2026-10-07T23:30:00Z");
    expect(todayKeyInZone("Europe/Berlin", now)).toBe("2026-10-08");
    expect(todayKeyInZone("America/New_York", now)).toBe("2026-10-07");
  });
});
