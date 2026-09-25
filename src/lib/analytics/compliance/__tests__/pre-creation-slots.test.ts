/**
 * #1028 — slots before a medication's creation, on the compliance side.
 *
 * The dose-history ledger keeps a slot that predates the medication only
 * when a recorded dose claims it. Every adherence surface tallies that same
 * ledger, so the rate, the per-window counts and the heatmap must agree with
 * the history view: the creation day's 14:00 dose, recorded afterwards on its
 * own slot, counts as taken on time, and the 09:00 slot before the medication
 * existed (holding only the projector's auto-missed placeholder) counts as
 * nothing. A caller whose window starts before the creation (the doctor
 * report, the Coach) must not read the pre-existence slots as missed either.
 */
import { describe, expect, it } from "vitest";

import {
  buildMedicationComplianceBundle,
  tallyComplianceFromLedger,
  type ComplianceMedicationContext,
  type ComplianceSchedule,
  type IntakeEvent,
} from "@/lib/analytics/compliance";
import { localHmAsUtc } from "@/lib/tz/local-day";
import { userDayKey } from "@/lib/tz/resolver";

const DAY_MS = 24 * 60 * 60 * 1000;

const schedule: ComplianceSchedule = {
  windowStart: "09:00",
  windowEnd: "09:00",
  timesOfDay: ["09:00", "14:00", "21:00"],
  daysOfWeek: null,
  rrule: null,
  rollingIntervalDays: null,
  reminderGraceMinutes: null,
  scheduleType: "SCHEDULED",
  cyclicOnWeeks: null,
  cyclicOffWeeks: null,
};

for (const tz of ["Asia/Kolkata", "America/New_York"]) {
  describe(`compliance over a medication added mid-day (#1028, ${tz})`, () => {
    const day1 = new Date("2026-09-23T12:00:00Z");
    const day2 = new Date("2026-09-24T12:00:00Z");
    const d1 = (h: number, m = 0) => localHmAsUtc(day1, tz, h, m);
    const d2 = (h: number, m = 0) => localHmAsUtc(day2, tz, h, m);
    const createdAt = d1(16, 5);
    const now = d2(22, 0);

    const ctx: ComplianceMedicationContext = {
      startsOn: new Date("2026-09-23T00:00:00Z"),
      endsOn: new Date("2026-09-28T00:00:00Z"),
      oneShot: false,
      createdAt,
      lastIntakeAt: d2(21, 30),
      timeZone: tz,
    };
    const take = (slot: Date, takenAt: Date): IntakeEvent => ({
      scheduledFor: slot,
      takenAt,
      skipped: false,
      autoMissed: false,
    });
    const events: IntakeEvent[] = [
      { scheduledFor: d1(9), takenAt: null, skipped: false, autoMissed: true },
      take(d1(14), d1(14)),
      take(d1(21), d1(21)),
      take(d2(9), d2(10)),
      take(d2(14), d2(14)),
      take(d2(21), d2(21, 30)),
    ];

    it("counts the recorded pre-creation dose and ignores the placeholder", () => {
      const bundle = buildMedicationComplianceBundle(
        events,
        [schedule],
        ctx,
        now,
      );
      expect(bundle.compliance7).toMatchObject({
        taken: 5,
        missed: 0,
        skipped: 0,
        rate: 100,
      });
      const creationDay = bundle.ledgerRows.filter(
        (r) => userDayKey(r.at, tz) === userDayKey(d1(12), tz),
      );
      expect(creationDay.map((r) => [r.kind, r.timeOfDay, r.status])).toEqual([
        ["slot", "14:00", "taken_on_time"],
        ["slot", "21:00", "taken_on_time"],
      ]);
    });

    it("never reads pre-existence slots as missed in a wider window", () => {
      // The doctor report and the Coach tally a window that starts before
      // the medication existed.
      const tally = tallyComplianceFromLedger(
        [],
        [schedule],
        { ...ctx, lastIntakeAt: null },
        new Date(now.getTime() - 30 * DAY_MS),
        d2(3, 0),
        d2(3, 0),
      );
      // Only the creation day's 21:00 slot was expected, and never taken.
      expect(tally).toMatchObject({ taken: 0, missed: 1, denominator: 1 });
    });
  });
}
