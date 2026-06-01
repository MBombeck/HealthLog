/**
 * v1.5.0 — `calculateCompliance` is a cadence-aware adapter over
 * `buildCadenceTimeline`. The historical wire shape (`totalExpected`,
 * `taken`, `skipped`, `missed`, `rate`, `streak`) is unchanged, but
 * the numbers now honour `daysOfWeek` and `intervalWeeks`. These
 * tests pin the contract for every cadence the production app
 * exercises: daily 1×/day, daily multi-dose, weekly Mondays-only,
 * bi-weekly, weekday-only multi-dose, and the DST-boundary day.
 * Closes #214.
 *
 * Each test uses `vi.useFakeTimers()` to pin `now` so the rolling
 * window is deterministic. `classifyIntakeTiming` tests below the
 * matrix are unchanged from the v1.4 line.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  classifyIntakeTiming,
  expectedSlotCountForDay,
  lastNonSkippedTakenAt,
  type ComplianceMedicationContext,
  type ComplianceSchedule,
} from "../compliance";
import type { IntakeTimingClass } from "../compliance";
import { buildCadenceTimeline } from "@/lib/medications/scheduling/cadence";
import { getUserTodayBounds } from "@/lib/timezone";
import { userDayKey } from "@/lib/tz/format";

const DAY_MS = 24 * 60 * 60 * 1000;

function eventAt(scheduledFor: Date, taken: boolean, skipped = false) {
  return {
    scheduledFor,
    takenAt: taken ? new Date(scheduledFor.getTime() + 30 * 60_000) : null,
    skipped,
  };
}

describe("calculateCompliance — cadence-aware adapter", () => {
  // Pin `now` to a Wednesday so weekday-only schedules have a clean
  // count of Mondays in the trailing 30-day window.
  const NOW = new Date("2025-01-15T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the empty result when no schedules are configured", () => {
    const result = calculateCompliance([], [], 7);
    expect(result).toEqual({
      totalExpected: 0,
      taken: 0,
      skipped: 0,
      missed: 0,
      rate: 100,
      streak: 0,
    });
  });

  it("daily 1×/day, 7 of 7 taken in a 7-day window → 100%", () => {
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ];
    // Anchor events to 08:30 UTC on today (NOW = 12:00 UTC, so the
    // morning slot is already past) and the six prior days. Going one
    // day further back would land the event before the rolling-window
    // start (NOW − 7 d = 2025-01-08T12:00Z, but the would-be event sits
    // at 2025-01-08T08:30Z — below the window start), which the slot
    // grid intentionally excludes. The original `NOW − N×DAY + 8h`
    // shape also landed events at 20:00 UTC on the prior day, twelve
    // hours away from the 08:00 slot — at the edge of the pairing
    // radius, which matched in Europe/Berlin and missed in UTC.
    const events = Array.from({ length: 7 }, (_, i) => {
      const at = new Date(NOW);
      at.setUTCDate(at.getUTCDate() - i);
      at.setUTCHours(8, 30, 0, 0);
      return eventAt(at, true);
    });
    const result = calculateCompliance(events, schedules, 7);
    expect(result.rate).toBe(100);
    expect(result.taken).toBe(7);
    expect(result.missed).toBe(0);
  });

  it("daily 1×/day, 0 of 7 taken in a 7-day window → 0%", () => {
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ];
    const result = calculateCompliance([], schedules, 7);
    expect(result.rate).toBe(0);
    expect(result.taken).toBe(0);
    expect(result.missed).toBeGreaterThan(0);
  });

  it("daily 3×/day, 18 of 21 taken in a 7-day window → 86% (no-cadence-restriction happy path)", () => {
    // The pre-v1.5.0 path got this case right; pin it so the migration
    // doesn't regress users on a daily multi-dose schedule.
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
      { windowStart: "13:00", windowEnd: "14:00", daysOfWeek: null },
      { windowStart: "20:00", windowEnd: "21:00", daysOfWeek: null },
    ];
    // Generate 21 events (3/day × 7 days) and drop 3 so 18 are taken.
    const events = [];
    for (let d = 1; d <= 7; d++) {
      for (const hour of [8, 13, 20]) {
        // Drop dose #4, #11, #18 to land on 18/21 → 86%.
        const idx = (d - 1) * 3 + [8, 13, 20].indexOf(hour);
        const taken = ![3, 10, 17].includes(idx);
        const scheduledFor = new Date(
          NOW.getTime() - d * DAY_MS + hour * 3600_000,
        );
        events.push(eventAt(scheduledFor, taken));
      }
    }
    const result = calculateCompliance(events, schedules, 7);
    expect(result.rate).toBe(86);
    expect(result.taken).toBe(18);
    expect(result.missed).toBe(3);
  });

  it("daily 2×/day on ONE schedule row (timesOfDay), all taken → 100%", () => {
    // Production shape: the wizard stores a twice-daily med as a single
    // MedicationSchedule row carrying `timesOfDay = ["07:00","19:00"]`,
    // NOT two rows. Pre-fix the legacy cadence walker only emitted the
    // `windowStart` slot, so the denominator was one dose/day and a
    // perfectly-adherent user could read 50% once a second dose was
    // logged. Pin the single-row twice-daily case at 100%.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "07:00",
        windowEnd: "07:30",
        daysOfWeek: null,
        timesOfDay: ["07:00", "19:00"],
      },
    ];
    // Log both doses for every day in (and just past) the 7-day window
    // so no emitted slot is left unpaired at the window boundary. NOW is
    // 12:00 UTC, so today's 19:00 slot is still `upcoming` (excluded).
    const events = [];
    for (let d = 0; d <= 8; d++) {
      const day = new Date(NOW);
      day.setUTCDate(day.getUTCDate() - d);
      const morning = new Date(day);
      morning.setUTCHours(7, 5, 0, 0);
      const evening = new Date(day);
      evening.setUTCHours(19, 5, 0, 0);
      events.push(eventAt(morning, true));
      if (d > 0) events.push(eventAt(evening, true));
    }

    const result = calculateCompliance(events, schedules, 7);
    expect(result.rate).toBe(100);
    expect(result.missed).toBe(0);
    // The window covers ~7 days × 2 doses, so the denominator is well
    // above the 7-or-so a one-slot-per-day walker would produce. The
    // load-bearing assertion is that BOTH daily doses are counted (the
    // fan-out) and every one pairs to a taken event → 100%.
    expect(result.totalExpected).toBeGreaterThanOrEqual(12);
    expect(result.taken).toBe(result.totalExpected);
  });

  it("2×/day, delete the evening dose then re-add it → still 100% / 2 of 2", () => {
    // The live regression: a user on a 07:00 + 19:00 schedule deletes
    // the evening intake and re-adds it. The compliance must read the
    // re-added dose dynamically — 2 expected, 2 taken — not collapse to
    // 50%. Modelled here on a single calendar day with both slots in the
    // past so neither is `upcoming`.
    const lateNow = new Date("2025-01-15T22:00:00Z");
    vi.setSystemTime(lateNow);
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "07:00",
        windowEnd: "07:30",
        daysOfWeek: null,
        timesOfDay: ["07:00", "19:00"],
      },
    ];
    // Morning taken once; the evening dose was deleted (its tombstoned
    // row is excluded from the events array by the route's
    // `deletedAt: null` filter) and re-added as a fresh taken event.
    const morning = new Date("2025-01-15T07:05:00Z");
    const eveningReAdded = new Date("2025-01-15T19:10:00Z");
    const events = [
      eventAt(morning, true),
      eventAt(eveningReAdded, true),
    ];
    const result = calculateCompliance(events, schedules, 1, undefined, {
      now: lateNow,
    });
    expect(result.taken).toBe(2);
    expect(result.totalExpected).toBe(2);
    expect(result.missed).toBe(0);
    expect(result.rate).toBe(100);
  });

  it("weekly Mondays, all Mondays taken in a 30-day window → 100% (the #214 bug case)", () => {
    // Pre-v1.5.0 this returned ~13% (taken / (schedules × 30) = 4/30).
    // The fix is to honour `daysOfWeek` so the denominator is the
    // number of Mondays in the window, not 30.
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: "1" },
    ];
    // NOW = Wed 2025-01-15. Mondays in the trailing 30-day window =
    // 2025-01-13, 2025-01-06, 2024-12-30, 2024-12-23, 2024-12-16.
    const mondays = [
      new Date("2025-01-13T08:30:00Z"),
      new Date("2025-01-06T08:30:00Z"),
      new Date("2024-12-30T08:30:00Z"),
      new Date("2024-12-23T08:30:00Z"),
      new Date("2024-12-16T08:30:00Z"),
    ];
    const events = mondays.map((m) => eventAt(m, true));
    const result = calculateCompliance(events, schedules, 30);
    expect(result.rate).toBe(100);
    expect(result.taken).toBeGreaterThanOrEqual(4);
    expect(result.missed).toBe(0);
  });

  it("weekly Mondays, one Monday missed in a 30-day window → 75–80%", () => {
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: "1" },
    ];
    // Take 3 of the 4 most-recent Mondays, miss one.
    const events = [
      eventAt(new Date("2025-01-13T08:30:00Z"), true),
      // 2025-01-06 missed.
      eventAt(new Date("2024-12-30T08:30:00Z"), true),
      eventAt(new Date("2024-12-23T08:30:00Z"), true),
    ];
    const result = calculateCompliance(events, schedules, 30);
    expect(result.rate).toBeGreaterThanOrEqual(60);
    expect(result.rate).toBeLessThan(100);
    expect(result.missed).toBeGreaterThanOrEqual(1);
  });

  it("bi-weekly (intervalWeeks=2), all scheduled doses taken in a 30-day window → 100%", () => {
    // Encoded recurrence: 2 weeks interval, Monday-anchored.
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: "i2;1" },
    ];
    // With NOW = Wed Jan 15 the window covers ~Dec 16–Jan 15. The
    // anchor week starts on the medicationCreatedAt week. Take both
    // possible weeks-anchored Mondays so the denominator is 2 (or 3,
    // depending on phase) and the rate is 100% either way.
    const createdAt = new Date("2024-11-04T00:00:00Z"); // Mon
    const events = [
      eventAt(new Date("2025-01-13T08:30:00Z"), true),
      eventAt(new Date("2024-12-30T08:30:00Z"), true),
      eventAt(new Date("2024-12-16T08:30:00Z"), true),
    ];
    const result = calculateCompliance(events, schedules, 30, createdAt);
    expect(result.rate).toBe(100);
    expect(result.missed).toBe(0);
  });

  it("weekday-only 3×/day, every weekday dose taken in a 30-day window → 100% (the #214 metformin case)", () => {
    // Pre-v1.5.0 this returned ~73% (66 weekday doses ÷ 90 = 73%).
    // The fix is to honour `daysOfWeek` so the denominator is
    // 3 schedules × ~22 weekdays in the window, not 3 × 30.
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: "1,2,3,4,5" },
      { windowStart: "13:00", windowEnd: "14:00", daysOfWeek: "1,2,3,4,5" },
      { windowStart: "20:00", windowEnd: "21:00", daysOfWeek: "1,2,3,4,5" },
    ];
    // Generate events for every weekday slot inside the window —
    // including today's already-past slots (08:00 UTC < NOW = 12:00).
    const events = [];
    for (let d = 0; d <= 30; d++) {
      const day = new Date(NOW.getTime() - d * DAY_MS);
      const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue; // skip weekends
      for (const hour of [8, 13, 20]) {
        const at = new Date(day);
        at.setUTCHours(hour, 30, 0, 0);
        // Skip future slots (today's 13:00 and 20:00 are in the future
        // relative to NOW = 12:00 UTC); the timeline marks those
        // `upcoming` and excludes them from the denominator anyway.
        if (at.getTime() > NOW.getTime()) continue;
        events.push(eventAt(at, true));
      }
    }
    const result = calculateCompliance(events, schedules, 30);
    expect(result.rate).toBe(100);
    expect(result.missed).toBe(0);
  });

  it("skipped doses are excluded from the denominator (not a compliance failure)", () => {
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ];
    // 7-day window — every day has a slot, every event lands on its
    // own day. Two taken + one skipped + four missed.
    const events = [
      eventAt(new Date("2025-01-14T08:30:00Z"), true),
      {
        scheduledFor: new Date("2025-01-13T08:30:00Z"),
        takenAt: null,
        skipped: true,
      },
      eventAt(new Date("2025-01-12T08:30:00Z"), true),
    ];
    const result = calculateCompliance(events, schedules, 7);
    expect(result.skipped).toBe(1);
    expect(result.taken).toBe(2);
    // The skipped day is excluded from the rate denominator.
    // Slots: Jan-9..Jan-15 = 7 (Jan-8 windowEnd 09:00 falls below the
    // window start of 12:00). Taken = 2, skipped = 1, missed = 4
    // (Jan-9, 10, 11, 15). Rate = 2 taken / (2 + 4 missed) = 33%.
    expect(result.rate).toBe(33);
  });

  it("excludes days before medicationCreatedAt from the denominator", () => {
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ];
    // Medication created 3 days ago — the prior 4 days of the 7-day
    // window must not count as missed. Anchor each event at 08:30 UTC
    // on today + the two prior days (NOW = 12:00 UTC so today's morning
    // slot is already past). Going to "3 days ago" would land the event
    // at the createdAt instant itself (08:30 < 12:00 on the cutoff day)
    // which slips just below the slot grid's emit-cutoff.
    const createdAt = new Date(NOW.getTime() - 3 * DAY_MS);
    const events = [0, 1, 2].map((daysAgo) => {
      const at = new Date(NOW);
      at.setUTCDate(at.getUTCDate() - daysAgo);
      at.setUTCHours(8, 30, 0, 0);
      return eventAt(at, true);
    });
    const result = calculateCompliance(events, schedules, 7, createdAt);
    expect(result.rate).toBe(100);
    expect(result.taken).toBe(3);
    expect(result.missed).toBe(0);
  });

  it("DST boundary (Europe/Berlin spring-forward) does not inflate the expected count", () => {
    // Spring-forward in Berlin: 2025-03-30 02:00 → 03:00. A daily
    // schedule across this boundary must still emit one slot per
    // local day — not two on the short day and zero on the next.
    // Pin `now` to Apr-02 noon UTC and run a 7-day window so the
    // boundary day is inside it. Generate one event per day
    // (working backwards from NOW − 1 day so each event lands inside
    // the window) and assert the totalExpected lands at 7 (not 8).
    vi.setSystemTime(new Date("2025-04-02T12:00:00Z"));
    const schedules: ComplianceSchedule[] = [
      { windowStart: "10:00", windowEnd: "11:00", daysOfWeek: null },
    ];
    // Slots emitted by the timeline: Mar-27..Apr-02 (Mar-26's window
    // sits below the rolling-window start of Mar-26 12:00). Generate
    // one taken event per slot — today's 10:30 slot is also in the
    // past relative to NOW = 12:00 so it counts as taken too.
    const events = [];
    for (let d = 0; d <= 6; d++) {
      const at = new Date("2025-04-02T10:30:00Z");
      at.setUTCDate(at.getUTCDate() - d);
      events.push(eventAt(at, true));
    }
    const result = calculateCompliance(events, schedules, 7);
    // The hard contract: totalExpected stays at 7 — not 8 (which
    // would mean the DST short day double-emitted) and not 6 (which
    // would mean the short day silently dropped a slot).
    expect(result.totalExpected).toBe(7);
    expect(result.taken).toBe(7);
    expect(result.missed).toBe(0);
    expect(result.rate).toBe(100);
  });

  it("filters events outside the rolling window", () => {
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ];
    const events = [
      eventAt(new Date("2025-01-14T08:30:00Z"), true),
      eventAt(new Date("2024-12-01T08:30:00Z"), true),
    ];
    const result = calculateCompliance(events, schedules, 7);
    expect(result.taken).toBe(1);
  });

  it("caps rate at 100% when more intakes than expected exist", () => {
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ];
    // Same-day duplicate logs — the pair algorithm matches one and
    // leaves the duplicates dangling; the rate stays at or below 100.
    const events = Array.from({ length: 10 }, (_, i) => ({
      scheduledFor: new Date(`2025-01-14T08:${String(i).padStart(2, "0")}:00Z`),
      takenAt: new Date(`2025-01-14T08:${String(i).padStart(2, "0")}:00Z`),
      skipped: false,
    }));
    const result = calculateCompliance(events, schedules, 7);
    expect(result.rate).toBeLessThanOrEqual(100);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.7.0 SB-SCHED-2 — canonical-engine-routed compliance (Option B)
//
// When a `medicationContext` is supplied, the expected-slot denominator
// runs through the canonical recurrence engine. These golden fixtures
// pin every cadence type's denominator explicitly — this is the
// riskiest change of the release because it moves every adherence number
// for non-daily meds.
// ────────────────────────────────────────────────────────────────────

describe("calculateCompliance — engine-routed (medicationContext)", () => {
  // Pin `now` to a Wednesday so a weekly Monday cadence has a clean
  // count of Mondays in the trailing 30-day window.
  const NOW = new Date("2025-01-15T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function ctx(overrides: Partial<{
    startsOn: Date | null;
    endsOn: Date | null;
    oneShot: boolean;
    createdAt: Date;
    lastIntakeAt: Date | null;
    timeZone: string;
  }> = {}) {
    return {
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date("2024-12-01T00:00:00Z"),
      lastIntakeAt: null,
      timeZone: "UTC",
      ...overrides,
    };
  }

  it("parity: a legacy daysOfWeek-only schedule yields identical numbers with no context", () => {
    const schedules: ComplianceSchedule[] = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ];
    const events = Array.from({ length: 7 }, (_, i) =>
      eventAt(new Date(NOW.getTime() - (i + 1) * DAY_MS), true),
    );
    const legacy = calculateCompliance(events, schedules, 7);
    const withCtx = calculateCompliance(events, schedules, 7, undefined, {
      medicationContext: ctx(),
    });
    // Legacy daysOfWeek-only schedule has no canonical fields → both
    // paths run the legacy walker → identical numbers.
    expect(withCtx).toEqual(legacy);
  });

  it("FREQ=WEEKLY;BYDAY=MO — took every Monday → 100%, denominator counts only Mondays", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        timesOfDay: ["08:00"],
      },
    ];
    // Mondays in the trailing 30 days from Wed 2025-01-15: Jan 13, 6,
    // Dec 30, 23, 16. Log a taken intake on each.
    const mondays = [
      "2025-01-13T08:30:00Z",
      "2025-01-06T08:30:00Z",
      "2024-12-30T08:30:00Z",
      "2024-12-23T08:30:00Z",
      "2024-12-16T08:30:00Z",
    ].map((s) => ({
      scheduledFor: new Date(s),
      takenAt: new Date(s),
      skipped: false,
    }));
    const result = calculateCompliance(mondays, schedules, 30, undefined, {
      medicationContext: ctx(),
    });
    expect(result.rate).toBe(100);
    // Denominator is the count of Mondays, not 30 days.
    expect(result.totalExpected).toBeLessThanOrEqual(6);
    expect(result.totalExpected).toBeGreaterThanOrEqual(4);
  });

  it("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE — bi-weekly denominator counts only on-weeks", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
        timesOfDay: ["08:00"],
      },
    ];
    const result = calculateCompliance([], schedules, 30, undefined, {
      medicationContext: ctx({ startsOn: new Date("2024-12-04T00:00:00Z") }),
    });
    // Over ~30 days a bi-weekly Wednesday emits roughly 2 slots, never
    // the ~4 a weekly Wednesday would. Nothing taken → all missed.
    expect(result.totalExpected).toBeLessThanOrEqual(3);
  });

  it("rolling rollingIntervalDays=7 — only the next-due slot counts", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    // Last intake 5 days ago → next due in 2 days (future) → no past
    // expected slot inside the window → empty-window contract → 100.
    const result = calculateCompliance([], schedules, 30, undefined, {
      medicationContext: ctx({
        lastIntakeAt: new Date(NOW.getTime() - 5 * DAY_MS),
      }),
    });
    expect(result.totalExpected).toBe(0);
    expect(result.rate).toBe(100);
  });

  it("one-shot — exactly one expected slot on startsOn", () => {
    const startsOn = new Date("2025-01-10T00:00:00Z");
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        scheduleType: "SCHEDULED",
        timesOfDay: ["08:00"],
      },
    ];
    const result = calculateCompliance([], schedules, 30, undefined, {
      medicationContext: ctx({ oneShot: true, startsOn, endsOn: startsOn }),
    });
    // One-shot anchored on Jan 10 → exactly one expected slot in the
    // trailing-30 window; nothing taken → one missed.
    expect(result.totalExpected).toBe(1);
    expect(result.missed).toBe(1);
  });

  it("PRN — rate 100, totalExpected 0, even with a daily rrule present", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        scheduleType: "PRN",
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const result = calculateCompliance([], schedules, 30, undefined, {
      medicationContext: ctx(),
    });
    expect(result.totalExpected).toBe(0);
    expect(result.rate).toBe(100);
  });

  it("cyclic 2-on/1-off — off-week days are not counted in the denominator", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        scheduleType: "CYCLIC",
        cyclicOnWeeks: 2,
        cyclicOffWeeks: 1,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const cyclicResult = calculateCompliance([], schedules, 30, undefined, {
      medicationContext: ctx({ startsOn: new Date("2024-12-01T00:00:00Z") }),
    });
    const dailySchedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const dailyResult = calculateCompliance([], dailySchedules, 30, undefined, {
      medicationContext: ctx({ startsOn: new Date("2024-12-01T00:00:00Z") }),
    });
    // Cyclic drops the off-weeks → strictly fewer expected slots than a
    // plain daily over the same window.
    expect(cyclicResult.totalExpected).toBeLessThan(dailyResult.totalExpected);
  });

  it("DST spring-forward day (Europe/Berlin) parity — daily rate stays 100", () => {
    // Europe/Berlin spring-forward 2025-03-30. Pin now just after it.
    vi.setSystemTime(new Date("2025-03-31T12:00:00Z"));
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    // Log a taken intake around 08:00 Berlin local for each of the past
    // 7 days. The ±12 h pairing radius absorbs the DST hour shift, so a
    // daily schedule across the spring-forward boundary stays compliant.
    // Log a taken intake around 08:00 Berlin local for each day spanning
    // the window with a one-day pad on each edge. The ±12 h pairing
    // radius absorbs the DST hour shift, so every expected daily slot
    // across the spring-forward boundary pairs with a logged intake.
    const events = Array.from({ length: 10 }, (_, i) => {
      const sched = new Date(
        new Date("2025-03-31T12:00:00Z").getTime() - (i - 1) * DAY_MS,
      );
      sched.setUTCHours(6, 30, 0, 0); // ~08:00 Berlin (CET/CEST)
      return { scheduledFor: sched, takenAt: sched, skipped: false };
    });
    const result = calculateCompliance(events, schedules, 7, undefined, {
      medicationContext: ctx({ timeZone: "Europe/Berlin" }),
    });
    // Daily cadence across the DST boundary stays fully compliant — no
    // expected slot is left unpaired.
    expect(result.rate).toBe(100);
    expect(result.missed).toBe(0);
  });

  it("B15: legacy daysOfWeek row with two timesOfDay — 2×/day taken reads 100%, not 50%", () => {
    // Regression for the compliance divergence: a plain `daysOfWeek`
    // schedule (no rrule / rolling, SCHEDULED, not one-shot) carrying two
    // `timesOfDay` must expand its numerator through the same engine as
    // the denominator. Before the fix the numerator's local legacy walker
    // emitted one slot/day from `windowStart`, while the denominator's
    // engine counted both — collapsing a fully-adherent 2×/day med to
    // 1/2 = 50%.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "19:30",
        daysOfWeek: null, // every day
        timesOfDay: ["08:00", "19:00"],
        // no rrule, no rollingIntervalDays, scheduleType defaults SCHEDULED
      },
    ];
    // Pin a single-day window so exactly two slots are expected. NOW is
    // late evening UTC so both of today's slots are in the past.
    vi.setSystemTime(new Date("2025-06-09T23:30:00Z"));
    const events = [
      eventAt(new Date("2025-06-09T08:00:00Z"), true),
      eventAt(new Date("2025-06-09T19:00:00Z"), true),
    ];
    const result = calculateCompliance(events, schedules, 1, undefined, {
      medicationContext: ctx({ startsOn: new Date("2025-05-01T00:00:00Z") }),
    });
    // Both daily slots expand and both pair with a taken intake → 2/2.
    expect(result.totalExpected).toBe(2);
    expect(result.taken).toBe(2);
    expect(result.rate).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.7.0 item 5 — per-day due / expectedCount helpers
// ────────────────────────────────────────────────────────────────────

describe("expectedSlotCountForDay + lastNonSkippedTakenAt", () => {
  function ctx(
    overrides: Partial<ComplianceMedicationContext> = {},
  ): ComplianceMedicationContext {
    return buildComplianceMedicationContext(
      {
        startsOn: overrides.startsOn ?? null,
        endsOn: overrides.endsOn ?? null,
        oneShot: overrides.oneShot ?? false,
        createdAt: overrides.createdAt ?? new Date("2024-12-01T00:00:00Z"),
      },
      overrides.lastIntakeAt ?? null,
      overrides.timeZone ?? "UTC",
    );
  }

  it("weekly BYDAY — due on the matching weekday, not due otherwise", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        timesOfDay: ["08:00"],
      },
    ];
    // 2025-01-13 is a Monday; 2025-01-14 a Tuesday.
    const monday = expectedSlotCountForDay(
      schedules,
      new Date("2025-01-13T00:00:00Z"),
      new Date("2025-01-14T00:00:00Z"),
      ctx(),
    );
    const tuesday = expectedSlotCountForDay(
      schedules,
      new Date("2025-01-14T00:00:00Z"),
      new Date("2025-01-15T00:00:00Z"),
      ctx(),
    );
    expect(monday).toBe(1);
    expect(tuesday).toBe(0);
  });

  it("PRN — never due", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        scheduleType: "PRN",
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const count = expectedSlotCountForDay(
      schedules,
      new Date("2025-01-13T00:00:00Z"),
      new Date("2025-01-14T00:00:00Z"),
      ctx(),
    );
    expect(count).toBe(0);
  });

  it("multi time-of-day daily — expectedCount reflects each dose", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00", "20:00"],
      },
    ];
    const count = expectedSlotCountForDay(
      schedules,
      new Date("2025-01-13T00:00:00Z"),
      new Date("2025-01-14T00:00:00Z"),
      ctx(),
    );
    expect(count).toBe(2);
  });

  it("B15 invariant: legacy multi-time row — denominator and numerator expand identically", () => {
    // The B15 bug lived in the numerator's expander, not here — this
    // helper always ran the engine. Pin the convergence directly: for a
    // plain `daysOfWeek` row carrying two `timesOfDay` (no rrule), the
    // per-day denominator and the cadence numerator
    // (`buildCadenceTimeline`) must report the same slot count.
    const dayStart = new Date("2025-06-09T00:00:00Z");
    const dayEnd = new Date("2025-06-10T00:00:00Z");
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "19:30",
        daysOfWeek: null,
        timesOfDay: ["08:00", "19:00"],
      },
    ];
    const medCtx = ctx({
      startsOn: new Date("2025-05-01T00:00:00Z"),
      timeZone: "Europe/Berlin",
    });

    const denominator = expectedSlotCountForDay(
      schedules,
      dayStart,
      dayEnd,
      medCtx,
    );

    const numerator = buildCadenceTimeline(
      [
        {
          windowStart: "08:00",
          windowEnd: "19:30",
          daysOfWeek: null,
          timesOfDay: ["08:00", "19:00"],
        },
      ],
      [],
      new Date("2025-06-09T23:59:00Z"),
      1,
      dayStart,
      medCtx.timeZone,
      {
        startsOn: medCtx.startsOn,
        endsOn: medCtx.endsOn,
        oneShot: medCtx.oneShot,
        createdAt: medCtx.createdAt,
        lastIntakeAt: medCtx.lastIntakeAt,
        timeZone: medCtx.timeZone,
      },
    ).length;

    expect(numerator).toBe(denominator);
    expect(numerator).toBe(2);
  });

  it("lastNonSkippedTakenAt picks the newest non-skipped takenAt", () => {
    const events = [
      { takenAt: new Date("2025-01-10T08:00:00Z"), skipped: false },
      { takenAt: new Date("2025-01-12T08:00:00Z"), skipped: false },
      { takenAt: new Date("2025-01-13T08:00:00Z"), skipped: true },
      { takenAt: null, skipped: false },
    ];
    expect(lastNonSkippedTakenAt(events)?.toISOString()).toBe(
      "2025-01-12T08:00:00.000Z",
    );
    expect(lastNonSkippedTakenAt([])).toBe(null);
  });

  // v1.7.0 code-correctness M1 — the per-med compliance route must
  // anchor each daily cell on the user-tz local-day boundary so the
  // `due` / `expectedCount` flag attaches to the calendar cell the user
  // actually sees. A UTC-midnight slice would shove a tz-distant user's
  // dose into the adjacent day. These tests model the route's day
  // computation (getUserTodayBounds + userDayKey) and assert the engine
  // counts the dose in the cell its dateKey labels.
  it("anchors the due slot on the user-tz local day for a UTC+13 user", () => {
    const tz = "Pacific/Auckland"; // UTC+12, +13 in DST (January = NZDT +13)
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];

    // A representative instant inside 2025-01-14 local (noon NZ).
    const representative = new Date("2025-01-14T12:00:00+13:00");
    const { start, end } = getUserTodayBounds(representative, tz);
    const dayEnd = new Date(end.getTime() + 1); // half-open [start, dayEnd)

    // The cell key is the user-tz day, not the UTC slice. 08:00 NZ on
    // the 14th is 19:00 UTC on the 13th — a UTC slice would mislabel it.
    expect(userDayKey(start, tz)).toBe("2025-01-14");

    const count = expectedSlotCountForDay(schedules, start, dayEnd, ctx({ timeZone: tz }));
    expect(count).toBe(1);
  });

  it("does not double-count or drop a dose at the user-tz day boundary", () => {
    const tz = "Pacific/Auckland";
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];

    // Two adjacent local days: the 14th must hold exactly one dose, the
    // 13th exactly one — neither steals the other's slot.
    const day14 = getUserTodayBounds(new Date("2025-01-14T12:00:00+13:00"), tz);
    const day13 = getUserTodayBounds(new Date("2025-01-13T12:00:00+13:00"), tz);

    const count14 = expectedSlotCountForDay(
      schedules,
      day14.start,
      new Date(day14.end.getTime() + 1),
      ctx({ timeZone: tz }),
    );
    const count13 = expectedSlotCountForDay(
      schedules,
      day13.start,
      new Date(day13.end.getTime() + 1),
      ctx({ timeZone: tz }),
    );

    expect(count14).toBe(1);
    expect(count13).toBe(1);
    expect(userDayKey(day14.start, tz)).toBe("2025-01-14");
    expect(userDayKey(day13.start, tz)).toBe("2025-01-13");
  });
});

describe("classifyIntakeTiming", () => {
  // v1.4.34 IW-C — the classifier now widens the pre-window grace to
  // 3h and introduces an `early` bucket so a proactive logger (10 min
  // before the window) is no longer flushed to `very_late`. Doses up
  // to 3h past `windowEnd` stay `on_time`; `late` spans the next 2h
  // tail; anything beyond is `very_late`. Overnight windows are
  // exercised in parallel by the parameterised matrix below.
  const scheduledDate = new Date("2025-01-15T00:00:00Z");

  it('returns "missed" when takenAt is null', () => {
    expect(classifyIntakeTiming(null, "08:00", "09:00", scheduledDate)).toBe(
      "missed",
    );
  });

  it('returns "on_time" when taken within the window', () => {
    const takenAt = new Date("2025-01-15T08:30:00Z");
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  it('returns "on_time" when taken exactly at windowStart', () => {
    const takenAt = new Date("2025-01-15T08:00:00Z");
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  it('returns "on_time" when taken exactly at windowEnd', () => {
    const takenAt = new Date("2025-01-15T09:00:00Z");
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  // Parameterised offset matrix relative to a `08:00 → 09:00` window.
  // Negative offsets are minutes before `windowStart` (08:00); positive
  // offsets are minutes after `windowEnd` (09:00). The reference
  // boundaries are: `early` from -180 to -1 min before start; `on_time`
  // from start through windowEnd + 180 min; `late` for the next 120
  // min; `very_late` past that or beyond the 3h pre-window grace.
  it.each<[label: string, offsetMin: number, expected: IntakeTimingClass]>([
    ["3.5h before window → very_late", -210, "very_late"],
    ["exactly 3h before window → early", -180, "early"],
    ["1h before window → early", -60, "early"],
    ["10 min before window → early", -10, "early"],
    ["exactly at windowStart → on_time", 0, "on_time"],
    ["10 min into the window → on_time", 10, "on_time"],
    ["20 min past windowEnd → on_time", 80, "on_time"],
    ["1h past windowEnd → on_time", 120, "on_time"],
    ["exactly 3h past windowEnd → on_time", 240, "on_time"],
    ["3.5h past windowEnd → late", 270, "late"],
    ["5h past windowEnd → late (tail boundary)", 360, "late"],
    ["5h 1min past windowEnd → very_late", 361, "very_late"],
  ])("offset case: %s", (_label, offsetMin, expected) => {
    // The matrix expresses offsets relative to windowStart (negative)
    // or relative to windowEnd (positive). 0 sits at windowStart, +60
    // sits at windowEnd, then positive offsets accumulate past
    // windowEnd. With windowStart=08:00 and windowEnd=09:00, the
    // base instant is 08:00Z; positive offsets walk forward from there.
    const baseMs = new Date("2025-01-15T08:00:00Z").getTime();
    const takenAt = new Date(baseMs + offsetMin * 60 * 1000);
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      expected,
    );
  });

  it('returns "very_late" when taken way before the grace period', () => {
    const takenAt = new Date("2025-01-15T03:00:00Z"); // 5h before 08:00
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", scheduledDate)).toBe(
      "very_late",
    );
  });

  it('respects the configurable `lateMinutes` tail', () => {
    // With lateMinutes=30 the late tail collapses to 30 min after the
    // 3h on-time grace. windowEnd is 09:00 so `on_time` extends to
    // 12:00 and `late` extends to 12:30. A dose at 12:15 falls in
    // `late`; one at 12:45 falls in `very_late`.
    const takenLate = new Date("2025-01-15T12:15:00Z");
    expect(
      classifyIntakeTiming(takenLate, "08:00", "09:00", scheduledDate, {
        lateMinutes: 30,
      }),
    ).toBe("late");

    const takenVeryLate = new Date("2025-01-15T12:45:00Z");
    expect(
      classifyIntakeTiming(takenVeryLate, "08:00", "09:00", scheduledDate, {
        lateMinutes: 30,
      }),
    ).toBe("very_late");
  });

  it("handles overnight windows (windowEnd < windowStart)", () => {
    // Schedule: 23:00 - 01:00 (overnight)
    const takenAt = new Date("2025-01-15T23:30:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "on_time",
    );
  });

  it("handles overnight window early intake", () => {
    // Schedule: 23:00 - 01:00, taken at 22:30 (30 min before windowStart)
    const takenAt = new Date("2025-01-15T22:30:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "early",
    );
  });

  it("handles overnight window late intake", () => {
    // Schedule: 23:00 - 01:00, taken at 04:30 (3.5h past 01:00)
    const takenAt = new Date("2025-01-16T04:30:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "late",
    );
  });

  it("handles overnight window very late intake", () => {
    // Schedule: 23:00 - 01:00, taken at 07:00 (6h past 01:00)
    const takenAt = new Date("2025-01-16T07:00:00Z");
    expect(classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate)).toBe(
      "very_late",
    );
  });
});
