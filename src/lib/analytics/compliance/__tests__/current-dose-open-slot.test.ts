/**
 * `complianceDisplay.currentDose` names the open dose, not the next one.
 *
 * The cycle's `nextDueAt` walks occurrences from `now` forward, so once a
 * dose's clock time had passed it named tomorrow's slot as upcoming while
 * today's was still due or overdue (the today rows said so, the card did
 * not). The current dose is the earliest open slot of the ledger, before
 * any pending one. Pinned around the slot time, the on-time window's end,
 * midnight and a DST change.
 */
import { describe, expect, it } from "vitest";

import {
  buildComplianceDisplay,
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  type ComplianceSchedule,
} from "@/lib/analytics/compliance";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";

const TZ = "Europe/Berlin";
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

function daily(time: string): ComplianceSchedule {
  return {
    windowStart: time,
    windowEnd: time,
    timesOfDay: [time],
    daysOfWeek: null,
    rrule: null,
    rollingIntervalDays: null,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };
}

function local(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return zonedWallClockToUtc({ year, month, day, hour, minute }, TZ);
}

function dose(time: string, now: Date) {
  const ctx = buildComplianceMedicationContext(
    {
      startsOn: null,
      endsOn: null,
      endedAt: null,
      oneShot: false,
      createdAt: new Date(now.getTime() - 20 * DAY_MS),
    },
    null,
    TZ,
  );
  const schedules = [daily(time)];
  const bundle = buildMedicationComplianceBundle([], schedules, ctx, now);
  // The single-call display and the bundle agree.
  expect(
    buildComplianceDisplay([], schedules, ctx, { now }).currentDose,
  ).toEqual(bundle.complianceDisplay.currentDose);
  return bundle.complianceDisplay.currentDose;
}

describe("currentDose is the earliest open slot", () => {
  it("names today's slot just after its time, as due", () => {
    const slot = local(2026, 6, 10, 8, 0);
    const current = dose("08:00", new Date(slot.getTime() + MIN_MS));
    expect(current.targetAt).toEqual(slot);
    expect(current.state).toBe("due");
    expect(current.status).toBe("on_time_window");
  });

  it("stays on today's slot past the on-time window's end, as overdue", () => {
    const slot = local(2026, 6, 10, 8, 0);
    const inWindow = dose("08:00", new Date(slot.getTime() + MIN_MS));
    const end = inWindow.overdueSince!.getTime();
    expect(end).toBeGreaterThan(slot.getTime());

    const justBefore = dose("08:00", new Date(end - MIN_MS));
    expect(justBefore.targetAt).toEqual(slot);
    expect(justBefore.state).toBe("due");

    const justAfter = dose("08:00", new Date(end + MIN_MS));
    expect(justAfter.targetAt).toEqual(slot);
    expect(justAfter.state).toBe("overdue");
    expect(justAfter.overdueSince).toEqual(inWindow.overdueSince);
  });

  it("moves to the next slot once the open one is missed", () => {
    const slot = local(2026, 6, 10, 8, 0);
    const inWindow = dose("08:00", new Date(slot.getTime() + MIN_MS));
    const after = dose(
      "08:00",
      new Date(inWindow.missedAfter!.getTime() + MIN_MS),
    );
    expect(after.targetAt!.getTime()).toBeGreaterThan(slot.getTime());
    expect(after.state).toBe("upcoming");
  });

  it("keeps yesterday's late-evening slot open across midnight", () => {
    const slot = local(2026, 6, 10, 23, 30);
    const current = dose("23:30", local(2026, 6, 11, 0, 15));
    expect(current.targetAt).toEqual(slot);
    expect(["due", "overdue"]).toContain(current.state);
  });

  it("names the right instant on the day the clocks go back", () => {
    // 25 October 2026: Berlin leaves summer time at 03:00, so 08:00 local
    // is 07:00 UTC that day (06:00 UTC the day before).
    const slot = local(2026, 10, 25, 8, 0);
    expect(slot.toISOString()).toBe("2026-10-25T07:00:00.000Z");
    const current = dose("08:00", new Date(slot.getTime() + 20 * MIN_MS));
    expect(current.targetAt).toEqual(slot);
    expect(current.state).toBe("due");
  });

  it("names the right instant on the day the clocks go forward", () => {
    // 29 March 2026: Berlin enters summer time at 02:00.
    const slot = local(2026, 3, 29, 8, 0);
    expect(slot.toISOString()).toBe("2026-03-29T06:00:00.000Z");
    const current = dose("08:00", new Date(slot.getTime() + 20 * MIN_MS));
    expect(current.targetAt).toEqual(slot);
    expect(current.state).toBe("due");
  });
});
