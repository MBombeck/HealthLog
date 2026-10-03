/**
 * v1.40 (#1024) — a medication taken in two courses with a gap between them
 * expects doses only inside the courses. Every dose of both courses is taken,
 * so the honest rate is 100 %; a minter that expanded across the gap would
 * read the gap's days as missed and report far less.
 */
import { describe, expect, it } from "vitest";

import {
  buildComplianceMedicationContext,
  calculateCompliance,
  expectedSlotsBetween,
  type ComplianceSchedule,
  type IntakeEvent,
} from "@/lib/analytics/compliance";
import { dateOfDayKey } from "@/lib/medications/course-window";

const TZ = "Europe/Berlin";
const NOW = new Date("2026-06-20T18:00:00.000Z");
const DAILY: ComplianceSchedule[] = [
  {
    windowStart: "08:00",
    windowEnd: "09:00",
    daysOfWeek: null,
    timesOfDay: ["08:00"],
    rrule: "FREQ=DAILY",
    rollingIntervalDays: null,
  },
];
const COURSES = [
  { startsOn: dateOfDayKey("2026-04-01"), endsOn: dateOfDayKey("2026-04-07") },
  { startsOn: dateOfDayKey("2026-06-10"), endsOn: dateOfDayKey("2026-06-16") },
];

function dayKeys(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let d = dateOfDayKey(from);
    d.getTime() <= dateOfDayKey(to).getTime();
    d = new Date(d.getTime() + 86_400_000)
  ) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// 08:00 Berlin (CEST) is 06:00 UTC; taken five minutes in.
const EVENTS: IntakeEvent[] = [
  ...dayKeys("2026-04-01", "2026-04-07"),
  ...dayKeys("2026-06-10", "2026-06-16"),
].map((day) => ({
  scheduledFor: new Date(`${day}T06:00:00.000Z`),
  takenAt: new Date(`${day}T06:05:00.000Z`),
  skipped: false,
}));

const MEDICATION = {
  // The row projects the latest course.
  startsOn: COURSES[1].startsOn,
  endsOn: COURSES[1].endsOn,
  oneShot: false,
  createdAt: new Date("2026-03-15T10:00:00.000Z"),
};

describe("compliance across two courses", () => {
  it("expects a dose on every course day and none in the gap", () => {
    const ctx = buildComplianceMedicationContext(
      { ...MEDICATION, courses: COURSES },
      EVENTS[EVENTS.length - 1].takenAt,
      TZ,
    );
    const slots = expectedSlotsBetween(
      DAILY,
      new Date("2026-03-22T00:00:00.000Z"),
      NOW,
      ctx,
      EVENTS,
    );
    expect(slots).toHaveLength(14);
  });

  it("reports the rate of the two courses alone over a 90-day window", () => {
    const ctx = buildComplianceMedicationContext(
      { ...MEDICATION, courses: COURSES },
      EVENTS[EVENTS.length - 1].takenAt,
      TZ,
    );
    const result = calculateCompliance(
      EVENTS,
      DAILY,
      90,
      MEDICATION.createdAt,
      {
        now: NOW,
        medicationContext: ctx,
      },
    );
    expect(result.missed).toBe(0);
    expect(result.taken).toBe(14);
    expect(result.rate).toBe(100);
  });

  it("keeps one course on the behaviour every medication had before", () => {
    const ctx = buildComplianceMedicationContext(
      { ...MEDICATION, courses: [COURSES[1]] },
      EVENTS[EVENTS.length - 1].takenAt,
      TZ,
    );
    const slots = expectedSlotsBetween(
      DAILY,
      new Date("2026-03-22T00:00:00.000Z"),
      NOW,
      ctx,
      EVENTS,
    );
    expect(slots).toHaveLength(7);
  });
});

describe("the streak across two courses (v1.40, #1024)", () => {
  // Course A Jun 1-10 with Jun 5 missed, course B Jun 13 onward, every other
  // course day taken. The miss sits in the earlier course: a streak that only
  // saw the latest course would run unbroken through the whole window.
  const A = {
    startsOn: dateOfDayKey("2026-06-01"),
    endsOn: dateOfDayKey("2026-06-10"),
  };
  const B = { startsOn: dateOfDayKey("2026-06-13"), endsOn: null };
  const NOW_B = new Date("2026-06-27T18:00:00.000Z");
  const taken = [
    ...dayKeys("2026-06-01", "2026-06-10").filter((d) => d !== "2026-06-05"),
    ...dayKeys("2026-06-13", "2026-06-27"),
  ].map((day) => ({
    scheduledFor: new Date(`${day}T06:00:00.000Z`),
    takenAt: new Date(`${day}T06:05:00.000Z`),
    skipped: false,
  }));

  it("stops at the miss in the earlier course", () => {
    const ctx = buildComplianceMedicationContext(
      {
        startsOn: B.startsOn,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-05-20T10:00:00.000Z"),
        courses: [A, B],
      },
      taken[taken.length - 1].takenAt,
      TZ,
    );
    const result = calculateCompliance(taken, DAILY, 30, ctx.createdAt, {
      now: NOW_B,
      medicationContext: ctx,
    });
    expect(result.missed).toBe(1);
    // Jun 6 to Jun 27. The two gap days expect nothing and advance the
    // streak like any out-of-cadence day; the miss on Jun 5 ends the run.
    expect(result.streak).toBe(22);
  });
});
