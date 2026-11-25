import { describe, expect, it } from "vitest";

import { renderIcs } from "@/lib/cycle/ics";
import { getServerTranslator } from "@/lib/i18n/server-translator";

import { MAX_CARE_EVENTS, buildCareCalendar } from "../events";

const translator = getServerTranslator("en");
const visit = {
  id: "v1",
  occurredAt: new Date("2026-12-03T08:30:00Z"),
  practitioner: "Practice Lindenhof",
};
const checkup = {
  id: "r1",
  day: "2026-12-01",
  label: "Skin check",
  booster: false,
};
const booster = {
  id: "r2",
  day: "2026-12-10",
  label: "Tetanus",
  booster: true,
};

describe("buildCareCalendar", () => {
  it("says nothing in discreet mode", () => {
    const calendar = buildCareCalendar({
      feedId: "f1",
      titleMode: "DISCREET",
      visits: [visit],
      dues: [checkup, booster],
      translator,
    });
    expect(calendar.name).toBe("HealthLog");
    expect(calendar.events.map((e) => e.summary)).toEqual(["●", "●", "●"]);
  });

  it("names each date in descriptive mode, in time order", () => {
    const calendar = buildCareCalendar({
      feedId: "f1",
      titleMode: "DESCRIPTIVE",
      visits: [
        visit,
        {
          ...visit,
          id: "v2",
          occurredAt: new Date("2026-12-04T10:00:00Z"),
          practitioner: null,
        },
      ],
      dues: [booster, checkup],
      translator,
    });
    expect(calendar.events.map((e) => e.summary)).toEqual([
      "Due: Skin check",
      "Visit: Practice Lindenhof",
      "Visit",
      "Booster due: Tetanus",
    ]);
  });

  it("draws an appointment at its time for an hour, a due date all day", () => {
    const body = renderIcs(
      buildCareCalendar({
        feedId: "f1",
        titleMode: "DISCREET",
        visits: [visit],
        dues: [checkup],
        translator,
      }),
      new Date("2026-11-21T00:00:00Z"),
    );
    expect(body).toContain("DTSTART:20261203T083000Z");
    expect(body).toContain("DTEND:20261203T093000Z");
    expect(body).toContain("TRANSP:OPAQUE");
    expect(body).toContain("DTSTART;VALUE=DATE:20261201");
    expect(body).toContain("DTEND;VALUE=DATE:20261202");
  });

  it("keeps stable, distinct ids and caps the body", () => {
    const dues = Array.from({ length: MAX_CARE_EVENTS + 5 }, (_, i) => ({
      ...checkup,
      id: `r${i}`,
    }));
    const a = buildCareCalendar({
      feedId: "f1",
      titleMode: "DISCREET",
      visits: [],
      dues,
      translator,
    });
    const b = buildCareCalendar({
      feedId: "f1",
      titleMode: "DISCREET",
      visits: [],
      dues,
      translator,
    });
    expect(a.events).toHaveLength(MAX_CARE_EVENTS);
    expect(a.events.map((e) => e.uid)).toEqual(b.events.map((e) => e.uid));
    expect(new Set(a.events.map((e) => e.uid)).size).toBe(MAX_CARE_EVENTS);
  });
});

describe("treatment series in the care calendar", () => {
  const session = {
    ...visit,
    id: "s1",
    session: { number: 3, planned: 6 },
  };
  const end = { id: "t1", day: "2026-12-20", practitioner: "Physio Nord" };

  it("numbers a session and draws a running series' last valid day", () => {
    const calendar = buildCareCalendar({
      feedId: "f1",
      titleMode: "DESCRIPTIVE",
      visits: [
        session,
        {
          ...session,
          id: "s2",
          occurredAt: new Date("2026-12-05T08:30:00Z"),
          practitioner: null,
          session: { number: 4, planned: null },
        },
      ],
      dues: [],
      seriesEnds: [
        end,
        { ...end, id: "t2", day: "2026-12-21", practitioner: null },
      ],
      translator,
    });
    expect(calendar.events.map((e) => e.summary)).toEqual([
      "Session 3 of 6: Practice Lindenhof",
      "Session 4",
      "Treatment series ends: Physio Nord",
      "Treatment series ends",
    ]);
  });

  it("says nothing about either in discreet mode", () => {
    const calendar = buildCareCalendar({
      feedId: "f1",
      titleMode: "DISCREET",
      visits: [session],
      dues: [],
      seriesEnds: [end],
      translator,
    });
    expect(calendar.events.map((e) => e.summary)).toEqual(["●", "●"]);
  });
});
