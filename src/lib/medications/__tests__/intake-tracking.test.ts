/**
 * #1033 — the shared vocabulary for per-medication intake tracking, and the
 * two adherence entry points that read it (`expectsDoses`, the per-medication
 * compliance payload).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { medicationIntakeEvent: { findMany: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import { expectsDoses } from "@/lib/analytics/compliance";
import { buildCompliancePayload } from "@/lib/medications/compliance-payload";
import {
  dueSchedules,
  isRecordOnly,
  scheduleWireFields,
  TRACKED_INTAKE_WHERE,
  TRACKED_INTAKE_EVENT_WHERE,
} from "@/lib/medications/intake-tracking";

const schedule = {
  windowStart: "08:00",
  windowEnd: "08:00",
  timesOfDay: ["08:00"],
  daysOfWeek: null,
  rrule: "FREQ=DAILY",
  rollingIntervalDays: null,
  reminderGraceMinutes: null,
  scheduleType: "SCHEDULED" as const,
  cyclicOnWeeks: null,
  cyclicOffWeeks: null,
};

describe("intake-tracking vocabulary", () => {
  it("filters reads to tracked medications", () => {
    expect(TRACKED_INTAKE_WHERE).toEqual({ trackIntake: true });
    expect(TRACKED_INTAKE_EVENT_WHERE).toEqual({
      medication: { trackIntake: true },
    });
  });

  it("only an explicit false is record-only; a projection without the flag is tracked", () => {
    expect(isRecordOnly({ trackIntake: false })).toBe(true);
    expect(isRecordOnly({ trackIntake: true })).toBe(false);
    expect(isRecordOnly({})).toBe(false);
  });

  it("dueSchedules keeps the rows only while intake is tracked", () => {
    expect(dueSchedules({ trackIntake: true, schedules: [schedule] })).toEqual([
      schedule,
    ]);
    expect(dueSchedules({ trackIntake: false, schedules: [schedule] })).toEqual(
      [],
    );
  });

  it("the wire serves a record-only medication like an as-needed one", () => {
    expect(scheduleWireFields(true, [schedule])).toEqual({
      schedules: [schedule],
    });
    // No `recordedSchedules` key at all on a tracked medication.
    expect("recordedSchedules" in scheduleWireFields(true, [schedule])).toBe(
      false,
    );
    expect(scheduleWireFields(false, [schedule])).toEqual({
      schedules: [],
      recordedSchedules: [schedule],
    });
  });
});

describe("expectsDoses", () => {
  it("a scheduled, tracked medication expects doses", () => {
    expect(
      expectsDoses({ asNeeded: false, trackIntake: true, schedules: [1] }),
    ).toBe(true);
  });

  it("intake tracking off expects nothing even with a schedule on record", () => {
    expect(
      expectsDoses({ asNeeded: false, trackIntake: false, schedules: [1] }),
    ).toBe(false);
  });
});

describe("buildCompliancePayload", () => {
  it("answers not-applicable with its own reason and reads no history", async () => {
    const payload = await buildCompliancePayload(
      {
        id: "med-record",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        startsOn: null,
        endsOn: null,
        oneShot: false,
        asNeeded: false,
        trackIntake: false,
        schedules: [schedule],
      },
      "user-1",
      "Europe/Berlin",
    );
    expect(payload).toMatchObject({
      applicable: false,
      notApplicableReason: "INTAKE_NOT_TRACKED",
      dailyCompliance: {},
      complianceDisplay: null,
    });
    // Released clients decode these as non-null; they stay present and zero.
    expect(payload.compliance7.rate).toBe(0);
    expect(payload.compliance30.totalExpected).toBe(0);
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });
});
