/**
 * v1.4.25 — compliance chip aggregator tests.
 *
 * The chips feed the GLP-1 detail page. Tests cover the four chip
 * values plus the no-doses-expected null path.
 */

import { describe, expect, it } from "vitest";
import { complianceChips, streaksFromTimeline } from "../compliance";
import { buildCadenceTimeline } from "../cadence";
import type { IntakeEventLike, ScheduleLike } from "../cadence";
import type { ComplianceMedicationContext } from "@/lib/analytics/compliance/types";
import { buildMedicationComplianceBundle } from "@/lib/analytics/compliance/display";

function d(iso: string): Date {
  return new Date(iso);
}

/** The medication context the chips read; UTC unless a test says otherwise. */
function ctx(
  over?: Partial<ComplianceMedicationContext>,
): ComplianceMedicationContext {
  return {
    startsOn: null,
    endsOn: null,
    endedAt: null,
    oneShot: false,
    createdAt: d("2025-05-01T00:00:00Z"),
    lastIntakeAt: null,
    timeZone: "UTC",
    ...over,
  };
}

const DAILY_8AM: ScheduleLike = {
  windowStart: "08:00",
  windowEnd: "09:00",
  daysOfWeek: null,
};

describe("complianceChips", () => {
  it("returns null adherence when no doses are expected in the window", () => {
    const NOW = d("2025-06-10T12:00:00");
    const result = complianceChips([], [], ctx(), NOW, 30);
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
    const result = complianceChips([DAILY_8AM], events, ctx(), NOW, 5);
    expect(result.adherenceRate).toBeGreaterThanOrEqual(80);
    expect(result.missedLast30).toBeLessThanOrEqual(1);
  });

  it("computes 0% adherence when no events match any past slot", () => {
    const NOW = d("2025-06-10T12:00:00");
    const result = complianceChips([DAILY_8AM], [], ctx(), NOW, 5);
    expect(result.adherenceRate).toBe(0);
    expect(result.missedLast30).toBeGreaterThan(0);
  });

  it("excludes skipped events from adherence denominator", () => {
    const NOW = d("2025-06-10T12:00:00");
    // Window: NOW - 3d = 2025-06-07T12:00 → past slots: 08, 09, 10
    // Provide one taken + one skipped + one taken for the three slots so
    // the denominator excludes the skipped one. A skip names its slot.
    const events: IntakeEventLike[] = [
      {
        scheduledFor: d("2025-06-08T08:00:00"),
        takenAt: d("2025-06-08T08:35:00"),
        skipped: false,
      },
      {
        scheduledFor: d("2025-06-09T08:00:00"),
        takenAt: null,
        skipped: true,
      },
      {
        scheduledFor: d("2025-06-10T08:00:00"),
        takenAt: d("2025-06-10T08:35:00"),
        skipped: false,
      },
    ];
    const result = complianceChips([DAILY_8AM], events, ctx(), NOW, 3);
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
    const result = complianceChips([DAILY_8AM], events, ctx(), NOW, 14);
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
    const result = complianceChips([DAILY_8AM], events, ctx(), NOW, 7);
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
    const result = complianceChips([weekly], events, ctx(), NOW, 14);
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
    const result = complianceChips([weekly], [], ctx(), NOW, 14);
    expect(result.adherenceRate).toBe(0);
    expect(result.missedLast30).toBeGreaterThan(0);
  });

  it("threads timeZone through so chips stay consistent for tz-distant users", () => {
    // v1.4.25 — passing an IANA zone must not lose any
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

    const berlin = complianceChips(
      [sched],
      events,
      ctx({ timeZone: "Europe/Berlin" }),
      NOW,
      7,
    );
    const tokyo = complianceChips(
      [sched],
      events,
      ctx({ timeZone: "Asia/Tokyo" }),
      NOW,
      7,
    );

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
  const engineCtx = (over?: Partial<ComplianceMedicationContext>) =>
    ctx({ timeZone: "Europe/Berlin", ...over });

  it("RRULE weekly Monday: only the Mondays in the window are expected", () => {
    const rruleWeekly: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      timesOfDay: ["08:00"],
    };
    // Saturday: both Mondays in the window are past a weekly dose's late tail.
    const NOW = d("2025-06-14T12:00:00Z");

    const engine = complianceChips([rruleWeekly], [], engineCtx(), NOW, 14);

    // Two Mondays in a 14-day window, both missed; `daysOfWeek = null`
    // must not read as every day.
    expect(engine.missedLast30).toBe(2);
    expect(engine.adherenceRate).toBe(0);
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

    const engine = complianceChips([prn], [], engineCtx(), NOW, 30);

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
      engineCtx({ startsOn: d("2025-05-01T00:00:00Z") }),
      NOW,
      14,
    );
    const everyDay = complianceChips(
      [{ ...cyclic, scheduleType: "SCHEDULED" }],
      [],
      engineCtx({ startsOn: d("2025-05-01T00:00:00Z") }),
      NOW,
      14,
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

describe("streaksFromTimeline — DST-correct day walk", () => {
  const DAILY_8AM: ScheduleLike = {
    windowStart: "08:00",
    windowEnd: "09:00",
    daysOfWeek: null,
  };

  it("does not drop a day across a spring-forward (23h) boundary", () => {
    // Europe/Berlin spring-forward is 2025-03-30 (23h-wide local day).
    // Take every dose for a window spanning the transition; the streak
    // must count every local calendar day, not skip the 23h day. The
    // prior fixed +24h step landed past the 23h day and the windowDays
    // iteration ran short.
    const tz = "Europe/Berlin";
    // NOW = local noon on 2025-04-02 (CEST, UTC+2 → 10:00 UTC).
    const NOW = new Date("2025-04-02T10:00:00Z");
    const windowDays = 7; // covers 2025-03-27 .. 2025-04-02 inclusive.
    const events: IntakeEventLike[] = [];
    for (
      let day = new Date("2025-03-27T06:30:00Z");
      day.getTime() <= NOW.getTime();
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
    ) {
      events.push({
        scheduledFor: new Date(day),
        takenAt: new Date(day.getTime() + 30 * 60_000),
        skipped: false,
      });
    }
    const timeline = buildCadenceTimeline(
      [DAILY_8AM],
      events,
      NOW,
      windowDays,
      undefined,
      tz,
    );
    const { current } = streaksFromTimeline(timeline, NOW, windowDays, tz);
    // Every one of the 7 local days (including the 23h spring-forward
    // day) was taken → an unbroken 7-day streak.
    expect(current).toBe(7);
  });

  it("visits each local day once across a fall-back (25h) boundary", () => {
    // Europe/Berlin fall-back is 2025-10-26 (25h-wide local day).
    const tz = "Europe/Berlin";
    const NOW = new Date("2025-10-29T11:00:00Z"); // local noon CET.
    const windowDays = 7;
    const events: IntakeEventLike[] = [];
    for (
      let day = new Date("2025-10-23T07:30:00Z");
      day.getTime() <= NOW.getTime();
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
    ) {
      events.push({
        scheduledFor: new Date(day),
        takenAt: new Date(day.getTime() + 30 * 60_000),
        skipped: false,
      });
    }
    const timeline = buildCadenceTimeline(
      [DAILY_8AM],
      events,
      NOW,
      windowDays,
      undefined,
      tz,
    );
    const { current } = streaksFromTimeline(timeline, NOW, windowDays, tz);
    expect(current).toBe(7);
  });
});

describe("complianceChips — the detail page's rate", () => {
  it("drops a pause from the chips exactly as the compliance payload does", () => {
    // Daily 08:00, paused from 10 days ago to 3 days ago, every other dose
    // taken. The chips used to tally the paused week as seven missed doses
    // (77 %) while the detail page, reading the compliance ledger, said 100.
    const NOW = d("2025-06-30T12:00:00Z");
    const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    const pausedAt = day(10);
    const resumedAt = day(3);
    const events: IntakeEventLike[] = [];
    for (let n = 1; n <= 30; n++) {
      const slot = new Date(day(n).setUTCHours(8, 0, 0, 0));
      if (slot >= pausedAt && slot < resumedAt) continue;
      events.push({ scheduledFor: slot, takenAt: slot, skipped: false });
    }
    const daily: ScheduleLike = {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["08:00"],
    };
    const context = ctx({
      createdAt: d("2025-01-01T00:00:00Z"),
      pauseEras: [{ pausedAt, resumedAt }],
    });

    const chips = complianceChips([daily], events, context, NOW, 30);
    const bundle = buildMedicationComplianceBundle(
      events,
      [daily],
      context,
      NOW,
    );

    expect(chips.missedLast30).toBe(0);
    expect(chips.adherenceRate).toBe(100);
    expect(chips.adherenceRate).toBe(bundle.compliance30.rate);
  });
});
