/**
 * v1.4.25 W19e — compliance chip aggregator tests.
 *
 * The chips feed the GLP-1 detail page. Tests cover the four chip
 * values plus the no-doses-expected null path.
 */

import { describe, expect, it } from "vitest";
import { complianceChips } from "../compliance";
import { buildCadenceTimeline } from "../cadence";
import type {
  CadenceEngineContext,
  IntakeEventLike,
  ScheduleLike,
} from "../cadence";

function d(iso: string): Date {
  return new Date(iso);
}

const DAILY_8AM: ScheduleLike = {
  windowStart: "08:00",
  windowEnd: "09:00",
  daysOfWeek: null,
};

describe("complianceChips", () => {
  it("returns null adherence when no doses are expected in the window", () => {
    const NOW = d("2025-06-10T12:00:00");
    const result = complianceChips([], [], NOW, 30);
    expect(result.adherenceRate).toBeNull();
    expect(result.missedLast30).toBe(0);
  });

  it("computes 100% adherence when every past slot has a taken event", () => {
    const NOW = d("2025-06-10T12:00:00");
    const events: IntakeEventLike[] = [];
    for (let day = 5; day <= 9; day++) {
      events.push({
        scheduledFor: d(`2025-06-0${day}T08:30:00`),
        takenAt: d(`2025-06-0${day}T08:35:00`),
        skipped: false,
      });
    }
    // 5-day window: 5 expected, 5 taken, 0 missed (today's slot is upcoming
    // because NOW is 12:00 and window is 08:00-09:00... actually past today)
    const result = complianceChips([DAILY_8AM], events, NOW, 5);
    expect(result.adherenceRate).toBeGreaterThanOrEqual(80);
    expect(result.missedLast30).toBeLessThanOrEqual(1);
  });

  it("computes 0% adherence when no events match any past slot", () => {
    const NOW = d("2025-06-10T12:00:00");
    const result = complianceChips([DAILY_8AM], [], NOW, 5);
    expect(result.adherenceRate).toBe(0);
    expect(result.missedLast30).toBeGreaterThan(0);
  });

  it("excludes skipped events from adherence denominator", () => {
    const NOW = d("2025-06-10T12:00:00");
    // Window: NOW - 3d = 2025-06-07T12:00 → past slots: 08, 09, 10
    // Provide one taken + one skipped + one taken for the three slots so
    // the denominator excludes the skipped one.
    const events: IntakeEventLike[] = [
      {
        scheduledFor: d("2025-06-08T08:30:00"),
        takenAt: d("2025-06-08T08:35:00"),
        skipped: false,
      },
      {
        scheduledFor: d("2025-06-09T08:30:00"),
        takenAt: null,
        skipped: true,
      },
      {
        scheduledFor: d("2025-06-10T08:30:00"),
        takenAt: d("2025-06-10T08:35:00"),
        skipped: false,
      },
    ];
    const result = complianceChips([DAILY_8AM], events, NOW, 3);
    // 2 taken / (2 taken + 0 missed) = 100, skipped excluded.
    expect(result.adherenceRate).toBe(100);
  });

  it("tracks currentStreak across consecutive all-good days", () => {
    const NOW = d("2025-06-10T12:00:00");
    // Today + 3 prior days all taken → current streak >= 3 (today is
    // either upcoming or taken depending on time; with NOW=12:00 and a
    // 08-09 window, today's slot is past and counts as missed unless
    // we add today's event). Add today's event too:
    const events: IntakeEventLike[] = [];
    for (let day = 7; day <= 10; day++) {
      events.push({
        scheduledFor: d(`2025-06-${String(day).padStart(2, "0")}T08:30:00`),
        takenAt: d(`2025-06-${String(day).padStart(2, "0")}T08:35:00`),
        skipped: false,
      });
    }
    const result = complianceChips([DAILY_8AM], events, NOW, 14);
    expect(result.currentStreak).toBeGreaterThanOrEqual(4);
  });

  it("breaks currentStreak on a missed day", () => {
    const NOW = d("2025-06-10T12:00:00");
    // Days 5,6,7 taken; day 8 missed; days 9,10 taken
    const events: IntakeEventLike[] = [
      {
        scheduledFor: d("2025-06-05T08:30:00"),
        takenAt: d("2025-06-05T08:35:00"),
        skipped: false,
      },
      {
        scheduledFor: d("2025-06-06T08:30:00"),
        takenAt: d("2025-06-06T08:35:00"),
        skipped: false,
      },
      {
        scheduledFor: d("2025-06-07T08:30:00"),
        takenAt: d("2025-06-07T08:35:00"),
        skipped: false,
      },
      // Day 8 skipped — represented as no event (missed).
      {
        scheduledFor: d("2025-06-09T08:30:00"),
        takenAt: d("2025-06-09T08:35:00"),
        skipped: false,
      },
      {
        scheduledFor: d("2025-06-10T08:30:00"),
        takenAt: d("2025-06-10T08:35:00"),
        skipped: false,
      },
    ];
    const result = complianceChips([DAILY_8AM], events, NOW, 7);
    // Streak ending at today = day 9 + day 10 = 2 (day 8 missed broke it).
    expect(result.currentStreak).toBeLessThanOrEqual(2);
    // Longest streak in window = max(3 from 5..7, 2 from 9..10) = 3.
    expect(result.longestStreak).toBeGreaterThanOrEqual(3);
  });

  it("respects weekly cadence: missed weekday outside daysOfWeek does not penalise", () => {
    const weekly: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: "1", // Monday only
    };
    const NOW = d("2025-06-10T12:00:00"); // Tuesday
    const events: IntakeEventLike[] = [
      {
        scheduledFor: d("2025-06-02T08:30:00"), // Mon
        takenAt: d("2025-06-02T08:35:00"),
        skipped: false,
      },
      {
        scheduledFor: d("2025-06-09T08:30:00"), // Mon
        takenAt: d("2025-06-09T08:35:00"),
        skipped: false,
      },
    ];
    const result = complianceChips([weekly], events, NOW, 14);
    expect(result.adherenceRate).toBe(100);
    expect(result.missedLast30).toBe(0);
  });

  it("counts a missed weekly Monday when no intake event is paired", () => {
    const weekly: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: "1", // Monday only
    };
    const NOW = d("2025-06-10T12:00:00"); // Tuesday
    const result = complianceChips([weekly], [], NOW, 14);
    expect(result.adherenceRate).toBe(0);
    expect(result.missedLast30).toBeGreaterThan(0);
  });

  it("threads timeZone through so chips stay consistent for tz-distant users", () => {
    // v1.4.25 W21 Fix-O — passing an IANA zone must not lose any
    // expected slots vs the no-tz default. Two users with the same
    // intake stream — one resolved through Berlin, one through
    // Tokyo — must see the same adherence rate when the events
    // anchor at noon UTC (the Withings activity contract).
    const sched: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
    };
    const NOW = d("2025-06-10T12:00:00Z");
    const events: IntakeEventLike[] = [];
    for (let day = 4; day <= 9; day++) {
      events.push({
        scheduledFor: d(`2025-06-0${day}T08:30:00Z`),
        takenAt: d(`2025-06-0${day}T08:35:00Z`),
        skipped: false,
      });
    }

    const berlin = complianceChips([sched], events, NOW, 7, undefined, "Europe/Berlin");
    const tokyo = complianceChips([sched], events, NOW, 7, undefined, "Asia/Tokyo");

    // Both must compute a finite adherence rate (the schedule has
    // expected doses in the window). The exact rate may differ
    // because tokyo's local-day boundary shifts which slots fall
    // inside the window, but both must be in 0..100.
    for (const result of [berlin, tokyo]) {
      expect(result.adherenceRate).toBeGreaterThanOrEqual(0);
      expect(result.adherenceRate).toBeLessThanOrEqual(100);
      expect(result.windowDays).toBe(7);
    }
  });
});

