/**
 * v1.25 correctness fixes — two compliance-denominator regressions.
 *
 * H-MED1: a paused medication's gap must NOT count as missed once the
 * medication resumes. The pause interval lives in `MedicationPauseEra`
 * (threaded onto `ComplianceMedicationContext.pauseEras`); the ledger drops
 * expected slots whose anchor falls inside `[pausedAt, resumedAt ?? now)` so
 * the denominator never inflates with the paused days.
 *
 * M-MED3: the compliance rate must honour archived schedule eras
 * (`scheduleRevisions`). A past day scores against the schedule that was live
 * THEN, not the current one. This pins that threading `scheduleRevisions`
 * through `buildComplianceMedicationContext` changes the rate — the exact
 * behaviour the Health-Score fast-path was missing (it never threaded eras).
 *
 * All instants are UTC; run under `TZ=UTC` so the day grid is deterministic.
 */
import { describe, it, expect } from "vitest";

import {
  buildComplianceMedicationContext,
  tallyComplianceFromLedger,
  type ComplianceSchedule,
  type MedicationPauseEraLike,
} from "@/lib/analytics/compliance";
import type { ScheduleRevisionLike } from "@/lib/medications/scheduling/schedule-eras";

const TZ = "UTC";

/** A taken intake for the 08:00 slot of `day` (08:15 → on-time). */
function taken08(day: Date) {
  const scheduledFor = new Date(day);
  scheduledFor.setUTCHours(8, 0, 0, 0);
  const takenAt = new Date(scheduledFor.getTime() + 15 * 60_000);
  return { scheduledFor, takenAt, skipped: false };
}

function dayUTC(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

describe("H-MED1 — paused days drop out of the compliance denominator", () => {
  // Daily 08:00 medication. Window June 1 – June 28; the user takes every
  // day EXCEPT June 10–19 (the pause window) where nothing is logged.
  const createdAt = dayUTC(2026, 6, 1);
  const endsOn = dayUTC(2026, 6, 28);
  const from = dayUTC(2026, 6, 1);
  const to = dayUTC(2026, 6, 29);
  const now = dayUTC(2026, 6, 29);

  const schedules: ComplianceSchedule[] = [
    {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      timesOfDay: ["08:00"],
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
      doseWindows: null,
    },
  ];

  // Taken June 1–9 and June 20–28; nothing logged June 10–19 (paused).
  const events = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => taken08(dayUTC(2026, 6, d))),
    ...[20, 21, 22, 23, 24, 25, 26, 27, 28].map((d) =>
      taken08(dayUTC(2026, 6, d)),
    ),
  ];

  const pauseEras: MedicationPauseEraLike[] = [
    { pausedAt: dayUTC(2026, 6, 10), resumedAt: dayUTC(2026, 6, 20) },
  ];

  const medBase = {
    startsOn: createdAt,
    endsOn,
    endedAt: null,
    oneShot: false,
    createdAt,
  };

  it("WITHOUT pauseEras the paused days collapse to missed", () => {
    const ctx = buildComplianceMedicationContext(medBase, null, TZ);
    const tally = tallyComplianceFromLedger(
      events,
      schedules,
      ctx,
      from,
      to,
      now,
    );
    // June 10–19 = 10 expected slots with no intake → 10 misses.
    expect(tally.missed).toBe(10);
    expect(tally.taken).toBe(18);
    expect(tally.denominator).toBe(28);
  });

  it("WITH pauseEras the paused days are excluded → no missed", () => {
    const ctx = buildComplianceMedicationContext(
      { ...medBase, pauseEras },
      null,
      TZ,
    );
    const tally = tallyComplianceFromLedger(
      events,
      schedules,
      ctx,
      from,
      to,
      now,
    );
    // The 10 paused slots are dropped from the ledger entirely.
    expect(tally.missed).toBe(0);
    expect(tally.taken).toBe(18);
    expect(tally.denominator).toBe(18);
    expect(tally.rate).toBe(100);
  });

  it("the resumed day (resumedAt boundary) still counts", () => {
    // No intake on June 20 (the resume day) → it must count as missed: the
    // exclusion is half-open `[pausedAt, resumedAt)`, so June 20 is live.
    const eventsMissResumeDay = [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => taken08(dayUTC(2026, 6, d))),
      ...[21, 22, 23, 24, 25, 26, 27, 28].map((d) =>
        taken08(dayUTC(2026, 6, d)),
      ),
    ];
    const ctx = buildComplianceMedicationContext(
      { ...medBase, pauseEras },
      null,
      TZ,
    );
    const tally = tallyComplianceFromLedger(
      eventsMissResumeDay,
      schedules,
      ctx,
      from,
      to,
      now,
    );
    // June 20 is past the pause window and was not taken → exactly 1 miss.
    expect(tally.missed).toBe(1);
  });
});

