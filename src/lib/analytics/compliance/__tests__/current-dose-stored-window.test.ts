/**
 * `complianceDisplay.currentDose` reads a dose's window from the band the
 * minter gives the medication's slot, the stored per-dose window included.
 *
 * A dose at 12:00 with a window of 11:30 to 12:45 showed due from 11:30 in the
 * today rows and due from 11:00, overdue from 13:00 on the card: before its
 * target time the dose is not in the trailing ledger, and the card fell back
 * to the default band. Pinned before the window, inside it before the target
 * time, and against the ledger row the minter mints for the same slot.
 */
import { describe, expect, it } from "vitest";

import {
  buildComplianceDisplay,
  buildComplianceMedicationContext,
  type ComplianceSchedule,
} from "@/lib/analytics/compliance";
import { buildComplianceLedgerRows } from "@/lib/analytics/compliance/ledger";
import { resolveLedgerSlot } from "@/lib/medications/dose-state/resolve";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";

const TZ = "Europe/Berlin";
const DAY_MS = 24 * 60 * 60 * 1000;

const noon: ComplianceSchedule = {
  windowStart: "12:00",
  windowEnd: "12:00",
  timesOfDay: ["12:00"],
  daysOfWeek: null,
  rrule: null,
  rollingIntervalDays: null,
  reminderGraceMinutes: null,
  scheduleType: "SCHEDULED",
  cyclicOnWeeks: null,
  cyclicOffWeeks: null,
  doseWindows: [{ timeOfDay: "12:00", start: "11:30", end: "12:45" }],
};

const at = (hour: number, minute: number) =>
  zonedWallClockToUtc({ year: 2026, month: 11, day: 18, hour, minute }, TZ);

function ctxFor(now: Date) {
  return buildComplianceMedicationContext(
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
}

describe("currentDose follows the stored window", () => {
  it("is due from the window's start, before the target time", () => {
    const now = at(11, 40);
    const current = buildComplianceDisplay([], [noon], ctxFor(now), {
      now,
    }).currentDose;
    expect(current.targetAt).toEqual(at(12, 0));
    expect(current.state).toBe("due");
    expect(current.dueAt).toEqual(at(11, 30));
    expect(current.overdueSince).toEqual(at(12, 45));
  });

  it("is not due yet before the window opens, where the default band was", () => {
    const now = at(11, 10);
    const current = buildComplianceDisplay([], [noon], ctxFor(now), {
      now,
    }).currentDose;
    expect(current.targetAt).toEqual(at(12, 0));
    expect(current.state).not.toBe("due");
    expect(current.dueAt).toEqual(at(11, 30));
  });

  it("names the same instants as the minted ledger row of the slot", () => {
    const now = at(11, 40);
    const ctx = ctxFor(now);
    const current = buildComplianceDisplay([], [noon], ctx, {
      now,
    }).currentDose;
    const row = buildComplianceLedgerRows(
      [],
      [noon],
      ctx,
      at(0, 0),
      new Date(at(0, 0).getTime() + 2 * DAY_MS),
      now,
    ).find((r) => r.kind === "slot" && r.at.getTime() === at(12, 0).getTime());
    expect(row).toBeDefined();
    const resolved = resolveLedgerSlot(row!, now);
    expect(current.dueAt).toEqual(resolved?.dueAt);
    expect(current.overdueSince).toEqual(resolved?.overdueSince);
    expect(current.missedAfter).toEqual(resolved?.missedAfter);
  });
});