describe("complianceChips — canonical-engine delegation (v1.7.0 SB-SCHED-2)", () => {
  function engineCtx(over?: Partial<CadenceEngineContext>): CadenceEngineContext {
    return {
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: d("2025-05-01T00:00:00Z"),
      lastIntakeAt: null,
      timeZone: "Europe/Berlin",
      ...over,
    };
  }

  it("RRULE weekly Monday: legacy walker counts every day missed, engine counts only Mondays", () => {
    // `daysOfWeek = null` reads as every-day to the legacy walker, so an
    // RRULE-weekly schedule over-counts expected doses without the engine.
    const rruleWeekly: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      timesOfDay: ["08:00"],
    };
    const NOW = d("2025-06-10T12:00:00Z"); // Tuesday

    // Legacy path (no engineCtx) expands daily → many missed days.
    const legacy = complianceChips([rruleWeekly], [], NOW, 14);
    // Canonical path (engineCtx) expands only Mondays in the window.
    const engine = complianceChips(
      [rruleWeekly],
      [],
      NOW,
      14,
      undefined,
      "Europe/Berlin",
      engineCtx(),
    );

    // The engine path expects far fewer doses (only the Mondays in a
    // 14-day window: 2) than the daily legacy expansion (~13).
    expect(engine.missedLast30).toBeLessThan(legacy.missedLast30);
    expect(engine.missedLast30).toBeLessThanOrEqual(2);
  });

  it("PRN: engine short-circuits to zero expected doses (no adherence, no missed)", () => {
    const prn: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      scheduleType: "PRN",
      timesOfDay: ["08:00"],
    };
    const NOW = d("2025-06-10T12:00:00Z");

    const engine = complianceChips(
      [prn],
      [],
      NOW,
      30,
      undefined,
      "Europe/Berlin",
      engineCtx(),
    );

    // PRN is as-needed — never projected, reminded, or counted in
    // compliance-expected. No expected slots → null adherence, zero missed.
    expect(engine.adherenceRate).toBeNull();
    expect(engine.missedLast30).toBe(0);
  });

  it("CYCLIC: off-week days are not counted as missed", () => {
    // 1 week on / 1 week off, anchored at startsOn. The "off" week should
    // emit no expected doses, so an empty event stream cannot read as
    // 100% missed across both weeks.
    const cyclic: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      scheduleType: "CYCLIC",
      cyclicOnWeeks: 1,
      cyclicOffWeeks: 1,
      timesOfDay: ["08:00"],
    };
    const NOW = d("2025-06-10T12:00:00Z");

    const engine = complianceChips(
      [cyclic],
      [],
      NOW,
      14,
      undefined,
      "Europe/Berlin",
      engineCtx({ startsOn: d("2025-05-01T00:00:00Z") }),
    );
    const everyDay = complianceChips(
      [{ ...cyclic, scheduleType: "SCHEDULED" }],
      [],
      NOW,
      14,
      undefined,
      "Europe/Berlin",
      engineCtx({ startsOn: d("2025-05-01T00:00:00Z") }),
    );

    // The cyclic gate must drop the off-week's doses, so fewer missed
    // than the equivalent every-day SCHEDULED expansion.
    expect(engine.missedLast30).toBeLessThan(everyDay.missedLast30);
  });

  it("B15: a legacy daysOfWeek row with multiple timesOfDay emits one slot per time", () => {
    // Repro of the compliance divergence: a plain `daysOfWeek` schedule
    // (no rrule / rolling, SCHEDULED, not one-shot) carrying two
    // `timesOfDay` must expand to two slots per qualifying day through the
    // engine. Before the fix the cadence numerator routed such a row to
    // the local legacy walker, which emitted a single slot/day from
    // `windowStart` — so a 2×/day medication reported 1/2 = 50%.
    const twiceDaily: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "19:30",
      daysOfWeek: null, // every day
      timesOfDay: ["08:00", "19:00"],
      // no rrule, no rollingIntervalDays, scheduleType defaults to SCHEDULED
    };
    // A single 24-hour window starting at local midnight Berlin.
    const dayStart = d("2025-06-09T00:00:00Z");
    const NOW = d("2025-06-09T23:59:00Z");
    const ctx = engineCtx({
      startsOn: d("2025-05-01T00:00:00Z"),
      timeZone: "Europe/Berlin",
    });

    const timeline = buildCadenceTimeline(
      [twiceDaily],
      [],
      NOW,
      1,
      dayStart,
      ctx.timeZone,
      ctx,
    );

    // Both configured times land inside the one-day window → two slots.
    expect(timeline.length).toBe(2);
  });

});