describe("M-MED3 — the compliance rate honours archived schedule eras", () => {
  // The user ran a TWICE-daily schedule (08:00 + 20:00) for the first half of
  // the window, then edited it down to ONCE daily (08:00). Throughout, only
  // the 08:00 dose is ever taken. With the era threaded, the old-era days
  // expect two doses (one missed each); without it, every day is scored
  // against the current one-dose schedule and the rate is a misleading 100 %.
  const createdAt = dayUTC(2026, 6, 1);
  const replaceAt = dayUTC(2026, 6, 15); // the edit instant
  const endsOn = dayUTC(2026, 6, 28);
  const from = dayUTC(2026, 6, 1);
  const to = dayUTC(2026, 6, 29);
  const now = dayUTC(2026, 6, 29);

  // Current (live) schedule: one dose at 08:00.
  const liveSchedules: ComplianceSchedule[] = [
    {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      timesOfDay: ["08:00"],
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
      doseWindows: null,
    },
  ];

  // Archived era: the superseded twice-daily schedule (08:00 + 20:00).
  const oldEraRevision: ScheduleRevisionLike = {
    id: "rev-twice-daily",
    validFrom: createdAt,
    validUntil: replaceAt,
    payload: [
      {
        timesOfDay: ["08:00", "20:00"],
        windowStart: "08:00",
        windowEnd: "20:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        rollingIntervalDays: null,
        scheduleType: "SCHEDULED",
        cyclicOnWeeks: null,
        cyclicOffWeeks: null,
        doseWindows: null,
        label: null,
        dose: null,
        reminderGraceMinutes: null,
      },
    ],
  };

  // Only the 08:00 dose is taken, every day June 1–28. The 20:00 dose that
  // the old era expected on June 1–14 is never taken.
  const events = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, 26, 27, 28,
  ].map((d) => taken08(dayUTC(2026, 6, d)));

  const medBase = {
    startsOn: createdAt,
    endsOn,
    endedAt: null,
    oneShot: false,
    createdAt,
  };

  it("WITHOUT scheduleRevisions every day scores against the current one-dose schedule → 100 %", () => {
    const ctx = buildComplianceMedicationContext(medBase, null, TZ);
    const tally = tallyComplianceFromLedger(
      events,
      liveSchedules,
      ctx,
      from,
      to,
      now,
    );
    expect(tally.missed).toBe(0);
    expect(tally.rate).toBe(100);
  });

  it("WITH scheduleRevisions the old-era days expect the second dose → rate drops", () => {
    const ctx = buildComplianceMedicationContext(
      { ...medBase, scheduleRevisions: [oldEraRevision] },
      null,
      TZ,
    );
    const tally = tallyComplianceFromLedger(
      events,
      liveSchedules,
      ctx,
      from,
      to,
      now,
    );
    // June 1–14 expected the 20:00 dose too; it was never taken → 14 misses.
    expect(tally.missed).toBe(14);
    expect(tally.rate).toBeLessThan(100);
    // The era path strictly raises the denominator vs the no-era path.
    expect(tally.denominator).toBeGreaterThan(28);
  });
});
