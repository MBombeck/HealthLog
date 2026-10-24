/**
 * #1280 — a course ended at an instant expects no dose after it, in the
 * streak and the per-window timeline as in the rate.
 *
 * The person lives in Europe/Berlin and doses at 08:00 and 20:00 local
 * (06:00Z and 18:00Z in October before the clock change). Every dose of the
 * last twenty days was taken, except the evening one on the day the course
 * was ended at noon: that slot came after the end and was never due.
 */
import { describe, expect, it } from "vitest";

import {
  buildMedicationComplianceBundle,
  calculateCompliance,
} from "@/lib/analytics/compliance/display";
import {
  buildComplianceMedicationContext,
  type ComplianceSchedule,
} from "@/lib/analytics/compliance/types";

const TZ = "Europe/Berlin";
const DAY = 86_400_000;
const NOW = new Date("2026-10-25T10:00:00.000Z");
const ENDED_AT = new Date("2026-10-24T10:00:00.000Z");
const CREATED_AT = new Date(NOW.getTime() - 20 * DAY);

const schedules: ComplianceSchedule[] = [
  {
    windowStart: "08:00",
    windowEnd: "09:00",
    timesOfDay: ["08:00", "20:00"],
    daysOfWeek: null,
    rrule: null,
    rollingIntervalDays: null,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  },
];

/** Every dose taken on time; the end day's evening only when asked. */
function events(withLastEvening: boolean) {
  const out: Array<{
    scheduledFor: Date;
    takenAt: Date;
    skipped: boolean;
    autoMissed: boolean;
  }> = [];
  for (let d = 19; d >= 0; d -= 1) {
    const key = new Date(Date.UTC(2026, 9, 24 - d)).toISOString().slice(0, 10);
    const morning = new Date(`${key}T06:00:00.000Z`);
    out.push({
      scheduledFor: morning,
      takenAt: morning,
      skipped: false,
      autoMissed: false,
    });
    if (d > 0 || withLastEvening) {
      const evening = new Date(`${key}T18:00:00.000Z`);
      out.push({
        scheduledFor: evening,
        takenAt: evening,
        skipped: false,
        autoMissed: false,
      });
    }
  }
  return out;
}

function context(endedAt: Date | null) {
  return buildComplianceMedicationContext(
    {
      startsOn: new Date(Date.UTC(2026, 9, 4)),
      endsOn: new Date(Date.UTC(2026, 9, 24)),
      endedAt,
      oneShot: false,
      createdAt: CREATED_AT,
    },
    new Date("2026-10-24T06:00:00.000Z"),
    TZ,
  );
}

describe("a course ended at an instant", () => {
  it("does not break the streak on the slot after the end", () => {
    const ended = calculateCompliance(events(false), schedules, 7, CREATED_AT, {
      now: NOW,
      medicationContext: context(ENDED_AT),
    });
    // The same course run to the end of its last day with every dose taken.
    const whole = calculateCompliance(events(true), schedules, 7, CREATED_AT, {
      now: NOW,
      medicationContext: context(null),
    });
    expect(whole.streak).toBeGreaterThan(0);
    expect(ended.missed).toBe(0);
    expect(ended.streak).toBe(whole.streak);
  });

  it("does not break the bundle's streaks either", () => {
    const ended = buildMedicationComplianceBundle(
      events(false),
      schedules,
      context(ENDED_AT),
      NOW,
    );
    const whole = buildMedicationComplianceBundle(
      events(true),
      schedules,
      context(null),
      NOW,
    );
    expect(whole.compliance7.streak).toBeGreaterThan(0);
    expect(ended.compliance7.missed).toBe(0);
    expect(ended.compliance7.streak).toBe(whole.compliance7.streak);
    expect(ended.compliance30.streak).toBe(whole.compliance30.streak);
  });
});
