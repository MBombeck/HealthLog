/**
 * v1.5.0 — `calculateCompliance` is a cadence-aware adapter over
 * `buildCadenceTimeline`. The historical wire shape (`totalExpected`,
 * `taken`, `skipped`, `missed`, `rate`, `streak`) is unchanged, but
 * the numbers now honour `daysOfWeek` and `intervalWeeks`. These
 * tests pin the contract for every cadence the production app
 * exercises: daily 1×/day, daily multi-dose, weekly Mondays-only,
 * bi-weekly, and weekday-only multi-dose. Closes #214.
 *
 * The DST local-day walk is NOT pinned here. A "DST boundary" case used
 * to sit in this file passing no timezone, so the slot builder took the
 * legacy UTC path where the date carries no transition — it asserted
 * `totalExpected === 7`, which holds in every zone and therefore could
 * never see a double-emit. Threading a real zone through it does not
 * help: the assertion stays true in Berlin, UTC, UTC+14 and UTC−11
 * alike. The property it claimed lives in
 * `src/lib/medications/scheduling/__tests__/compliance.test.ts`, which
 * walks `buildCadenceTimeline` with an explicit zone across BOTH the 23 h
 * spring-forward and the 25 h fall-back day.
 *
 * Each test uses `vi.useFakeTimers()` to pin `now` so the rolling
 * window is deterministic. `classifyIntakeTiming` tests below the
 * matrix are unchanged from the v1.4 line.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  DOSE_WINDOW_DEFAULTS,
  MIN_STABLE_DOSES,
  buildComplianceDisplay,
  buildComplianceMedicationContext,
  calculateCompliance,
  classifyIntakeTiming,
  deriveDoseStatus,
  doseCadenceFamily,
  expectedSlotCountForDay,
  expectedSlotsBetween,
  lastNonSkippedTakenAt,
  tallyComplianceFromLedger,
  type ComplianceMedicationContext,
  type ComplianceSchedule,
} from "@/lib/analytics/compliance";
import type { IntakeTimingClass } from "@/lib/analytics/compliance";
import { buildCadenceTimeline } from "@/lib/medications/scheduling/cadence";
import { getUserTodayBounds } from "@/lib/tz/local-day";
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
    const events = [eventAt(morning, true), eventAt(eveningReAdded, true)];
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

  function ctx(
    overrides: Partial<{
      startsOn: Date | null;
      endsOn: Date | null;
      oneShot: boolean;
      createdAt: Date;
      lastIntakeAt: Date | null;
      timeZone: string;
    }> = {},
  ) {
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

  it("on-time takes: the ledger scores every logged 08:00 dose as taken (100%)", () => {
    // v1.15.18 — the context path now tallies the unified dose-history
    // ledger (band membership) instead of the legacy ±12h proximity timeline.
    // An 08:00 daily dose taken at 08:00 sits inside the ±60min on-time band →
    // taken_on_time. The seven logged days all score taken; the current-day
    // 08:00 slot is still inside its takeable window at NOW (12:00, the late
    // tail ends at 12:00) so it reads upcoming, not missed → a clean 100%.
    // (The off-time / stricter behaviour is pinned in the next test.)
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        timesOfDay: ["08:00"],
      },
    ];
    const onTime = (d: Date) => ({
      scheduledFor: d,
      takenAt: d,
      skipped: false,
    });
    const events = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(NOW.getTime() - (i + 1) * DAY_MS);
      day.setUTCHours(8, 0, 0, 0);
      return onTime(day);
    });
    const withCtx = calculateCompliance(events, schedules, 7, undefined, {
      medicationContext: ctx(),
    });
    // The window floors at NOW − 7d (Jan-8 12:00), so Jan-8's 08:00 dose falls
    // just before it; the six in-window logged doses (Jan-9..Jan-14) all score
    // taken and the current-day slot is still upcoming → 100%.
    expect(withCtx.taken).toBe(6);
    expect(withCtx.missed).toBe(0);
    expect(withCtx.rate).toBe(100);
  });

  it("off-time take: the ledger is stricter than the legacy ±12h proximity matcher", () => {
    // v1.15.18 — the keystone behaviour change. A daily 08:00 dose logged at
    // 12:30 (4.5h late) USED to count as taken under the ±12h `pairDoses`
    // proximity matcher. The unified band model attributes it honestly: 12:30
    // is outside the 08:00 slot's on-time band (07:00–09:00) AND its late tail
    // (to ~12:00), so it is an AD-HOC take and the slot reads MISSED. The
    // percentage now agrees with the history view (the dose cannot read
    // "taken" in the % while the ledger calls it ad-hoc).
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        timesOfDay: ["08:00"],
      },
    ];
    // takenAt = 08:00 slot + 4.5h = 12:30 (eventAt adds 30min onto a 12:00
    // scheduledFor; here we pin the off-time take explicitly).
    const events = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(NOW.getTime() - (i + 1) * DAY_MS);
      day.setUTCHours(8, 0, 0, 0);
      return {
        scheduledFor: day,
        takenAt: new Date(day.getTime() + 4.5 * 60 * 60 * 1000),
        skipped: false,
      };
    });
    const withCtx = calculateCompliance(events, schedules, 7, undefined, {
      medicationContext: ctx(),
    });
    // Every off-time take is ad-hoc → its slot is missed → 0% taken.
    expect(withCtx.taken).toBe(0);
    expect(withCtx.missed).toBeGreaterThanOrEqual(6);
    expect(withCtx.rate).toBe(0);
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

  it("rolling rollingIntervalDays=7 — the open forward cycle is upcoming, not a slot (no events → empty)", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    // v1.13.x — this test previously asserted the OLD forward-only behaviour
    // ("only the next-due slot counts"). With the retrospective rolling
    // expansion the grid is built from the LOGGED intakes — here there are
    // none, and `lastIntakeAt` is 5 days ago so the forward next-due slot is
    // 2 days out (future, > now) → excluded as upcoming. With no logged
    // intakes in the window and no past-due slot the window is empty →
    // empty-window contract → 100 / totalExpected 0. (A faithful history now
    // reads its true rate — see the dedicated 12-shot test below.)
    const result = calculateCompliance([], schedules, 30, undefined, {
      medicationContext: ctx({
        lastIntakeAt: new Date(NOW.getTime() - 5 * DAY_MS),
      }),
    });
    expect(result.totalExpected).toBe(0);
    expect(result.rate).toBe(100);
  });

  // ──────────────────────────────────────────────────────────────────
  // v1.13.x — ROLLING retrospective expansion. The canonical engine's
  // `expandRolling` is forward-only: it emits at most the single
  // immediately-next slot, so a historical compliance window over a
  // rolling weekly injection (the GLP-1 default) saw either zero expected
  // slots (vacuous 100%) or one overdue slot (hard 0%) — never the true
  // multi-dose adherence. The compliance layer now reconstructs the
  // historical grid from the logged intakes (each dose is one satisfied
  // expected slot, with synthesized misses for skipped whole cycles + a
  // past-due forward slot). These tests pin that the live "0% despite many
  // recorded intakes" defect is fixed.
  // ──────────────────────────────────────────────────────────────────

  it("rolling rollingIntervalDays=7 — 12 weekly shots logged → high rate, not 0%/100%-vacuous", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    // 12 consecutive weekly shots, each ~7 days apart, taken at varying
    // times of day (the real-world off-HH:mm pattern). Most recent 3 days ago.
    const lastShot = new Date(NOW.getTime() - 3 * DAY_MS);
    const intakes = Array.from({ length: 12 }, (_, i) => {
      const at = new Date(lastShot.getTime() - i * 7 * DAY_MS);
      at.setUTCHours(19 + (i % 3), 0, 0, 0); // 19:00/20:00/21:00 — off the 08:00 slot
      return { scheduledFor: at, takenAt: at, skipped: false };
    });
    const lastIntakeAt = intakes[0].takenAt;
    for (const days of [30, 90]) {
      const result = calculateCompliance(intakes, schedules, days, undefined, {
        medicationContext: ctx({ lastIntakeAt, startsOn: intakes[11].takenAt }),
      });
      // Each logged shot is a satisfied expected slot → taken tracks the
      // number of shots in the window; rate is high; not the broken 0%.
      expect(result.taken).toBeGreaterThanOrEqual(days === 30 ? 4 : 12);
      expect(result.rate).toBeGreaterThanOrEqual(90);
      expect(result.missed).toBe(0);
    }
  });

  it("rolling weekly — a shot logged a day late from its cycle still pairs (2 of 2, no phantom miss)", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    // Two shots: cycle anchor + a second shot logged ~8 days later (1 day
    // late, inside the 1.5·N tolerance), then nothing — both count taken,
    // none missed (the late dose must NOT synthesize a phantom missed cycle).
    const first = new Date(NOW.getTime() - 16 * DAY_MS);
    const second = new Date(first.getTime() + 8 * DAY_MS); // 1 day late
    const intakes = [
      { scheduledFor: second, takenAt: second, skipped: false },
      { scheduledFor: first, takenAt: first, skipped: false },
    ];
    const result = calculateCompliance(intakes, schedules, 30, undefined, {
      medicationContext: ctx({ lastIntakeAt: second, startsOn: first }),
    });
    expect(result.taken).toBe(2);
    expect(result.missed).toBe(0);
    expect(result.rate).toBe(100);
  });

  it("rolling weekly — a 3-week gap between shots synthesizes the skipped cycles as missed", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    // Shot A, then a 21-day gap (2 missed cycles), then shot B.
    const a = new Date(NOW.getTime() - 28 * DAY_MS);
    const b = new Date(a.getTime() + 21 * DAY_MS);
    const intakes = [
      { scheduledFor: b, takenAt: b, skipped: false },
      { scheduledFor: a, takenAt: a, skipped: false },
    ];
    const result = calculateCompliance(intakes, schedules, 30, undefined, {
      medicationContext: ctx({ lastIntakeAt: b, startsOn: a }),
    });
    // 2 taken (A, B) + ~2 synthesized missed cycles in the gap → ~50%.
    expect(result.taken).toBe(2);
    expect(result.missed).toBeGreaterThanOrEqual(1);
    expect(result.rate).toBeLessThan(100);
  });

  it("rolling weekly — last shot 3 days ago, next due in 4 days → upcoming, excluded from denominator", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    const lastShot = new Date(NOW.getTime() - 3 * DAY_MS);
    const intakes = [
      { scheduledFor: lastShot, takenAt: lastShot, skipped: false },
    ];
    const result = calculateCompliance(intakes, schedules, 30, undefined, {
      medicationContext: ctx({ lastIntakeAt: lastShot, startsOn: lastShot }),
    });
    // The one closed cycle (the logged shot) is taken; the open forward
    // cycle is upcoming and must NOT count as missed → 100%, missed 0.
    expect(result.missed).toBe(0);
    expect(result.taken).toBe(1);
    expect(result.rate).toBe(100);
  });

  // ──────────────────────────────────────────────────────────────────
  // v1.12.0 — weekly-injectable matching radius. A weekly med (Mounjaro)
  // is dosed once a week, but a real intake is almost never logged within
  // 12h of the schedule's configured HH:mm: the user takes the shot on
  // whichever day / time of the dosing week suits them. The pre-fix ±12h
  // pairing radius orphaned those intakes — every weekly slot read
  // `missed` and the rate collapsed to 0% across EVERY window despite
  // recorded intakes. The radius now scales with the cadence gap so an
  // intake anywhere in the dosing week pairs to that week's slot.
  // ──────────────────────────────────────────────────────────────────

  it("FREQ=WEEKLY;BYDAY=MO — Mondays taken late in the evening (22:00) still pair → 100%, not 0%", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "07:30",
        windowEnd: "08:30",
        daysOfWeek: null,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        timesOfDay: ["07:30"],
      },
    ];
    // The configured slot is 07:30; the user logs the shot the same
    // Monday but at 22:00 — 14.5h from the slot, outside the legacy ±12h
    // radius. Thirteen consecutive Mondays back from the pinned Wednesday.
    const lastMonday = new Date("2025-01-13T22:00:00Z");
    const intakes = Array.from({ length: 13 }, (_, i) => {
      const at = new Date(lastMonday.getTime() - i * 7 * DAY_MS);
      return { scheduledFor: at, takenAt: at, skipped: false };
    });
    const lastIntakeAt = intakes[0].takenAt;
    for (const days of [7, 30, 90]) {
      const result = calculateCompliance(intakes, schedules, days, undefined, {
        medicationContext: ctx({ lastIntakeAt }),
      });
      expect(result.rate).toBe(100);
      expect(result.taken).toBeGreaterThan(0);
      expect(result.missed).toBe(0);
    }
  });

  it("FREQ=WEEKLY;BYDAY=MO — single-slot 7-day window: an off-time Monday still pairs (1/1 = 100%)", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "07:30",
        windowEnd: "08:30",
        daysOfWeek: null,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        timesOfDay: ["07:30"],
      },
    ];
    // The 7-day window holds exactly one Monday slot — the per-slot
    // neighbour-gap widening can't fire (no second slot), so this pins the
    // schedule-derived radius floor that `buildCadenceTimeline` supplies.
    const monday = new Date("2025-01-13T20:00:00Z"); // 12.5h after 07:30
    const intakes = [{ scheduledFor: monday, takenAt: monday, skipped: false }];
    const result = calculateCompliance(intakes, schedules, 7, undefined, {
      medicationContext: ctx({ lastIntakeAt: monday }),
    });
    expect(result.totalExpected).toBe(1);
    expect(result.taken).toBe(1);
    expect(result.rate).toBe(100);
  });

  it("legacy daysOfWeek='1' (Monday-only) — off-time Mondays still pair → non-zero across all windows", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "07:30",
        windowEnd: "08:30",
        daysOfWeek: "1",
        timesOfDay: ["07:30"],
      },
    ];
    const lastMonday = new Date("2025-01-13T21:00:00Z");
    const intakes = Array.from({ length: 13 }, (_, i) => {
      const at = new Date(lastMonday.getTime() - i * 7 * DAY_MS);
      return { scheduledFor: at, takenAt: at, skipped: false };
    });
    const lastIntakeAt = intakes[0].takenAt;
    for (const days of [7, 30, 90]) {
      const result = calculateCompliance(intakes, schedules, days, undefined, {
        medicationContext: ctx({ lastIntakeAt }),
      });
      expect(result.rate).toBe(100);
      expect(result.missed).toBe(0);
    }
  });

  it("DAILY cadence keeps the 12h floor — an intake equidistant-far from every slot stays unmatched", () => {
    // Guard the widened radius against over-reach on a DENSE cadence: a
    // daily schedule's gap is 24h, so its match radius stays at the 12h
    // floor. An intake at 20:00 sits exactly 12h from the same day's 08:00
    // slot and 12h from the next day's 08:00 slot — at the boundary it
    // claims the nearer (same-day) slot, but a single off-day intake can
    // never pair to a slot two days away the way the weekly widening
    // allows. Pin the floor by confirming one intake claims at most one
    // daily slot.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    // One intake far from every slot's 08:00 centre — 02:00, which is 6h
    // before that day's slot but also 18h before the prior day's: only the
    // same-day slot is within 12h. A single intake → at most one taken.
    const at = new Date("2025-01-13T02:00:00Z");
    const intakes = [{ scheduledFor: at, takenAt: at, skipped: false }];
    const result = calculateCompliance(intakes, schedules, 3, undefined, {
      medicationContext: ctx({ lastIntakeAt: at }),
    });
    expect(result.taken).toBeLessThanOrEqual(1);
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

  it("streak is computed in the USER's timezone, not the host's", () => {
    // The timeline `slot.day` is minted in the user's IANA zone. The
    // streak walk must key days in the SAME zone — the prior host-tz
    // `getFullYear/getMonth/getDate` walk drifted off by a day whenever
    // the server clock's zone differed from the user's. Use a far-east
    // user zone (UTC+13) so the user-local day for a near-UTC-midnight
    // intake clearly differs from the host/UTC day; a daily-taken stream
    // must still yield an unbroken streak.
    const tz = "Pacific/Auckland";
    vi.setSystemTime(new Date("2025-06-10T11:00:00Z")); // ~23:00 NZST.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        timesOfDay: ["08:00"],
      },
    ];
    // Taken near 08:00 Auckland (= ~20:00 UTC previous day) for each of
    // the past 7 user-local days.
    const events = Array.from({ length: 7 }, (_, i) => {
      const sched = new Date(
        new Date("2025-06-09T20:00:00Z").getTime() - i * DAY_MS,
      );
      return { scheduledFor: sched, takenAt: sched, skipped: false };
    });
    const result = calculateCompliance(events, schedules, 7, undefined, {
      medicationContext: ctx({
        timeZone: tz,
        createdAt: new Date("2025-05-01T00:00:00Z"),
      }),
    });
    // Every user-local day in the window was taken → a multi-day streak.
    // The host-tz walk would have mis-keyed the boundary days and broken
    // the streak early; the user-tz walk counts them all.
    expect(result.streak).toBeGreaterThanOrEqual(6);
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

    const count = expectedSlotCountForDay(
      schedules,
      start,
      dayEnd,
      ctx({ timeZone: tz }),
    );
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

  // A degenerate POINT window (`windowStart === windowEnd`) is a real shape on
  // legacy rows. It used to take the overnight branch and inflate into a ~30h
  // on-time band, so a dose taken many hours late still counted `on_time` and
  // fed a perfect-compliance streak. It now widens symmetrically by the default
  // on-time half-width, matching `resolveLegacyWindowBounds`.
  describe("degenerate point window", () => {
    it('keeps a dose at the point itself "on_time"', () => {
      const takenAt = new Date("2025-01-15T07:00:00Z");
      expect(
        classifyIntakeTiming(takenAt, "07:00", "07:00", scheduledDate),
      ).toBe("on_time");
    });

    it('does not classify a dose ~16h late as "on_time"', () => {
      const takenAt = new Date("2025-01-15T23:00:00Z");
      expect(
        classifyIntakeTiming(takenAt, "07:00", "07:00", scheduledDate),
      ).toBe("very_late");
    });

    it("does not swallow the whole day into the on-time band", () => {
      // 13:00 is 6h past the point — outside the widened band + graces.
      const takenAt = new Date("2025-01-15T13:00:00Z");
      expect(
        classifyIntakeTiming(takenAt, "07:00", "07:00", scheduledDate),
      ).not.toBe("on_time");
    });

    it("still wraps a genuine overnight window", () => {
      // 00:30 the next day sits inside a 23:00 -> 01:00 window.
      const takenAt = new Date("2025-01-16T00:30:00Z");
      expect(
        classifyIntakeTiming(takenAt, "23:00", "01:00", scheduledDate),
      ).toBe("on_time");
    });
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

  it("respects the configurable `lateMinutes` tail", () => {
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

  it("interprets the window HH:mm in the supplied tz (non-UTC user)", () => {
    // America/Los_Angeles is UTC-7 in summer. An "08:00" slot means 08:00
    // LOCAL = 15:00 UTC on 2026-06-15; a dose taken 15 min into the window
    // is 15:15 UTC. The slot's canonical instant is the anchor date.
    const slotInstant = new Date("2026-06-15T15:00:00Z"); // 08:00 LA
    const takenAt = new Date("2026-06-15T15:15:00Z"); // 08:15 LA

    // With the user's zone the dose is on time.
    expect(
      classifyIntakeTiming(takenAt, "08:00", "09:00", slotInstant, {
        tz: "America/Los_Angeles",
      }),
    ).toBe("on_time");

    // Without a tz the window HH:mm is read as UTC (08:00 UTC), so the very
    // same on-time dose reads as 7h15m off — very_late. This is the defect
    // the achievements perfect-day check hit for users far from UTC.
    expect(classifyIntakeTiming(takenAt, "08:00", "09:00", slotInstant)).toBe(
      "very_late",
    );
  });
});

// v1.8.5 — the cadence-density rule + the per-dose uptime strip.
// `buildComplianceDisplay` decides whether the card keeps the 7-/30-day
// percentage bars (dense cadences) or swaps to a per-dose timeline
// (sparse cadences). The 30-day window is the density yardstick.
// v1.8.6 — the compliance display is always two percentage rows; only the
// window day-counts scale with the dosing cadence. `selectComplianceWindows`
// walks a `[7,30] → [30,90] → [90,365]` ladder and returns the densest rung
// whose BOTH windows clear `MIN_STABLE_DOSES` realised expected doses, so a
// daily med stays on 7 / 30, a weekly med steps up, and a rare injection
// lands on the widest rung. The timeline rendering is gone.
describe("buildComplianceDisplay — two rows, cadence-scaled windows", () => {
  const NOW = new Date("2025-06-15T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function ctx(
    overrides: Partial<ComplianceMedicationContext> = {},
  ): ComplianceMedicationContext {
    return buildComplianceMedicationContext(
      {
        startsOn: overrides.startsOn ?? null,
        endsOn: overrides.endsOn ?? null,
        oneShot: overrides.oneShot ?? false,
        // Created well before the windows so no day is excluded.
        createdAt: overrides.createdAt ?? new Date("2025-01-01T00:00:00Z"),
      },
      overrides.lastIntakeAt ?? null,
      overrides.timeZone ?? "UTC",
    );
  }

  it("echoes the density floor so a client can re-derive the rung", () => {
    const display = buildComplianceDisplay(
      [],
      [
        {
          windowStart: "08:00",
          windowEnd: "09:00",
          daysOfWeek: null,
          rrule: "FREQ=DAILY",
          timesOfDay: ["08:00"],
        },
      ],
      ctx(),
      { now: NOW },
    );
    expect(display.minStableDoses).toBe(MIN_STABLE_DOSES);
  });

  it("daily med → 7 / 30-day windows (the densest rung clears the floor)", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const display = buildComplianceDisplay([], schedules, ctx(), { now: NOW });
    expect(display.shortDays).toBe(7);
    expect(display.longDays).toBe(30);
    // Both windows hold ≥ 4 expected doses.
    expect(display.expectedShort).toBeGreaterThanOrEqual(MIN_STABLE_DOSES);
    expect(display.expectedLong).toBeGreaterThanOrEqual(MIN_STABLE_DOSES);
  });

  it("weekly med → steps up to 30 / 90-day windows", () => {
    // Weekly Mondays-only: the 7-day window holds at most one Monday (< 4),
    // so the ladder steps up. The 30-day window holds ~4 Mondays and the
    // 90-day window ~13 — the [30, 90] rung is the densest that clears the
    // floor on both rows.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        timesOfDay: ["08:00"],
      },
    ];
    const display = buildComplianceDisplay([], schedules, ctx(), { now: NOW });
    expect(display.shortDays).toBe(30);
    expect(display.longDays).toBe(90);
    expect(display.expectedShort).toBeGreaterThanOrEqual(MIN_STABLE_DOSES);
    expect(display.expectedLong).toBeGreaterThanOrEqual(MIN_STABLE_DOSES);
  });

  it("35-day rolling injection → widest 90 / 365-day windows", () => {
    // One dose every five weeks: the 30-day window never holds ≥ 4, so the
    // ladder climbs to the top rung where a full year holds ~10 doses.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "10:00",
        windowEnd: "11:00",
        daysOfWeek: null,
        rollingIntervalDays: 35,
        timesOfDay: ["10:00"],
      },
    ];
    const display = buildComplianceDisplay(
      [],
      schedules,
      ctx({
        startsOn: new Date("2024-06-01T00:00:00Z"),
        lastIntakeAt: new Date("2025-05-20T10:00:00Z"),
      }),
      { now: NOW },
    );
    expect(display.shortDays).toBe(90);
    expect(display.longDays).toBe(365);
  });

  it("a brand-new sparse med still returns two rows on the widest rung", () => {
    // Started two days ago: no rung clears the floor. The selection falls
    // back to the widest rung so the card still shows two honest rows.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 35,
        timesOfDay: ["08:00"],
      },
    ];
    const display = buildComplianceDisplay(
      [],
      schedules,
      ctx({ startsOn: new Date("2025-06-13T00:00:00Z") }),
      { now: NOW },
    );
    expect(display.shortDays).toBe(90);
    expect(display.longDays).toBe(365);
  });

  it("the row rates match calculateCompliance over the chosen windows", () => {
    // Daily med, perfect adherence over the trailing two weeks → 100% both
    // rows. Pins that the display rate equals the cadence-aware calculator.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const events = [];
    for (let d = 1; d <= 30; d++) {
      const at = new Date(NOW.getTime() - d * DAY_MS);
      at.setUTCHours(8, 10, 0, 0);
      events.push({ scheduledFor: at, takenAt: at, skipped: false });
    }
    const context = ctx();
    const display = buildComplianceDisplay(events, schedules, context, {
      now: NOW,
    });
    const short = calculateCompliance(
      events,
      schedules,
      display.shortDays,
      context.createdAt,
      { now: NOW, medicationContext: context },
    );
    const long = calculateCompliance(
      events,
      schedules,
      display.longDays,
      context.createdAt,
      { now: NOW, medicationContext: context },
    );
    expect(display.short.rate).toBe(short.rate);
    expect(display.long.rate).toBe(long.rate);
    expect(display.short.streak).toBe(short.streak);
  });

  it("never reports a timeline mode field — the display is two rows only", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const display = buildComplianceDisplay([], schedules, ctx(), { now: NOW });
    expect(display).not.toHaveProperty("mode");
    expect(display).not.toHaveProperty("doseTimeline");
    expect(display.short).toBeDefined();
    expect(display.long).toBeDefined();
  });

  it("7-day rolling injection with history → [30, 90] windows (not the widest fallback)", () => {
    // v1.13.x Fix 3B — after the retrospective rolling expansion,
    // `expectedSlotsBetween` returns the real per-cycle grid for rolling, so
    // a 7-day rolling injection with a faithful history clears the floor on
    // the [30, 90] rung instead of falling through to the widest [90, 365]
    // fallback (the pre-fix behaviour, where rolling emitted ≤ 1 slot).
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    // ~16 weekly shots back from a most-recent shot 3 days ago.
    const lastShot = new Date(NOW.getTime() - 3 * DAY_MS);
    const events = Array.from({ length: 16 }, (_, i) => {
      const at = new Date(lastShot.getTime() - i * 7 * DAY_MS);
      at.setUTCHours(20, 0, 0, 0);
      return { scheduledFor: at, takenAt: at, skipped: false };
    });
    const display = buildComplianceDisplay(
      events,
      schedules,
      ctx({
        startsOn: events[events.length - 1].takenAt,
        lastIntakeAt: events[0].takenAt,
      }),
      { now: NOW },
    );
    expect(display.shortDays).toBe(30);
    expect(display.longDays).toBe(90);
    expect(display.expectedShort).toBeGreaterThanOrEqual(MIN_STABLE_DOSES);
    expect(display.expectedLong).toBeGreaterThanOrEqual(MIN_STABLE_DOSES);
  });

  it("currentCycle — rolling weekly, last shot 3 days ago → on_track (not a red miss)", () => {
    // v1.13.x Fix 4 — a between-doses sparse med must NOT render a scary
    // state. Last shot 3 days ago → next due in 4 days → the open cycle is
    // on_track with a future nextDueAt.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    const lastShot = new Date(NOW.getTime() - 3 * DAY_MS);
    const events = [
      { scheduledFor: lastShot, takenAt: lastShot, skipped: false },
    ];
    const display = buildComplianceDisplay(
      events,
      schedules,
      ctx({ startsOn: lastShot, lastIntakeAt: lastShot }),
      { now: NOW },
    );
    expect(display.currentCycle.state).toBe("on_track");
    expect(display.currentCycle.nextDueAt).not.toBeNull();
    expect(display.currentCycle.nextDueAt!.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
    expect(display.currentCycle.hasClosedCycles).toBe(true);
  });

  it("currentCycle — taking the first of two close doses leaves the second due", () => {
    // 19:49 + 23:59 Berlin (CEST): 17:49Z + 21:59Z. The 19:49 take used to
    // resolve the 23:59 slot too (flat ±6 h radius), so the open cycle
    // pointed at tomorrow's 19:49 while tonight's dose was still due.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "19:49",
        windowEnd: "23:59",
        daysOfWeek: null,
        rollingIntervalDays: null,
        timesOfDay: ["19:49", "23:59"],
      },
    ];
    const slot = new Date("2025-06-15T17:49:00Z");
    const takenAt = new Date("2025-06-15T17:49:12Z");
    const events = [{ scheduledFor: slot, takenAt, skipped: false }];
    const display = buildComplianceDisplay(
      events,
      schedules,
      ctx({ lastIntakeAt: takenAt, timeZone: "Europe/Berlin" }),
      { now: new Date("2025-06-15T18:00:00Z") },
    );
    expect(display.currentCycle.state).toBe("on_track");
    expect(display.currentCycle.nextDueAt?.toISOString()).toBe(
      "2025-06-15T21:59:00.000Z",
    );
  });

  it("currentCycle — a row on sibling schedule A's 08:00 leaves sibling B's 12:00 due", () => {
    // Two schedule rows on one medication (08:00 daily plus 12:00 daily).
    // Berlin (CEST): 06:00Z + 10:00Z. The row carries no schedule identity;
    // B's slot must lose to A's nearer occurrence, not read resolved.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "08:00",
        daysOfWeek: null,
        rollingIntervalDays: null,
        timesOfDay: ["08:00"],
      },
      {
        windowStart: "12:00",
        windowEnd: "12:00",
        daysOfWeek: null,
        rollingIntervalDays: null,
        timesOfDay: ["12:00"],
      },
    ];
    const slot = new Date("2025-06-15T06:00:00Z");
    const takenAt = new Date("2025-06-15T06:03:00Z");
    const events = [{ scheduledFor: slot, takenAt, skipped: false }];
    const display = buildComplianceDisplay(
      events,
      schedules,
      ctx({ lastIntakeAt: takenAt, timeZone: "Europe/Berlin" }),
      { now: new Date("2025-06-15T07:00:00Z") },
    );
    expect(display.currentCycle.state).toBe("on_track");
    expect(display.currentCycle.nextDueAt?.toISOString()).toBe(
      "2025-06-15T10:00:00.000Z",
    );
  });

  it("currentCycle — rolling weekly overdue past grace → missed", () => {
    // v1.13.x Fix 4 — last shot ~10 days ago (cadence 7) → next due was 3
    // days ago, well past grace → the open cycle is `missed` (the only red
    // state). nextDueAt is in the past.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    const lastShot = new Date(NOW.getTime() - 10 * DAY_MS);
    const events = [
      { scheduledFor: lastShot, takenAt: lastShot, skipped: false },
    ];
    const display = buildComplianceDisplay(
      events,
      schedules,
      ctx({ startsOn: lastShot, lastIntakeAt: lastShot }),
      { now: NOW },
    );
    expect(display.currentCycle.state).toBe("missed");
    expect(display.currentCycle.nextDueAt).not.toBeNull();
    expect(display.currentCycle.nextDueAt!.getTime()).toBeLessThan(
      NOW.getTime(),
    );
  });

  it("currentDose — rolling weekly, last shot 3 days ago → upcoming (card stays calm)", () => {
    // v1.15.9 — the open dose's per-dose status drives the card's green /
    // overdue presentation. A weekly shot due in 4 days is well before the
    // ±1-day on-time window opens → `upcoming`, with the target echoed.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    const lastShot = new Date(NOW.getTime() - 3 * DAY_MS);
    const events = [
      { scheduledFor: lastShot, takenAt: lastShot, skipped: false },
    ];
    const display = buildComplianceDisplay(
      events,
      schedules,
      ctx({ startsOn: lastShot, lastIntakeAt: lastShot }),
      { now: NOW },
    );
    expect(display.currentDose.status).toBe("upcoming");
    expect(display.currentDose.targetAt).not.toBeNull();
    expect(display.currentDose.targetAt!.getTime()).toBe(
      display.currentCycle.nextDueAt!.getTime(),
    );
  });

  it("currentDose — weekly shot due now is on_time_window (green); long overdue is missed", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    // Last shot exactly 7 days ago → next due ~now → inside the ±1-day
    // on-time window → green.
    const dueNow = new Date(NOW.getTime() - 7 * DAY_MS);
    const dueNowDisplay = buildComplianceDisplay(
      [{ scheduledFor: dueNow, takenAt: dueNow, skipped: false }],
      schedules,
      ctx({ startsOn: dueNow, lastIntakeAt: dueNow }),
      { now: NOW },
    );
    expect(dueNowDisplay.currentDose.status).toBe("on_time_window");

    // Last shot 14 days ago → due ~7 days ago → past the 4-day overdue tail
    // → missed (the card escalates to "Stark überfällig").
    const longAgo = new Date(NOW.getTime() - 14 * DAY_MS);
    const missedDisplay = buildComplianceDisplay(
      [{ scheduledFor: longAgo, takenAt: longAgo, skipped: false }],
      schedules,
      ctx({ startsOn: longAgo, lastIntakeAt: longAgo }),
      { now: NOW },
    );
    expect(missedDisplay.currentDose.status).toBe("missed");
  });

  it("currentDose — twice-daily, both today's slots resolved → next open is tomorrow 07:00 (BUG 2)", () => {
    // v1.15.10 BUG 2 — afternoon, with today's 07:00 taken and today's 19:00
    // taken early. The open-dose search must skip both resolved slots and
    // surface tomorrow's 07:00 — the next genuinely-open slot — instead of
    // sticking on today's resolved 19:00.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "07:00",
        windowEnd: "19:00",
        daysOfWeek: null,
        timesOfDay: ["07:00", "19:00"],
      },
    ];
    // NOW = 2025-06-15T12:00:00Z (UTC ctx). Today's slots: 07:00Z + 19:00Z.
    const slot0700 = new Date("2025-06-15T07:00:00Z");
    const slot1900 = new Date("2025-06-15T19:00:00Z");
    const events = [
      // 07:00 dose logged on time.
      {
        scheduledFor: slot0700,
        takenAt: new Date("2025-06-15T07:05:00Z"),
        skipped: false,
      },
      // 19:00 dose logged EARLY (before its slot) — snapped onto the 19:00 row.
      {
        scheduledFor: slot1900,
        takenAt: new Date("2025-06-15T11:30:00Z"),
        skipped: false,
      },
    ];
    const display = buildComplianceDisplay(events, schedules, ctx(), {
      now: NOW,
    });
    expect(display.currentCycle.nextDueAt).not.toBeNull();
    // Next open slot is tomorrow 07:00 UTC, not today's resolved 19:00.
    expect(display.currentCycle.nextDueAt!.toISOString()).toBe(
      "2025-06-16T07:00:00.000Z",
    );
  });

  it("currentDose — twice-daily, only 07:00 resolved → next open is today 19:00 (BUG 2)", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "07:00",
        windowEnd: "19:00",
        daysOfWeek: null,
        timesOfDay: ["07:00", "19:00"],
      },
    ];
    const slot0700 = new Date("2025-06-15T07:00:00Z");
    const events = [
      {
        scheduledFor: slot0700,
        takenAt: new Date("2025-06-15T07:05:00Z"),
        skipped: false,
      },
    ];
    const display = buildComplianceDisplay(events, schedules, ctx(), {
      now: NOW,
    });
    expect(display.currentCycle.nextDueAt).not.toBeNull();
    // Today's 19:00 is still open.
    expect(display.currentCycle.nextDueAt!.toISOString()).toBe(
      "2025-06-15T19:00:00.000Z",
    );
  });

  it("currentCycle — brand-new sparse med with zero closed cycles → hasClosedCycles false", () => {
    // v1.13.x Fix 4 — a med created today with no logged intake has no
    // closed dose cycle; the percentage rows are vacuous and the card should
    // show a neutral state rather than a misleading 100% / 0%.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    const display = buildComplianceDisplay(
      [],
      schedules,
      ctx({
        startsOn: new Date(NOW.getTime() + 4 * DAY_MS), // first dose in the future
        createdAt: NOW,
      }),
      { now: NOW },
    );
    expect(display.currentCycle.hasClosedCycles).toBe(false);
    expect(display.currentCycle.state).toBe("on_track");
  });

  it("a 2-day-old daily med's expected counts reflect its real age", () => {
    // Created two days ago: the expected-dose counts must reflect ~2 days
    // of daily doses, not the 7 / 30 a full-window walk would report. No
    // rung clears the floor, so the selection falls back to the widest
    // rung while keeping the counts age-accurate.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const createdAt = new Date(NOW.getTime() - 2 * DAY_MS);
    const display = buildComplianceDisplay([], schedules, ctx({ createdAt }), {
      now: NOW,
    });
    // ~2 days of daily doses — nowhere near the 7 a 7-day window or the 30
    // a 30-day window would report before the createdAt clamp.
    expect(display.expectedShort).toBeLessThanOrEqual(3);
    expect(display.expectedLong).toBeLessThanOrEqual(3);
    // No rung clears the floor → widest windows still render two rows.
    expect(display.shortDays).toBe(90);
    expect(display.longDays).toBe(365);
  });

  // v1.15.8 — the card renders the taken-of-expected count next to each rate
  // so two identical percentages stay distinguishable. These pin the count
  // numerators onto the display block and guard against a future regression
  // where every window collapses to the same rate AND the same count (which
  // would read as a stuck display rather than a real, trustworthy number).
  it("carries a taken-dose count on each window row", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    // Daily med, perfect adherence over the trailing 30 days.
    const events = [];
    for (let d = 1; d <= 30; d++) {
      const at = new Date(NOW.getTime() - d * DAY_MS);
      at.setUTCHours(8, 10, 0, 0);
      events.push({ scheduledFor: at, takenAt: at, skipped: false });
    }
    const display = buildComplianceDisplay(events, schedules, ctx(), {
      now: NOW,
    });
    // Both rows ~100% — but the COUNTS differ (7-day window has fewer taken
    // doses than the 30-day window), so the two rows are distinguishable even
    // when the percentages are identical.
    expect(display.short.taken).toBeGreaterThan(0);
    expect(display.long.taken).toBeGreaterThan(0);
    expect(display.long.taken).toBeGreaterThan(display.short.taken);
    // The taken count never exceeds its window's expected denominator.
    expect(display.short.taken).toBeLessThanOrEqual(display.expectedShort);
    expect(display.long.taken).toBeLessThanOrEqual(display.expectedLong);
  });

  it("a daily med with misses concentrated outside the 7-day window → 7d ≠ 30d rate", () => {
    // Guards the "looks broken" report from the other direction: the windows
    // must NOT collapse to one value. A daily med taken every day inside the
    // last 7 days but with a cluster of misses in the 8–30-day range yields a
    // perfect short window and a degraded long window, so the two rows
    // genuinely differ.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const events = [];
    for (let d = 1; d <= 30; d++) {
      // Days 1–7: every dose taken. Days 10–20: missed (no event row).
      if (d >= 10 && d <= 20) continue;
      const at = new Date(NOW.getTime() - d * DAY_MS);
      at.setUTCHours(8, 10, 0, 0);
      events.push({ scheduledFor: at, takenAt: at, skipped: false });
    }
    const display = buildComplianceDisplay(events, schedules, ctx(), {
      now: NOW,
    });
    // Daily med stays on the 7 / 30-day rung.
    expect(display.shortDays).toBe(7);
    expect(display.longDays).toBe(30);
    // The recent week is clean; the month carries the 10–20-day miss cluster.
    // The windows MUST diverge — the short window outscores the long one,
    // which is the whole point of showing two rows rather than one number.
    expect(display.short.rate).toBeGreaterThan(display.long.rate);
    expect(display.long.rate).toBeLessThan(100);
    expect(display.short.rate).not.toBe(display.long.rate);
  });

  it("a rolling weekly med with a partial-adherence history → short and long rates CAN differ", () => {
    // The operator's "every window is 100%" suspicion is real ONLY for a
    // faithfully-on-cadence med; once doses are missed the windows MUST be
    // able to diverge. A weekly rolling injection with recent perfect weeks
    // but missed shots further back drives the short rate above the long rate
    // — proving the metric does not structurally collapse to one value.
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    const lastShot = new Date(NOW.getTime() - 3 * DAY_MS);
    // 16 weekly slots back; drop a cluster of older shots (weeks 8–12) so the
    // long window scores a real miss while the recent weeks stay perfect.
    const events = Array.from({ length: 16 }, (_, i) => i)
      .filter((i) => i < 6 || i > 11)
      .map((i) => {
        const at = new Date(lastShot.getTime() - i * 7 * DAY_MS);
        at.setUTCHours(20, 0, 0, 0);
        return { scheduledFor: at, takenAt: at, skipped: false };
      });
    const display = buildComplianceDisplay(
      events,
      schedules,
      ctx({
        startsOn: new Date(lastShot.getTime() - 15 * 7 * DAY_MS),
        lastIntakeAt: lastShot,
      }),
      { now: NOW },
    );
    // The windows are NOT forced equal: the recent short window outscores the
    // longer one that carries the dropped cluster.
    expect(display.short.rate).toBeGreaterThan(display.long.rate);
  });
});

describe("expectedSlotsBetween", () => {
  function ctx(
    overrides: Partial<ComplianceMedicationContext> = {},
  ): ComplianceMedicationContext {
    return buildComplianceMedicationContext(
      {
        startsOn: overrides.startsOn ?? null,
        endsOn: overrides.endsOn ?? null,
        oneShot: overrides.oneShot ?? false,
        createdAt: overrides.createdAt ?? new Date("2025-01-01T00:00:00Z"),
      },
      overrides.lastIntakeAt ?? null,
      overrides.timeZone ?? "UTC",
    );
  }

  it("returns the occurrences themselves, ascending by instant", () => {
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00", "20:00"],
      },
    ];
    const slots = expectedSlotsBetween(
      schedules,
      new Date("2025-06-09T00:00:00Z"),
      new Date("2025-06-10T23:59:59Z"),
      ctx(),
    );
    // Two days × two times = four slots, ascending.
    expect(slots.length).toBe(4);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].at.getTime()).toBeGreaterThanOrEqual(
        slots[i - 1].at.getTime(),
      );
    }
  });

  it("excludes PRN schedules from the expected slots", () => {
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
    const slots = expectedSlotsBetween(
      schedules,
      new Date("2025-06-09T00:00:00Z"),
      new Date("2025-06-12T00:00:00Z"),
      ctx(),
    );
    expect(slots.length).toBe(0);
  });

  it("clamps the window lower bound to createdAt for a young med", () => {
    // A daily med created two days before the window's upper bound: the
    // legacy weekday walker floors on `startsOn` (none here) but not on
    // `createdAt`, so without the clamp this 30-day window would count
    // ~30 days of pre-creation slots. With the clamp only the ~2 days the
    // med actually existed emit a slot.
    const to = new Date("2025-06-15T00:00:00Z");
    const from = new Date(to.getTime() - 30 * DAY_MS);
    const createdAt = new Date(to.getTime() - 2 * DAY_MS);
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const slots = expectedSlotsBetween(schedules, from, to, ctx({ createdAt }));
    // Daily cadence over ~2 days → at most 3 slots, never the ~30 a full
    // 30-day window would otherwise emit.
    expect(slots.length).toBeLessThanOrEqual(3);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    // Every emitted slot lands at or after the creation instant.
    for (const s of slots) {
      expect(s.at.getTime()).toBeGreaterThanOrEqual(createdAt.getTime());
    }
  });

  it("leaves the window untouched when createdAt predates it", () => {
    // createdAt well before `from` → the clamp is a no-op and the full
    // window's slots survive.
    const to = new Date("2025-06-15T00:00:00Z");
    const from = new Date(to.getTime() - 7 * DAY_MS);
    const schedules: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        rrule: "FREQ=DAILY",
        timesOfDay: ["08:00"],
      },
    ];
    const slots = expectedSlotsBetween(
      schedules,
      from,
      to,
      ctx({ createdAt: new Date("2025-01-01T00:00:00Z") }),
    );
    // A full week of daily doses → ~7 slots.
    expect(slots.length).toBeGreaterThanOrEqual(7);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.15.9 — forgotten doses count as MISSED (BUG #2) + user-skip vs
// auto-miss semantics (BUG #3). A never-acted dose the auto-miss cron
// flipped carries `autoMissed: true`; the engine must pair it to a
// `missed` slot (against the rate). A deliberate user skip
// (`skipped: true`) stays excluded from the denominator.
// ────────────────────────────────────────────────────────────────────

describe("calculateCompliance — autoMissed forgotten doses (BUG #2 / #3)", () => {
  const NOW = new Date("2025-01-15T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const daily: ComplianceSchedule[] = [
    { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
  ];

  it("a forgotten daily dose (autoMissed) lowers the rate — not neutralised", () => {
    // Three days: two taken + one forgotten (autoMissed). Before v1.15.9 the
    // auto-skip cron flipped the forgotten dose to skipped, which the engine
    // excluded → 2/2 = 100% (inflated). Now it is a real miss → 2/3 = 67%.
    const events = [
      eventAt(new Date("2025-01-14T08:30:00Z"), true),
      {
        scheduledFor: new Date("2025-01-13T08:30:00Z"),
        takenAt: null,
        skipped: false,
        autoMissed: true,
      },
      eventAt(new Date("2025-01-12T08:30:00Z"), true),
    ];
    const result = calculateCompliance(events, daily, 7);
    expect(result.taken).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.missed).toBeGreaterThanOrEqual(1);
    // The autoMissed day is inside the denominator and drags the rate below
    // the inflated 100% the old skip-neutralisation produced.
    expect(result.rate).toBeLessThan(100);
  });

  it("a deliberate user-skip is excluded; an auto-miss on the same day-grid counts (BUG #3)", () => {
    // One taken, one user-skip (excluded), one auto-miss (counted). The
    // user-skip must NOT appear in the denominator; the auto-miss must.
    const events = [
      eventAt(new Date("2025-01-14T08:30:00Z"), true),
      {
        scheduledFor: new Date("2025-01-13T08:30:00Z"),
        takenAt: null,
        skipped: true, // deliberate pause
        autoMissed: false,
      },
      {
        scheduledFor: new Date("2025-01-12T08:30:00Z"),
        takenAt: null,
        skipped: false,
        autoMissed: true, // forgotten
      },
    ];
    const result = calculateCompliance(events, daily, 7);
    expect(result.skipped).toBe(1);
    expect(result.taken).toBe(1);
    // Denominator = taken + missed (the user-skip is out). At least the
    // auto-miss counts, so the rate is taken/(taken+missed) < 100.
    expect(result.missed).toBeGreaterThanOrEqual(1);
    expect(result.rate).toBeLessThan(100);
    // The user-skip alone (no auto-miss) would have kept 100% — confirm the
    // auto-miss is what pulls it down by re-running with the skip only.
    // Cover every slot the 7-day window emits (today's 08:00 is past NOW =
    // 12:00, so the window holds Jan 9..15). Take all but one user-skip.
    const skipOnlyEvents = [];
    for (let day = 9; day <= 15; day++) {
      const at = new Date(`2025-01-${String(day).padStart(2, "0")}T08:30:00Z`);
      if (day === 13) {
        skipOnlyEvents.push({
          scheduledFor: at,
          takenAt: null,
          skipped: true,
          autoMissed: false,
        });
      } else {
        skipOnlyEvents.push(eventAt(at, true));
      }
    }
    const skipOnly = calculateCompliance(skipOnlyEvents, daily, 7);
    // Every non-skipped day taken → the deliberate skip never lowers the rate.
    expect(skipOnly.rate).toBe(100);
  });

  it("buildComplianceDisplay surfaces taken / expected / missed counts per row", () => {
    const events = [
      eventAt(new Date("2025-01-14T08:30:00Z"), true),
      {
        scheduledFor: new Date("2025-01-13T08:30:00Z"),
        takenAt: null,
        skipped: false,
        autoMissed: true,
      },
    ];
    const ctxVal = buildComplianceMedicationContext(
      {
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2025-01-08T00:00:00Z"),
      },
      lastNonSkippedTakenAt(events),
      "UTC",
    );
    const display = buildComplianceDisplay(events, daily, ctxVal, { now: NOW });
    // `expected` is the rate denominator (taken + missed), `missed` counts the
    // forgotten doses, `taken` the numerator — the "taken / expected" triple.
    expect(display.short.expected).toBe(
      display.short.taken + display.short.missed,
    );
    expect(display.short.missed).toBeGreaterThanOrEqual(1);
    expect(display.long.expected).toBe(
      display.long.taken + display.long.missed,
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.15.10 BUG 3 — verify the compliance % for an IRREGULAR twice-daily
// taker (07:00 + 19:00) who logs at off-times plus the odd ad-hoc dose.
// Pins the slot-pairing (an off-time morning take snaps to the 07:00 slot,
// an evening take to the 19:00 slot — ±6h half-gap for a 12h-gap med), the
// skip/missed/extra semantics, and the resulting rate = taken/(taken+missed).
// ────────────────────────────────────────────────────────────────────

describe("calculateCompliance — irregular twice-daily taker (BUG 3 verify)", () => {
  // Pin `now` so the 7-day window is deterministic.
  const NOW = new Date("2025-01-15T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Twice-daily: 07:00 + 19:00, every day. timesOfDay drives the two slots.
  const twiceDaily: ComplianceSchedule[] = [
    {
      windowStart: "07:00",
      windowEnd: "19:00",
      daysOfWeek: null,
      timesOfDay: ["07:00", "19:00"],
    },
  ];

  const ctxVal = buildComplianceMedicationContext(
    {
      startsOn: null,
      endsOn: null,
      oneShot: false,
      // Created well before the window so age never clamps the denominator.
      createdAt: new Date("2025-01-01T00:00:00Z"),
    },
    null,
    "UTC",
  );

  function slot(day: number, hhmm: "07:00" | "19:00"): Date {
    return new Date(`2025-01-${String(day).padStart(2, "0")}T${hhmm}:00Z`);
  }

  it("attributes two same-day takes to BOTH slots — a near-on-time morning take is taken_late, not orphaned", () => {
    // v1.15.18 — the band model attributes each take to its OWN slot. A
    // morning take at 08:13 (07:00 slot + 1h13m) is inside the 07:00 slot's
    // late tail (07:00 + 60min on-time + 180min tail → to 10:00), so it reads
    // taken_late and does NOT orphan the 07:00 slot onto the 19:00 row. The
    // evening 19:00 take is on-time. The crux of the original BUG-3 fix
    // survives the move off the ±6h snap: a same-day morning + evening take
    // never collapse into one taken + one falsely-missed.
    //
    // Cover EVERY slot the window emits so there is no stray uncovered slot:
    // a 3-day window (NOW − 3d = Jan-12 12:00 .. Jan-15 12:00) holds Jan-12
    // 19:00, Jan-13 07:00+19:00, Jan-14 07:00+19:00, Jan-15 07:00 = 6 slots.
    const onTime = (s: Date) => ({
      scheduledFor: s,
      takenAt: s,
      skipped: false,
    });
    const events = [
      onTime(slot(12, "19:00")),
      onTime(slot(13, "07:00")),
      onTime(slot(13, "19:00")),
      // 07:00 slot, logged at 08:13 (within the late tail → taken_late).
      {
        scheduledFor: slot(14, "07:00"),
        takenAt: new Date(
          slot(14, "07:00").getTime() + (1 * 60 + 13) * 60 * 1000,
        ),
        skipped: false,
      },
      onTime(slot(14, "19:00")),
      onTime(slot(15, "07:00")),
    ];
    const result = calculateCompliance(events, twiceDaily, 3, undefined, {
      now: NOW,
      medicationContext: ctxVal,
    });
    // Every slot is covered by its own take → no miss, 100%.
    expect(result.missed).toBe(0);
    expect(result.rate).toBe(100);
    expect(result.taken).toBe(6);
  });

  it("computes the rate as taken/(taken+missed) over a 7-day irregular pattern", () => {
    // Window: NOW − 7d = Jan 8 12:00 .. Jan 15 12:00. The slots that fall in
    // [start, now] (07:00 + 19:00 each day; Jan-8 19:00 only since 07:00 is
    // before 12:00; Jan-15 07:00 only since 19:00 is after now):
    //   Jan  8: 19:00                         → 1 slot
    //   Jan  9..14: 07:00 + 19:00             → 12 slots
    //   Jan 15: 07:00                         → 1 slot
    // = 14 expected slots.
    //
    // Pattern (mirrors the operator: irregular times + 2 real skips + 1
    // uncovered morning slot + a couple of ad-hoc extras that pair to no
    // slot):
    //   - Jan 8 19:00 : taken (logged 20:10, off-time)            → taken
    //   - Jan 9 07:00 : taken 09:13 (off-time morning)            → taken
    //   - Jan 9 19:00 : USER-SKIP                                 → skipped (excluded)
    //   - Jan 10 07:00: taken 06:40                               → taken
    //   - Jan 10 19:00: taken 21:30 (late)                        → taken
    //   - Jan 11 07:00: UNCOVERED (no intake, past cutoff)        → missed
    //   - Jan 11 19:00: taken 18:50                               → taken
    //   - Jan 12 07:00: taken 08:05                               → taken
    //   - Jan 12 19:00: taken 19:20                               → taken
    //   - Jan 13 07:00: USER-SKIP                                 → skipped (excluded)
    //   - Jan 13 19:00: taken 19:00                               → taken
    //   - Jan 14 07:00: taken 09:13 (off-time morning)            → taken
    //   - Jan 14 19:00: taken 19:00                               → taken
    //   - Jan 15 07:00: taken 07:30                               → taken
    // Plus two ad-hoc extras (no slot within ±6h) that must NOT touch the
    // denominator:
    //   - Jan 10 13:00 (a midday top-up, midpoint between both slots)
    //   - Jan 12 03:00 (a small-hours dose, > 6h from either slot)
    //
    // Hand count over the 14 slots:
    //   taken   = 11
    //   skipped = 2  (excluded)
    //   missed  = 1
    //   denom   = taken + missed = 12
    //   rate    = round(11/12 * 100) = round(91.67) = 92
    const mins = (h: number, m: number) => (h * 60 + m) * 60 * 1000;
    const takeAt = (s: Date, h: number, m: number) =>
      new Date(new Date(s).setUTCHours(0, 0, 0, 0) + mins(h, m));
    const taken = (s: Date, h: number, m: number) => ({
      scheduledFor: s,
      takenAt: takeAt(s, h, m),
      skipped: false,
    });
    const userSkip = (s: Date) => ({
      scheduledFor: s,
      takenAt: null,
      skipped: true,
      autoMissed: false,
    });
    const autoMiss = (s: Date) => ({
      scheduledFor: s,
      takenAt: null,
      skipped: false,
      autoMissed: true,
    });
    const extra = (s: Date) => ({
      scheduledFor: s,
      takenAt: s,
      skipped: false,
    });

    const events = [
      taken(slot(8, "19:00"), 20, 10),
      taken(slot(9, "07:00"), 9, 13),
      userSkip(slot(9, "19:00")),
      taken(slot(10, "07:00"), 6, 40),
      taken(slot(10, "19:00"), 21, 30),
      autoMiss(slot(11, "07:00")),
      taken(slot(11, "19:00"), 18, 50),
      taken(slot(12, "07:00"), 8, 5),
      taken(slot(12, "19:00"), 19, 20),
      userSkip(slot(13, "07:00")),
      taken(slot(13, "19:00"), 19, 0),
      taken(slot(14, "07:00"), 9, 13),
      taken(slot(14, "19:00"), 19, 0),
      taken(slot(15, "07:00"), 7, 30),
      // ad-hoc extras (must not enter the denominator)
      extra(new Date("2025-01-10T13:00:00Z")),
      extra(new Date("2025-01-12T03:00:00Z")),
    ];

    const result = calculateCompliance(events, twiceDaily, 7, undefined, {
      now: NOW,
      medicationContext: ctxVal,
    });

    // The denominator counts only taken + missed (the two user-skips + the
    // two ad-hoc extras are excluded). With the v1.15.10 exact-anchor pairing
    // every off-time take lands on its OWN slot — the two user-skips read as
    // skipped (not taken), the late evening take reads as taken (not missed).
    expect(result.taken).toBe(11);
    expect(result.skipped).toBe(2);
    expect(result.missed).toBe(1);
    // rate = taken / (taken + missed) = 11/12 = 92% — the honest arithmetic.
    expect(result.rate).toBe(
      Math.round((result.taken / (result.taken + result.missed)) * 100),
    );
    expect(result.rate).toBe(92);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.15.9 — cadence-aware per-dose grace/miss window model. The card
// reads `deriveDoseStatus` to render on-time / overdue / missed states.
// ────────────────────────────────────────────────────────────────────

describe("deriveDoseStatus — daily / intraday windows", () => {
  const target = new Date("2025-01-15T08:00:00Z");

  it("on-time within ±60 min of target", () => {
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T08:30:00Z")),
    ).toBe("on_time_window");
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T07:15:00Z")),
    ).toBe("on_time_window");
  });

  it("upcoming before the on-time window opens", () => {
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T06:30:00Z")),
    ).toBe("upcoming");
  });

  it("overdue between +60 min and +240 min", () => {
    // +90 min → past on-time (60), before miss cutoff (240).
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T09:30:00Z")),
    ).toBe("overdue");
    // +239 min → still overdue (takeable).
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T11:59:00Z")),
    ).toBe("overdue");
  });

  it("missed past +240 min", () => {
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T12:30:00Z")),
    ).toBe("missed");
  });

  it("never overlaps the next dose's on-time window", () => {
    // Next dose at 10:00; its on-time window opens at 09:00 (−60 min). The
    // 08:00 dose's miss cutoff is therefore clamped to 09:00, well before its
    // own +240 min (12:00). At 09:30 the 08:00 dose is already missed.
    const nextDoseAt = new Date("2025-01-15T10:00:00Z");
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T09:30:00Z"), {
        nextDoseAt,
      }),
    ).toBe("missed");
  });

  it("taken inside the on-time window → taken_on_time, late → taken_late", () => {
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T20:00:00Z"), {
        takenAt: new Date("2025-01-15T08:30:00Z"),
      }),
    ).toBe("taken_on_time");
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T20:00:00Z"), {
        takenAt: new Date("2025-01-15T10:00:00Z"),
      }),
    ).toBe("taken_late");
  });

  it("a deliberate skip short-circuits to skipped", () => {
    expect(
      deriveDoseStatus(target, "daily", new Date("2025-01-15T20:00:00Z"), {
        skipped: true,
      }),
    ).toBe("skipped");
  });
});

describe("deriveDoseStatus — weekly GLP-1 (4-day rule)", () => {
  const target = new Date("2025-01-13T08:00:00Z"); // a Monday shot

  it("on-time within ±1 day of the target day", () => {
    expect(
      deriveDoseStatus(target, "weekly", new Date("2025-01-13T20:00:00Z")),
    ).toBe("on_time_window");
    expect(
      deriveDoseStatus(target, "weekly", new Date("2025-01-14T07:00:00Z")),
    ).toBe("on_time_window");
  });

  it("overdue up to +4 days (still counts when taken — the clinical rule)", () => {
    // +3 days from target → past the ±1-day on-time window, before +4 days.
    expect(
      deriveDoseStatus(target, "weekly", new Date("2025-01-16T12:00:00Z")),
    ).toBe("overdue");
    // Taken on day +3 still counts as late, not missed.
    expect(
      deriveDoseStatus(target, "weekly", new Date("2025-01-20T00:00:00Z"), {
        takenAt: new Date("2025-01-16T12:00:00Z"),
      }),
    ).toBe("taken_late");
  });

  it("missed past +4 days", () => {
    expect(
      deriveDoseStatus(target, "weekly", new Date("2025-01-18T12:00:00Z")),
    ).toBe("missed");
  });

  it("defaults match the documented 60-min / 240-min / 4-day boundaries", () => {
    expect(DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes).toBe(60);
    expect(
      DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes +
        DOSE_WINDOW_DEFAULTS.dailyOverdueMinutes,
    ).toBe(240);
    expect(DOSE_WINDOW_DEFAULTS.weeklyOverdueDays).toBe(4);
  });
});

describe("doseCadenceFamily", () => {
  it("rolling ≥ 2 days → weekly", () => {
    expect(
      doseCadenceFamily({
        windowStart: "08:00",
        windowEnd: "09:00",
        rollingIntervalDays: 7,
      }),
    ).toBe("weekly");
  });
  it("WEEKLY rrule → weekly", () => {
    expect(
      doseCadenceFamily({
        windowStart: "08:00",
        windowEnd: "09:00",
        rrule: "FREQ=WEEKLY;BYDAY=MO",
      }),
    ).toBe("weekly");
  });
  it("daily rrule → daily", () => {
    expect(
      doseCadenceFamily({
        windowStart: "08:00",
        windowEnd: "09:00",
        rrule: "FREQ=DAILY",
      }),
    ).toBe("daily");
  });
  it("plain legacy daily → daily", () => {
    expect(
      doseCadenceFamily({
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
      }),
    ).toBe("daily");
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.15.18 — the UNIFIED ledger tally. `tallyComplianceFromLedger` is the
// ONE authority behind the compliance %: it builds the cadence-aware bands
// per schedule, reconstructs the dose-history ledger, and tallies it so the
// % and the history view can never contradict. These tests pin the
// taking-vs-timing split, the exclusions (skip / ad-hoc / upcoming / PRN),
// auto-missed=missed, and the cross-consistency invariant that the SAME
// intake can't be "taken" in the % while the ledger calls it "ad_hoc".
// ────────────────────────────────────────────────────────────────────

import { localHmAsUtc } from "@/lib/tz/local-day";
import {
  buildBandsForSchedules,
  type BandMinterMedication,
} from "@/lib/medications/scheduling/band-minter";
import {
  reconstructDoseHistory,
  type HistoryIntake,
} from "@/lib/medications/scheduling/dose-history";
import type {
  CanonicalSchedule,
  RecurrenceContext,
} from "@/lib/medications/scheduling/recurrence";

describe("tallyComplianceFromLedger — the unified % keystone", () => {
  const TZ = "Europe/Berlin";
  const dayRef = new Date("2026-06-08T12:00:00Z");
  function at(h: number, m: number): Date {
    return localHmAsUtc(dayRef, TZ, h, m);
  }
  function ctxFor(
    over: Partial<ComplianceMedicationContext> = {},
  ): ComplianceMedicationContext {
    return {
      startsOn: new Date("2026-06-01T00:00:00Z"),
      endsOn: null,
      oneShot: false,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      lastIntakeAt: null,
      timeZone: TZ,
      ...over,
    };
  }
  // Twice-daily 07:00 / 19:00, single window covering the whole day.
  const twiceDaily: ComplianceSchedule[] = [
    {
      windowStart: "07:00",
      windowEnd: "19:00",
      daysOfWeek: null,
      timesOfDay: ["07:00", "19:00"],
    },
  ];
  // Late evening "now" so both of the reference day's slots are past cutoff.
  const nowEvening = at(23, 59);
  // Window covers just the reference day.
  const from = at(0, 0);

  it("a late take counts as taken (taking adherence), with the timing split exposed", () => {
    // 07:00 on-time + 19:00 logged at 20:30 (inside the 180min late tail).
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(7, 0), skipped: false },
      { scheduledFor: at(19, 0), takenAt: at(20, 30), skipped: false },
    ];
    const tally = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(tally.taken).toBe(2);
    expect(tally.takenOnTime).toBe(1);
    expect(tally.takenLate).toBe(1);
    expect(tally.missed).toBe(0);
    expect(tally.rate).toBe(100);
  });

  it("a deliberate user-skip is EXCLUDED from the denominator", () => {
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(7, 0), skipped: false },
      { scheduledFor: at(19, 0), takenAt: null, skipped: true },
    ];
    const tally = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(tally.taken).toBe(1);
    expect(tally.skipped).toBe(1);
    expect(tally.missed).toBe(0);
    expect(tally.denominator).toBe(1); // taken + missed, skip excluded
    expect(tally.rate).toBe(100);
  });

  // v1.15.20 — a USER_PIN take binds by its slot anchor, so a deliberate
  // "diesem Slot zuordnen" on an off-window take serves the slot as a LATE
  // dose: it enters the numerator (taken), never the on-time count, and the
  // slot stops reading missed. The same instants WITHOUT the pin read
  // ad-hoc + missed — the pin is the only thing that may move them.
  it("a pinned off-window take serves its slot as late — no on-time gain", () => {
    const pinned = [
      {
        scheduledFor: at(7, 0),
        takenAt: at(13, 0), // far past the 07:00 band's tail
        skipped: false,
        attributionSource: "USER_PIN" as const,
      },
      { scheduledFor: at(19, 0), takenAt: at(19, 0), skipped: false },
    ];
    const tally = tallyComplianceFromLedger(
      pinned,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(tally.taken).toBe(2);
    expect(tally.takenOnTime).toBe(1); // only the 19:00 dose
    expect(tally.takenLate).toBe(1); // the pin counts late, never on-time
    expect(tally.missed).toBe(0);
    expect(tally.adHoc).toBe(0);
    expect(tally.rate).toBe(100);

    // Control: the identical instants without the pin stay ad-hoc and the
    // 07:00 slot reads missed — AUTO attribution is untouched.
    const unpinned = pinned.map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
    }));
    const auto = tallyComplianceFromLedger(
      unpinned,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(auto.taken).toBe(1);
    expect(auto.takenLate).toBe(0);
    expect(auto.missed).toBe(1);
    expect(auto.adHoc).toBe(1);
    expect(auto.rate).toBe(50);
  });

  // v1.15.19 — intraday pending rows. The today-projector mints pending
  // rows (takenAt = null, not skipped, not auto-missed) for every slot of
  // the day up front; from slot time onward the old ledger read them as
  // missed, so the rate dipped intraday although the dose was still inside
  // its overdue window.
  it("a pending row inside its overdue window reads upcoming — the intraday rate holds", () => {
    // 07:00 taken; the 19:00 pending row was minted up front. At 20:00 the
    // evening dose is still takeable (the late tail runs to 23:00), so it
    // stays out of the denominator and the rate holds at 100, not 50.
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(7, 0), skipped: false },
      { scheduledFor: at(19, 0), takenAt: null, skipped: false },
    ];
    const tally = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      at(23, 59),
      at(20, 0),
    );
    expect(tally.taken).toBe(1);
    expect(tally.missed).toBe(0);
    expect(tally.denominator).toBe(1);
    expect(tally.rate).toBe(100);
  });

  it("a pending row past its overdueEnd IS a miss", () => {
    // Same shape, but read at 23:59 — the 19:00 dose's tail has closed.
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(7, 0), skipped: false },
      { scheduledFor: at(19, 0), takenAt: null, skipped: false },
    ];
    const tally = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(tally.taken).toBe(1);
    expect(tally.missed).toBe(1);
    expect(tally.rate).toBe(50);
  });

  it("a pending row whose slot lies outside `to = now` never becomes a phantom ad-hoc", () => {
    // The history view asks with `to = now`. The 19:00 band is not minted
    // at 14:00, but the projector already wrote the evening pending row —
    // it must be dropped, not surfaced as an ad-hoc row with takenAt=null.
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(7, 0), skipped: false },
      { scheduledFor: at(19, 0), takenAt: null, skipped: false },
    ];
    const nowAfternoon = at(14, 0);
    const tally = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      nowAfternoon,
      nowAfternoon,
    );
    expect(tally.adHoc).toBe(0);
    expect(tally.taken).toBe(1);
    expect(tally.missed).toBe(0);
    expect(tally.rate).toBe(100);
  });

  it("an auto-missed forgotten dose IS a miss (counts against the rate)", () => {
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(7, 0), skipped: false },
      {
        scheduledFor: at(19, 0),
        takenAt: null,
        skipped: false,
        autoMissed: true,
      },
    ];
    const tally = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(tally.taken).toBe(1);
    expect(tally.missed).toBe(1);
    expect(tally.skipped).toBe(0);
    expect(tally.rate).toBe(50);
  });

  it("an off-schedule (ad-hoc) take is EXCLUDED + leaves its slot missed", () => {
    // The maintainer's case: 07:00 dose logged at 11:29 → outside the band → ad-hoc;
    // the 07:00 slot is missed; the 19:00 slot is also missed (untouched).
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(11, 29), skipped: false },
    ];
    const tally = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(tally.adHoc).toBe(1);
    // The ad-hoc take is NOT in taken; both slots are missed.
    expect(tally.taken).toBe(0);
    expect(tally.missed).toBe(2);
    // Denominator = taken + missed; ad-hoc never enters it.
    expect(tally.denominator).toBe(2);
    expect(tally.rate).toBe(0);
  });

  it("a future slot is upcoming — excluded, never a premature miss", () => {
    // Early morning now: both slots still ahead of their miss cutoff.
    const earlyNow = at(5, 0);
    const tally = tallyComplianceFromLedger(
      [],
      twiceDaily,
      ctxFor(),
      from,
      earlyNow,
      earlyNow,
    );
    expect(tally.taken).toBe(0);
    expect(tally.missed).toBe(0);
    expect(tally.denominator).toBe(0);
    expect(tally.rate).toBe(100); // empty-window contract
  });

  it("a PRN schedule contributes NO denominator (every intake excluded)", () => {
    const prn: ComplianceSchedule[] = [
      {
        windowStart: "07:00",
        windowEnd: "19:00",
        daysOfWeek: null,
        timesOfDay: ["07:00"],
        scheduleType: "PRN",
      },
    ];
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(7, 0), skipped: false },
      { scheduledFor: at(14, 0), takenAt: at(14, 0), skipped: false },
    ];
    const tally = tallyComplianceFromLedger(
      events,
      prn,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    // PRN → hasExpectedSlots false → no bands → every take ad-hoc, no slots.
    expect(tally.taken).toBe(0);
    expect(tally.missed).toBe(0);
    expect(tally.adHoc).toBe(2);
    expect(tally.denominator).toBe(0);
    expect(tally.rate).toBe(100);
  });

  it("the rate is capped at 100% (extra doses never inflate it)", () => {
    // Both slots taken + an ad-hoc extra. Ad-hoc is excluded so the rate is a
    // clean 100, never >100.
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(7, 0), skipped: false },
      { scheduledFor: at(19, 0), takenAt: at(19, 0), skipped: false },
      { scheduledFor: at(13, 0), takenAt: at(13, 0), skipped: false }, // extra
    ];
    const tally = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(tally.taken).toBe(2);
    expect(tally.adHoc).toBe(1);
    expect(tally.rate).toBe(100);
  });

  it("CROSS-CONSISTENCY: the same intake cannot be taken in the % and ad_hoc in the ledger", () => {
    // The keystone invariant. Build the exact bands the tally builds, run the
    // SAME reconstructDoseHistory, and assert the tally's per-status counts
    // equal the ledger's per-status counts — so a dose graded "taken" by the %
    // is a "taken_*" row in the history view, and an "ad_hoc" row never leaks
    // into the taken numerator.
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(7, 0), skipped: false }, // on-time
      { scheduledFor: at(19, 0), takenAt: at(20, 30), skipped: false }, // late
      { scheduledFor: at(7, 0), takenAt: at(11, 29), skipped: false }, // ad-hoc
    ];
    const tally = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );

    // Re-derive the ledger independently the same way the tally does.
    const medication: BandMinterMedication = {
      id: "x",
      startsOn: ctxFor().startsOn,
      endsOn: null,
      oneShot: false,
      createdAt: ctxFor().createdAt,
    };
    const recurrenceCtx: RecurrenceContext = {
      medication: {
        id: "x",
        startsOn: ctxFor().startsOn,
        endsOn: null,
        oneShot: false,
        createdAt: ctxFor().createdAt,
      },
      timeZone: TZ,
      lastIntakeAt: null,
    };
    const canonical: CanonicalSchedule = {
      id: "s",
      rrule: null,
      rollingIntervalDays: null,
      timesOfDay: ["07:00", "19:00"],
      daysOfWeek: null,
      windowStart: "07:00",
      windowEnd: "19:00",
      reminderGraceMinutes: null,
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
    };
    const groups = buildBandsForSchedules({
      medication,
      schedules: [canonical],
      ctx: recurrenceCtx,
      userTz: TZ,
      range: { from, to: nowEvening },
      now: nowEvening,
      intakeInstants: events
        .filter((e) => !e.skipped && e.takenAt)
        .map((e) => e.takenAt as Date),
    });
    const bands = groups.flatMap((g) => (g.hasExpectedSlots ? g.bands : []));
    const intakes: HistoryIntake[] = events.map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: false,
    }));
    const rows = reconstructDoseHistory(bands, intakes, nowEvening);

    const fromLedger = {
      onTime: rows.filter((r) => r.status === "taken_on_time").length,
      late: rows.filter((r) => r.status === "taken_late").length,
      missed: rows.filter((r) => r.status === "missed").length,
      adHoc: rows.filter((r) => r.status === "ad_hoc").length,
    };
    expect(tally.takenOnTime).toBe(fromLedger.onTime);
    expect(tally.takenLate).toBe(fromLedger.late);
    expect(tally.missed).toBe(fromLedger.missed);
    expect(tally.adHoc).toBe(fromLedger.adHoc);
    // And the load-bearing claim: the ad-hoc take is NOT counted as taken.
    expect(tally.taken).toBe(fromLedger.onTime + fromLedger.late);
    expect(tally.adHoc).toBe(1);
  });

  it("rolling weekly (GLP-1) — each logged shot is a taken slot (retrospective family)", () => {
    const rolling: ComplianceSchedule[] = [
      {
        windowStart: "08:00",
        windowEnd: "08:00",
        daysOfWeek: null,
        rollingIntervalDays: 7,
        timesOfDay: ["08:00"],
      },
    ];
    const shot1 = new Date("2026-05-04T09:12:00Z");
    const shot2 = new Date("2026-05-11T18:40:00Z");
    const shot3 = new Date("2026-05-18T07:55:00Z");
    const now = new Date("2026-05-20T12:00:00Z");
    const events = [shot1, shot2, shot3].map((d) => ({
      scheduledFor: d,
      takenAt: d,
      skipped: false,
    }));
    const tally = tallyComplianceFromLedger(
      events,
      rolling,
      ctxFor({
        startsOn: new Date("2026-05-01T00:00:00Z"),
        createdAt: new Date("2026-05-01T00:00:00Z"),
        lastIntakeAt: shot3,
      }),
      new Date("2026-05-01T00:00:00Z"),
      now,
      now,
    );
    // Each irregular shot anchors its own retrospective band → all taken.
    expect(tally.taken).toBeGreaterThanOrEqual(3);
    expect(tally.rate).toBeGreaterThanOrEqual(90);
  });

  // v1.15.18 W7 — the persisted per-dose window reaches the % through the
  // SAME minter the history view + write path use. An 11:29 take that the
  // default ±1h leaves ad-hoc (slot missed) is counted on-time once the
  // morning slot carries an explicit 07:00–12:00 window.
  it("the persisted doseWindows widens the on-time band feeding the %", () => {
    const events = [
      { scheduledFor: at(7, 0), takenAt: at(11, 29), skipped: false },
      { scheduledFor: at(19, 0), takenAt: at(19, 0), skipped: false },
    ];
    // DEFAULT (no doseWindows): 11:29 is past the 11:00 cutoff → ad-hoc,
    // morning slot missed.
    const dflt = tallyComplianceFromLedger(
      events,
      twiceDaily,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(dflt.missed).toBe(1);
    expect(dflt.adHoc).toBe(1);

    // WITH the persisted 07:00–12:00 window: 11:29 lands on-time, nothing
    // missed, nothing orphaned.
    const windowed: ComplianceSchedule[] = [
      {
        windowStart: "07:00",
        windowEnd: "19:00",
        daysOfWeek: null,
        timesOfDay: ["07:00", "19:00"],
        doseWindows: [{ timeOfDay: "07:00", start: "07:00", end: "12:00" }],
      },
    ];
    const wt = tallyComplianceFromLedger(
      events,
      windowed,
      ctxFor(),
      from,
      nowEvening,
      nowEvening,
    );
    expect(wt.missed).toBe(0);
    expect(wt.adHoc).toBe(0);
    expect(wt.takenOnTime).toBe(2);
    expect(wt.rate).toBe(100);
  });
});
