import { describe, expect, it } from "vitest";

import { chartPointDayKey, rugPosition } from "../chart-day";
import { daysFromCoachSteps } from "../coach-day-chips";
import { pickPreparationDays } from "../since-last-visit";
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
  it("reads notable days first, then context days, newest kept, in date order", () => {
    const days = pickPreparationDays(
      {
        days: {
          "2026-08-03": ["medications", "values"],
          "2026-08-19": ["illness", "values"],
          "2026-09-14": ["labs"],
          "2026-09-20": ["values", "mood"],
        },
        notable: ["2026-09-02"],
      },
      3,
    );
    // A day with only values and mood is not a context change.
    expect(days).toEqual(["2026-08-19", "2026-09-02", "2026-09-14"]);
  });
});
