/**
 * #1350 — how a forecast period is drawn in each style. Dates only: the
 * projection is handed in, so every expected day below is the arithmetic of
 * one fixed cycle and nothing else.
 */
import { describe, expect, it } from "vitest";

import type { ProjectedCycle } from "@/lib/cycle/projection";
import { eventUid } from "@/lib/cycle/ics";
import { getServerTranslator } from "@/lib/i18n/server-translator";

import {
  DISCREET_MARGIN_SUMMARY,
  DISCREET_SUMMARY,
  buildFeedCalendar,
  type FeedForecastStyle,
  type FeedTitleMode,
} from "../events";

/** Most likely start 17 Nov, five bleeding days, ±2 days. */
const CYCLE: ProjectedCycle = {
  k: 1,
  start: "2026-11-17",
  periodLength: 5,
  bandStart: "2026-11-15",
  bandEnd: "2026-11-19",
};

function events(
  forecastStyle: FeedForecastStyle,
  projected: ProjectedCycle[] = [CYCLE],
  titleMode: FeedTitleMode = "DISCREET",
  locale: "en" | "de" = "en",
) {
  return buildFeedCalendar({
    feedId: "feed-1",
    titleMode,
    forecastStyle,
    projected,
    history: [],
    fertile: null,
    translator: getServerTranslator(locale),
  }).events;
}

/** start .. endExclusive, the pair DTSTART / DTEND carry. */
const span = (e: { start: string; endExclusive: string }) => [
  e.start,
  e.endExclusive,
];

describe("forecast styles", () => {
  it("BAND draws one event from the earliest start to the latest period's end", () => {
    const out = events("BAND");
    expect(out.map(span)).toEqual([["2026-11-15", "2026-11-24"]]);
    expect(out[0].summary).toBe(DISCREET_SUMMARY);
  });

  it("EXACT draws only the calculated period", () => {
    const out = events("EXACT");
    expect(out.map(span)).toEqual([["2026-11-17", "2026-11-22"]]);
    expect(out[0].summary).toBe(DISCREET_SUMMARY);
  });

  it("MARGIN draws the calculated period with the possible days on each side", () => {
    const out = events("MARGIN");
    expect(out.map(span)).toEqual([
      ["2026-11-15", "2026-11-17"],
      ["2026-11-17", "2026-11-22"],
      ["2026-11-22", "2026-11-24"],
    ]);
    expect(out.map((e) => e.summary)).toEqual([
      DISCREET_MARGIN_SUMMARY,
      DISCREET_SUMMARY,
      DISCREET_MARGIN_SUMMARY,
    ]);
  });

  it("MARGIN covers exactly the days BAND covers, without overlap", () => {
    const [band] = events("BAND");
    const margin = events("MARGIN");
    expect(margin[0].start).toBe(band.start);
    expect(margin.at(-1)!.endExclusive).toBe(band.endExclusive);
    for (let i = 1; i < margin.length; i++) {
      expect(margin[i].start).toBe(margin[i - 1].endExclusive);
    }
  });

  it("MARGIN draws no side event where the band is empty", () => {
    const exact = { ...CYCLE, bandStart: CYCLE.start, bandEnd: CYCLE.start };
    expect(events("MARGIN", [exact]).map(span)).toEqual([
      ["2026-11-17", "2026-11-22"],
    ]);
    const lateOnly = { ...CYCLE, bandStart: CYCLE.start };
    expect(events("MARGIN", [lateOnly]).map(span)).toEqual([
      ["2026-11-17", "2026-11-22"],
      ["2026-11-22", "2026-11-24"],
    ]);
    const earlyOnly = { ...CYCLE, bandEnd: CYCLE.start };
    expect(events("MARGIN", [earlyOnly]).map(span)).toEqual([
      ["2026-11-15", "2026-11-17"],
      ["2026-11-17", "2026-11-22"],
    ]);
  });

  it("keeps the period's UID across styles and gives each margin its own", () => {
    const main = eventUid("feed-1", "pred:1");
    expect(events("BAND")[0].uid).toBe(main);
    expect(events("EXACT")[0].uid).toBe(main);
    expect(events("MARGIN").map((e) => e.uid)).toEqual([
      eventUid("feed-1", "pred:1:before"),
      main,
      eventUid("feed-1", "pred:1:after"),
    ]);
  });

  it("draws every forecast cycle it is given", () => {
    const next = {
      k: 2,
      start: "2026-12-15",
      periodLength: 5,
      bandStart: "2026-12-12",
      bandEnd: "2026-12-18",
    };
    expect(events("EXACT", [CYCLE, next])).toHaveLength(2);
    expect(events("MARGIN", [CYCLE, next])).toHaveLength(6);
    expect(events("BAND", [CYCLE, next])).toHaveLength(2);
  });

  it("names the possible days in the record's language when descriptive", () => {
    expect(
      events("MARGIN", [CYCLE], "DESCRIPTIVE").map((e) => e.summary),
    ).toEqual(["Period possible", "Period (estimate)", "Period possible"]);
    expect(
      events("MARGIN", [CYCLE], "DESCRIPTIVE", "de").map((e) => e.summary),
    ).toEqual(["Periode möglich", "Periode (Schätzung)", "Periode möglich"]);
  });

  it("describes every forecast event with its band", () => {
    for (const e of events("MARGIN", [CYCLE], "DESCRIPTIVE")) {
      expect(e.description).toBe("Most likely start Nov 17, ±2 days");
    }
    for (const e of events("EXACT")) expect(e.description).toBe("±2 days");
  });
});
