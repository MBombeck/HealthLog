/**
 * #1028 — the Coach's adherence over a medication added mid-day.
 *
 * The Coach reads a 30-day window, which starts long before a medication
 * added two days ago. Neither the days before it existed nor the creation
 * day's earlier slot (holding only the projector's auto-missed placeholder)
 * may read as missed, and the creation day's 14:00 dose, recorded afterwards
 * on its own slot, counts as taken: the Coach quotes what the medication
 * card and the dose history show.
 */
import { expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { buildComplianceBlock } from "../compliance-block";
import { localHmAsUtc } from "@/lib/tz/local-day";

const DAY_MS = 24 * 60 * 60 * 1000;

for (const tz of ["Asia/Kolkata", "America/New_York"]) {
  it(`quotes full adherence for a medication added mid-day (${tz})`, () => {
    const day1 = new Date("2026-09-23T12:00:00Z");
    const day2 = new Date("2026-09-24T12:00:00Z");
    const d1 = (h: number, m = 0) => localHmAsUtc(day1, tz, h, m);
    const d2 = (h: number, m = 0) => localHmAsUtc(day2, tz, h, m);
    const now = d2(22, 0);
    const take = (slot: Date, takenAt: Date) => ({
      scheduledFor: slot,
      takenAt,
      skipped: false,
      autoMissed: false,
    });

    const snapshot: Record<string, unknown> = {};
    buildComplianceBlock({
      complianceMeds: [
        {
          startsOn: null,
          endsOn: null,
          oneShot: false,
          createdAt: d1(16, 5),
          schedules: [
            {
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
            },
          ],
          intakeEvents: [
            {
              scheduledFor: d1(9),
              takenAt: null,
              skipped: false,
              autoMissed: true,
            },
            take(d1(14), d1(14)),
            take(d1(21), d1(21)),
            take(d2(9), d2(10)),
            take(d2(14), d2(14)),
            take(d2(21), d2(21, 30)),
          ],
        },
      ],
      userTz: tz,
      cutoff: new Date(now.getTime() - 30 * DAY_MS),
      recentCutoff: new Date(now.getTime() - 7 * DAY_MS),
      now,
      snapshot,
      metrics: new Set(),
      counts: {},
      registerBlock: () => {},
    });

    const compliance = snapshot.compliance as {
      rate: number;
      timeline: { recent: Array<{ taken: number; total: number }> };
    };
    expect(compliance.rate).toBe(100);
    expect(compliance.timeline.recent.map((r) => [r.taken, r.total])).toEqual([
      [2, 2],
      [3, 3],
    ]);
  });
}
