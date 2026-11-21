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
      "Appointment: Practice Lindenhof",
      "Appointment",
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
