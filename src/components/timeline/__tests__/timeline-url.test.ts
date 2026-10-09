import { describe, expect, it } from "vitest";

import { TIMELINE_RANGE_MAX_DAYS } from "@/lib/day/contract";

import { dayKey, dayNumber } from "../timeline-dates";
import { clampRange, parseTimelineUrl, timelineSearch } from "../timeline-url";

const TODAY = "2026-10-07";
const parse = (search: string) =>
  parseTimelineUrl(new URLSearchParams(search), TODAY);

describe("timeline URL", () => {
  it("reads a fixed zoom and leaves the choice open without one", () => {
    expect(parse("")).toEqual({ zoom: null, range: null });
    expect(parse("zoom=year")).toEqual({ zoom: "year", range: null });
    expect(parse("zoom=quarter&day=2026-01-03")).toEqual({
      zoom: "quarter",
      range: null,
    });
  });

  it("reads a chosen range with both ends", () => {
    expect(parse("zoom=range&from=2026-03-01&to=2026-04-15")).toEqual({
      zoom: "range",
      range: { from: "2026-03-01", to: "2026-04-15" },
    });
  });

  it("falls back to all, without a word, on anything it cannot read", () => {
    for (const search of [
      "zoom=decade",
      "zoom=range",
      "zoom=range&from=2026-03-01",
      "zoom=range&from=2026-02-30&to=2026-04-15",
      "zoom=range&from=2026-05-01&to=2026-04-15",
      "zoom=range&from=2027-01-01&to=2027-02-01",
      "zoom=range&from=yesterday&to=today",
    ]) {
      expect(parse(search), search).toEqual({ zoom: "all", range: null });
    }
  });

  it("pulls a range's end back to today and its span under the cap", () => {
    expect(parse("zoom=range&from=2026-09-01&to=2027-01-01").range).toEqual({
      from: "2026-09-01",
      to: TODAY,
    });
    const long = clampRange({ from: "1990-01-01", to: TODAY }, TODAY, null);
    expect(dayNumber(long.to) - dayNumber(long.from) + 1).toBe(
      TIMELINE_RANGE_MAX_DAYS,
    );
    expect(long.from).toBe(
      dayKey(dayNumber(TODAY) - TIMELINE_RANGE_MAX_DAYS + 1),
    );
  });

  it("writes the zoom and range and keeps every other parameter", () => {
    expect(
      timelineSearch("?day=2026-01-03", "range", {
        from: "2026-01-01",
        to: "2026-01-31",
      }),
    ).toBe("?day=2026-01-03&zoom=range&from=2026-01-01&to=2026-01-31");
    expect(
      timelineSearch("?zoom=range&from=2026-01-01&to=2026-01-31", "year", null),
    ).toBe("?zoom=year");
  });
});
