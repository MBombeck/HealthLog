/**
 * v1.15.18 — per-dose configurable on-time window (`doseWindows`) validation.
 *
 * The schedule schema accepts an optional `[{ timeOfDay, start, end }]` array.
 * Each entry must be well-formed HH:mm with `start <= end`, name a real dose
 * time of the schedule, and no `timeOfDay` may repeat. Absent leaves the
 * default ±1h behaviour unchanged.
 */
import { describe, it, expect } from "vitest";

import { doseWindowEntrySchema, scheduleSchema } from "../medication";

function baseSchedule(over: Record<string, unknown> = {}) {
  return {
    windowStart: "07:00",
    windowEnd: "09:00",
    timesOfDay: ["07:00", "19:00"],
    rrule: "FREQ=DAILY",
    ...over,
  };
}

describe("doseWindowEntrySchema", () => {
  it("accepts a well-formed entry", () => {
    expect(
      doseWindowEntrySchema.safeParse({
        timeOfDay: "07:00",
        start: "07:00",
        end: "09:00",
      }).success,
    ).toBe(true);
  });

  it("rejects start > end", () => {
    expect(
      doseWindowEntrySchema.safeParse({
        timeOfDay: "07:00",
        start: "12:00",
        end: "07:00",
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed HH:mm", () => {
    expect(
      doseWindowEntrySchema.safeParse({
        timeOfDay: "7:00",
        start: "07:00",
        end: "09:00",
      }).success,
    ).toBe(false);
    expect(
      doseWindowEntrySchema.safeParse({
        timeOfDay: "07:00",
        start: "07:00",
        end: "25:00",
      }).success,
    ).toBe(false);
  });

  it("allows a zero-width window (start === end)", () => {
    expect(
      doseWindowEntrySchema.safeParse({
        timeOfDay: "07:00",
        start: "08:00",
        end: "08:00",
      }).success,
    ).toBe(true);
  });
});

describe("scheduleSchema doseWindows", () => {
  it("is optional — a schedule without it validates", () => {
    expect(scheduleSchema.safeParse(baseSchedule()).success).toBe(true);
  });

  it("accepts a window for a real dose time", () => {
    const r = scheduleSchema.safeParse(
      baseSchedule({
        doseWindows: [{ timeOfDay: "07:00", start: "07:00", end: "09:00" }],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects a window whose timeOfDay is not a scheduled dose time", () => {
    const r = scheduleSchema.safeParse(
      baseSchedule({
        doseWindows: [{ timeOfDay: "13:00", start: "13:00", end: "14:00" }],
      }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects a duplicate timeOfDay", () => {
    const r = scheduleSchema.safeParse(
      baseSchedule({
        doseWindows: [
          { timeOfDay: "07:00", start: "07:00", end: "08:00" },
          { timeOfDay: "07:00", start: "08:00", end: "09:00" },
        ],
      }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects a per-entry start > end", () => {
    const r = scheduleSchema.safeParse(
      baseSchedule({
        doseWindows: [{ timeOfDay: "07:00", start: "12:00", end: "07:00" }],
      }),
    );
    expect(r.success).toBe(false);
  });

  it("matches a legacy single-time schedule against windowStart", () => {
    const r = scheduleSchema.safeParse({
      windowStart: "08:00",
      windowEnd: "10:00",
      // no timesOfDay → effective dose time is windowStart
      doseWindows: [{ timeOfDay: "08:00", start: "08:00", end: "11:00" }],
    });
    expect(r.success).toBe(true);
  });
});

// #1034 — the per-slot override follows the medication-level rule.
describe("scheduleSchema unitsPerDose", () => {
  it("accepts a whole number plus a fraction and a free decimal", () => {
    for (const v of [1.5, 2.25, 1.3333, 0.8]) {
      expect(
        scheduleSchema.safeParse(baseSchedule({ unitsPerDose: v })).success,
      ).toBe(true);
    }
  });

  it("refuses zero, above 100, and more than four decimal places", () => {
    for (const v of [0, 100.5, 1.23456]) {
      expect(
        scheduleSchema.safeParse(baseSchedule({ unitsPerDose: v })).success,
      ).toBe(false);
    }
  });
});
