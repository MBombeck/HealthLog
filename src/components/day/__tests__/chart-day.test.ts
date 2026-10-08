import { describe, expect, it } from "vitest";

import {
  chartPointDayKey,
  rugFraction,
  rugPosition,
  timeRugFraction,
} from "../chart-day";
import { daysFromCoachSteps } from "../coach-day-chips";
import { preparationRows } from "../since-last-visit";
import type { CoachStep } from "@/lib/ai/coach/types";

const noon = (key: string) => Date.parse(`${key}T12:00:00.000Z`);

describe("chart day helpers", () => {
  it("reads a daily point's day from its noon-UTC anchor", () => {
    expect(chartPointDayKey(noon("2026-01-03"))).toBe("2026-01-03");
  });

  it("places a rug day between the points around it", () => {
    const points = [
      { timestamp: noon("2026-01-01") },
      { timestamp: noon("2026-01-03") },
      { timestamp: noon("2026-01-04") },
    ];
    expect(rugPosition("2026-01-01", points)).toBe(0);
    expect(rugPosition("2026-01-02", points)).toBeCloseTo(0.5);
    expect(rugPosition("2026-01-04", points)).toBe(2);
    // Outside the drawn span: no dot.
    expect(rugPosition("2025-12-31", points)).toBeNull();
    expect(rugPosition("2026-01-05", points)).toBeNull();
  });
});

describe("Coach day chips", () => {
  const step = (over: Partial<CoachStep>): CoachStep => ({
    id: "s1",
    tool: "snapshot",
    labelKey: "coach.step.read",
    label: "Read",
    status: "done",
    ...over,
  });

  it("takes days from get_day calls only, never from anything else", () => {
    const days = daysFromCoachSteps([
      step({
        id: "s1",
        tool: "get_day" as CoachStep["tool"],
        day: "2026-01-05",
      }),
      step({
        id: "s2",
        tool: "get_day" as CoachStep["tool"],
        day: "2026-01-03",
      }),
      step({
        id: "s3",
        tool: "get_day" as CoachStep["tool"],
        day: "2026-01-03",
      }),
      // A failed read read nothing.
      step({
        id: "s4",
        tool: "get_day" as CoachStep["tool"],
        day: "2026-01-04",
        status: "failed",
      }),
      // A day field on another tool is not a day this answer read.
      step({ id: "s5", tool: "snapshot", day: "2026-01-06" }),
      step({
        id: "s6",
        tool: "get_day" as CoachStep["tool"],
        day: "not-a-day",
      }),
    ]);
    expect(days).toEqual(["2026-01-03", "2026-01-05"]);
  });
});

describe("visit preparation", () => {
  const spell = {
    notableTitle: () => "Blood pressure",
    notableText: () => "Highest daily value since March",
    countMeta: (count: number) => (count > 1 ? `${count} entries` : null),
  };

  it("lists every change the server names, a dose change on a quiet day included", () => {
    const rows = preparationRows(
      {
        changes: [
          {
            date: "2026-08-03",
            kind: "doseChange",
            section: "medications",
            id: "d1",
            title: "Ramipril 5 mg",
            count: 1,
            href: null,
          },
          {
            date: "2026-09-14",
            kind: "labResult",
            section: "labs",
            id: "l1",
            title: "Lab results",
            count: 4,
            href: null,
          },
        ],
        observations: [
          {
            date: "2026-09-02",
            kind: "extremeHigh",
            type: "BLOOD_PRESSURE_SYS",
            params: { value: 152 },
          },
          // A first reading says nothing about the stretch since the visit.
          {
            date: "2026-08-20",
            kind: "firstValue",
            type: "WEIGHT",
            params: {},
          },
        ],
      },
      spell,
    );
    expect(rows.map((row) => [row.date, row.title, row.meta])).toEqual([
      ["2026-08-03", "Ramipril 5 mg", null],
      ["2026-09-02", "Blood pressure", "Highest daily value since March"],
      ["2026-09-14", "Lab results", "4 entries"],
    ]);
  });
});

describe("rug placement per axis", () => {
  const points = [
    { timestamp: noon("2026-01-01") },
    { timestamp: noon("2026-01-02") },
    { timestamp: noon("2026-01-05") },
  ];

  it("spreads an index axis edge to edge, a band axis at band centres", () => {
    expect(rugFraction("2026-01-01", points, "index")).toBe(0);
    expect(rugFraction("2026-01-05", points, "index")).toBe(1);
    expect(rugFraction("2026-01-01", points, "band")).toBeCloseTo(1 / 6);
    expect(rugFraction("2026-01-05", points, "band")).toBeCloseTo(5 / 6);
  });

  it("places a day on a time axis by its date, not by its neighbours", () => {
    // Day 3 of a 4-day span: three quarters along, although it sits between
    // the second and third point by index.
    expect(rugFraction("2026-01-04", points, "time")).toBeCloseTo(0.75);
    expect(rugFraction("2026-01-04", points, "index")).toBeCloseTo(
      (1 + 2 / 3) / 2,
    );
  });
});

describe("rug on a time axis drawn from real instants", () => {
  const at = (iso: string) => ({ timestamp: Date.parse(iso) });

  it("keeps the first day when its reading came after noon UTC", () => {
    const points = [at("2026-03-01T18:30:00Z"), at("2026-03-05T08:00:00Z")];
    const days = ["2026-03-01", "2026-03-05"];
    expect(rugFraction("2026-03-01", points, "time")).toBeNull();
    expect(timeRugFraction("2026-03-01", points, days)).toBe(0);
  });

  it("keeps the last day when its reading came before noon UTC", () => {
    const points = [at("2026-03-01T08:00:00Z"), at("2026-03-05T07:00:00Z")];
    const days = ["2026-03-01", "2026-03-05"];
    expect(rugFraction("2026-03-05", points, "time")).toBeNull();
    expect(timeRugFraction("2026-03-05", points, days)).toBe(1);
  });

  it("gives a single reading its dot", () => {
    const points = [at("2026-03-03T21:00:00Z")];
    expect(rugFraction("2026-03-03", points, "time")).toBeNull();
    expect(timeRugFraction("2026-03-03", points, ["2026-03-03"])).toBe(0.5);
  });

  it("spans the readings' own days, not their UTC dates", () => {
    // An evening reading in a zone ahead of UTC is the next local day.
    const points = [at("2026-03-01T23:30:00Z"), at("2026-03-04T23:30:00Z")];
    const days = ["2026-03-02", "2026-03-05"];
    expect(timeRugFraction("2026-03-01", points, days)).toBeNull();
    expect(timeRugFraction("2026-03-05", points, days)).toBe(1);
    expect(timeRugFraction("2026-03-06", points, days)).toBeNull();
  });
});
