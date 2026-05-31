/**
 * v1.5.0 — canonical recurrence engine tests.
 *
 * Covers every cell of the edge-case matrix in
 * `.planning/medication-scheduling-2026-05-28/B-design-synthesis.md`:
 *   - DAILY / weekday-subset / multi-week / monthly / quarterly /
 *     yearly RRULE expansion
 *   - rolling cadence (`rollingIntervalDays`)
 *   - one-shot medication
 *   - DST spring-forward + cross-timezone time-of-day application
 *   - legacy fallback through `parseScheduleRecurrence`, INCLUDING the
 *     `intervalWeeks > 1` fix the legacy worker silently dropped
 *   - `endsOn` cap
 *   - empty `timesOfDay` falls back to `[windowStart]`
 *
 * The DST pin: 02:30 in Europe/Berlin on the 2026-03-29 spring-forward
 * day is a non-existent local time. The two-pass solver in
 * `applyTimeOfDayToDate` resolves it by forwarding to 03:30 wall-clock
 * (= 01:30 UTC). This is the chosen behaviour — see the test below.
 */

import { describe, expect, it } from "vitest";

import {
  matchesInstant,
  nextOccurrenceAfter,
  occurrencesBetween,
  type CanonicalSchedule,
  type RecurrenceContext,
} from "../recurrence";

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

function makeSchedule(
  overrides: Partial<CanonicalSchedule> = {},
): CanonicalSchedule {
  return {
    id: "sched-1",
    rrule: null,
    rollingIntervalDays: null,
    timesOfDay: [],
    daysOfWeek: null,
    windowStart: "08:00",
    windowEnd: "09:00",
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    ...overrides,
  };
}

interface CtxOverrides {
  timeZone?: string;
  lastIntakeAt?: Date | null;
  medication?: Partial<RecurrenceContext["medication"]>;
}

function makeCtx(overrides: CtxOverrides = {}): RecurrenceContext {
  const { medication: medOverrides = {}, ...rest } = overrides;
  return {
    timeZone: "Europe/Berlin",
    lastIntakeAt: null,
    ...rest,
    medication: {
      id: "med-1",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      ...medOverrides,
    },
  };
}

function d(iso: string): Date {
  return new Date(iso);
}

// ────────────────────────────────────────────────────────────────────
// RRULE — DAILY
// ────────────────────────────────────────────────────────────────────

describe("occurrencesBetween — RRULE DAILY", () => {
  it("emits 7 occurrences over a 7-day window with one time-of-day", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-07T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(7);
  });

  it("emits 14 occurrences over a 7-day window with two times-of-day", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00", "20:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-07T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(14);
    const morningCount = slots.filter((s) => s.timeOfDay === "08:00").length;
    const eveningCount = slots.filter((s) => s.timeOfDay === "20:00").length;
    expect(morningCount).toBe(7);
    expect(eveningCount).toBe(7);
  });
});

// ────────────────────────────────────────────────────────────────────
// RRULE — WEEKLY
// ────────────────────────────────────────────────────────────────────

describe("occurrencesBetween — RRULE WEEKLY", () => {
  it("FREQ=WEEKLY;BYDAY=MO,WE,FR over 14 days emits 6 occurrences", () => {
    // 2026-06-01 is a Monday. Mon/Wed/Fri across Jun 01..Jun 14:
    //   Jun 01 (Mo), 03 (We), 05 (Fr), 08 (Mo), 10 (We), 12 (Fr) = 6.
    const schedule = makeSchedule({
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-14T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(6);
  });

  it("bi-weekly Wed anchored on a Wed emits Wed today + Wed in 2 weeks", () => {
    // 2026-06-03 (Wed) is the anchor. Within Jun 03..Jun 30:
    //   Wednesdays: 03, 10, 17, 24
    //   Bi-weekly from anchor 03 → 03, 17 (skip 10, 24).
    const schedule = makeSchedule({
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-03T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-03T00:00:00Z"),
      d("2026-06-30T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(2);
    // The matching Wednesdays land on 03 + 17 in Berlin local time.
    const localDays = slots.map((s) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(s.at),
    );
    expect(localDays).toEqual(["2026-06-03", "2026-06-17"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// RRULE — MONTHLY / QUARTERLY / YEARLY
// ────────────────────────────────────────────────────────────────────

describe("occurrencesBetween — RRULE MONTHLY / YEARLY", () => {
  it("FREQ=MONTHLY;BYMONTHDAY=1 over Feb-Mar-Apr emits 3 occurrences", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-02-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-02-01T00:00:00Z"),
      d("2026-04-30T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(3);
  });

  it("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15 over Jan..Sep emits 3", () => {
    // Quarterly, anchor Jan 15. Within Jan 01..Sep 30 (9 months):
    //   Jan 15, Apr 15, Jul 15. (Oct 15 is past Sep 30.)
    const schedule = makeSchedule({
      rrule: "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-01-15T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-01-01T00:00:00Z"),
      d("2026-09-30T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(3);
  });

  it("FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1 over 24 months emits 2", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-01-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-01-01T00:00:00Z"),
      d("2027-12-31T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// Rolling
// ────────────────────────────────────────────────────────────────────

describe("occurrencesBetween — rolling", () => {
  it("rollingIntervalDays=7 + lastIntakeAt=T-3d emits one at T+4d", () => {
    const NOW = d("2026-06-10T12:00:00Z");
    const lastIntake = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const schedule = makeSchedule({
      rollingIntervalDays: 7,
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      lastIntakeAt: lastIntake,
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const from = NOW;
    const to = new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000);
    const slots = occurrencesBetween(schedule, from, to, ctx);
    expect(slots).toHaveLength(1);
    // T+4d = 4 days after NOW. lastIntake + 7d.
    const expectedDay = new Date(
      lastIntake.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    // Same local-day-in-Berlin.
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(slots[0].at),
    ).toBe(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(expectedDay),
    );
  });

  it("rollingIntervalDays=7 + lastIntakeAt=null + startsOn=T-2d emits one at T+5d", () => {
    const NOW = d("2026-06-10T12:00:00Z");
    const startsOn = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const schedule = makeSchedule({
      rollingIntervalDays: 7,
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      lastIntakeAt: null,
      medication: { startsOn },
    });
    const from = NOW;
    const to = new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000);
    const slots = occurrencesBetween(schedule, from, to, ctx);
    expect(slots).toHaveLength(1);
    const expectedDay = new Date(startsOn.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(slots[0].at),
    ).toBe(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(expectedDay),
    );
  });

  it("rolling terminates when endsOn falls before next-due", () => {
    const NOW = d("2026-06-10T12:00:00Z");
    const lastIntake = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const endsOn = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const schedule = makeSchedule({
      rollingIntervalDays: 7,
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      lastIntakeAt: lastIntake,
      medication: { endsOn },
    });
    const slots = occurrencesBetween(
      schedule,
      NOW,
      new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000),
      ctx,
    );
    expect(slots).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// One-shot
// ────────────────────────────────────────────────────────────────────

describe("occurrencesBetween — one-shot", () => {
  it("emits one occurrence at startsOn + timesOfDay", () => {
    const NOW = d("2026-06-10T00:00:00Z");
    const startsOn = new Date(NOW.getTime() + 1 * 24 * 60 * 60 * 1000);
    const schedule = makeSchedule({ timesOfDay: ["10:00"] });
    const ctx = makeCtx({
      medication: {
        oneShot: true,
        startsOn,
      },
    });
    const slots = occurrencesBetween(
      schedule,
      NOW,
      new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
      ctx,
    );
    expect(slots).toHaveLength(1);
    // 10:00 Berlin on T+1d (2026-06-11).
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(slots[0].at),
    ).toContain("2026-06-11");
    expect(slots[0].timeOfDay).toBe("10:00");
  });

  it("emits the occurrence even when startsOn is past — caller checks lastIntakeAt", () => {
    const startsOn = d("2026-05-01T00:00:00Z");
    const schedule = makeSchedule({ timesOfDay: ["10:00"] });
    const ctx = makeCtx({
      medication: {
        oneShot: true,
        startsOn,
      },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-04-01T00:00:00Z"),
      d("2026-06-01T00:00:00Z"),
      ctx,
    );
    expect(slots).toHaveLength(1);
  });

  it("nextOccurrenceAfter returns null past the one-shot date", () => {
    const startsOn = d("2026-05-01T00:00:00Z");
    const schedule = makeSchedule({ timesOfDay: ["10:00"] });
    const ctx = makeCtx({
      medication: {
        oneShot: true,
        startsOn,
      },
    });
    const next = nextOccurrenceAfter(schedule, d("2026-06-01T00:00:00Z"), ctx);
    expect(next).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// DST + cross-TZ
// ────────────────────────────────────────────────────────────────────

describe("DST and cross-timezone time-of-day application", () => {
  it("02:30 wall-clock on the Berlin spring-forward day forwards to 03:30 (= 01:30 UTC)", () => {
    // 2026-03-29 is the European DST spring-forward day. Clocks jump
    // from 02:00 → 03:00 CET; 02:30 is a non-existent local time. The
    // two-pass solver in `applyTimeOfDayToDate` resolves the
    // non-existent time by forwarding to 03:30 wall-clock (the next
    // valid local minute), which equals 01:30 UTC.
    //
    // CHOSEN BEHAVIOUR: forward-jump (NOT skip). This matches macOS
    // Calendar / iOS Calendar / Google Calendar behaviour and the
    // user's mental model "the dose is taken once on that day".
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["02:30"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-03-28T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-03-28T00:00:00Z"),
      d("2026-03-31T23:59:59Z"),
      ctx,
    );
    // 4 days: 28 (Sat), 29 (Sun, DST), 30 (Mon), 31 (Tue) → 4 slots.
    expect(slots).toHaveLength(4);
    // The 29th slot lands on the forward-jumped minute. The UTC
    // instant for "02:30 Berlin on the spring-forward day" is 01:30 UTC
    // (because at that moment the offset is already +02:00, so the
    // local wall clock reads 03:30).
    const transition = slots.find((s) => {
      const local = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(s.at);
      return local === "2026-03-29";
    });
    expect(transition).toBeDefined();
    expect(transition?.at.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("08:00 Asia/Tokyo on 2026-06-15 corresponds to the right UTC instant", () => {
    // Tokyo is UTC+9 year-round (no DST). 08:00 Tokyo on 2026-06-15
    // is 2026-06-14T23:00:00Z.
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      timeZone: "Asia/Tokyo",
      medication: { startsOn: d("2026-06-15T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-14T00:00:00Z"),
      d("2026-06-16T23:59:59Z"),
      ctx,
    );
    // Within 2026-06-14T00:00Z..2026-06-16T23:59:59Z, Tokyo 08:00
    // lands at UTC 23:00 on the prior day: 06-14T23:00, 06-15T23:00.
    // (06-13T23:00 falls outside the from boundary; 06-16T23:00 is
    // within the to boundary).
    expect(slots.length).toBeGreaterThanOrEqual(2);
    const utcStrings = slots.map((s) => s.at.toISOString());
    expect(utcStrings).toContain("2026-06-14T23:00:00.000Z");
    expect(utcStrings).toContain("2026-06-15T23:00:00.000Z");
  });
});

// ────────────────────────────────────────────────────────────────────
// Legacy fallback
// ────────────────────────────────────────────────────────────────────

describe("occurrencesBetween — legacy fallback (rrule + rolling both null)", () => {
  it("daysOfWeek = null → daily", () => {
    const schedule = makeSchedule({
      daysOfWeek: null,
      windowStart: "08:00",
      timesOfDay: [],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-07T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(7);
  });

  it("daysOfWeek = '1,3,5' → Mon/Wed/Fri only", () => {
    // 2026-06-01 = Mon. Mon/Wed/Fri across Jun 01..Jun 07:
    //   Mon 01, Wed 03, Fri 05 → 3 slots.
    const schedule = makeSchedule({
      daysOfWeek: "1,3,5",
      windowStart: "08:00",
      timesOfDay: [],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-07T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(3);
  });

  it("daysOfWeek = 'i2;3' → bi-weekly Wed (the legacy intervalWeeks fix)", () => {
    // The pre-v1.5 worker ignored intervalWeeks and emitted EVERY
    // Wednesday in the window. This engine fixes that: anchor the
    // phase to startsOn and emit only on matching weeks.
    //
    // Anchor: 2026-06-03 (Wed). Window: Jun 03..Jun 30.
    // Wednesdays: 03, 10, 17, 24.
    // Bi-weekly from anchor 03 → 03 + 17 only (skip 10, 24).
    const schedule = makeSchedule({
      daysOfWeek: "i2;3",
      windowStart: "08:00",
      timesOfDay: [],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-03T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-03T00:00:00Z"),
      d("2026-06-30T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(2);
    const localDays = slots.map((s) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(s.at),
    );
    expect(localDays).toEqual(["2026-06-03", "2026-06-17"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// endsOn cap
// ────────────────────────────────────────────────────────────────────

describe("endsOn cap", () => {
  it("nextOccurrenceAfter returns null past endsOn for an RRULE", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: {
        startsOn: d("2026-06-01T00:00:00Z"),
        endsOn: d("2026-06-30T00:00:00Z"),
      },
    });
    // 5 years past endsOn → null.
    const next = nextOccurrenceAfter(schedule, d("2031-07-01T00:00:00Z"), ctx);
    expect(next).toBeNull();
  });

  it("legacy fallback respects endsOn", () => {
    const schedule = makeSchedule({
      daysOfWeek: null,
      windowStart: "08:00",
      timesOfDay: [],
    });
    const ctx = makeCtx({
      medication: {
        startsOn: d("2026-06-01T00:00:00Z"),
        endsOn: d("2026-06-03T00:00:00Z"),
      },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-10T23:59:59Z"),
      ctx,
    );
    // 01, 02, 03 (endsOn day inclusive) → 3 slots.
    expect(slots).toHaveLength(3);
  });

  it("expandLegacy honours medication.startsOn floor", () => {
    // Schedule with daysOfWeek = null → daily; startsOn in the future
    // means the legacy walker should emit nothing for the pre-startsOn
    // window, mirroring the endsOn cap. Pre-fix the legacy fallback
    // ignored startsOn and emitted historical slots.
    const schedule = makeSchedule({
      daysOfWeek: null,
      windowStart: "08:00",
      timesOfDay: [],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-10T00:00:00Z") },
    });
    // Window straddles startsOn: 06-05..06-12 (8 days), 4 of which
    // are before startsOn (06-05..06-08) and 3 on/after (06-10..06-12;
    // 06-09 is also before startsOn).
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-05T00:00:00Z"),
      d("2026-06-12T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(3);
    const days = slots.map((s) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(s.at),
    );
    expect(days).toEqual(["2026-06-10", "2026-06-11", "2026-06-12"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// RRULE COUNT / UNTIL collision guard
// ────────────────────────────────────────────────────────────────────

describe("expandRrule respects user-supplied COUNT / UNTIL", () => {
  it("skips engine-side UNTIL when the user RRULE has COUNT", () => {
    // FREQ=DAILY;COUNT=3 → exactly 3 daily occurrences from DTSTART.
    // The engine used to append `;UNTIL=<endsOn>` unconditionally,
    // producing an invalid two-bound RRULE that rrule.fromString threw
    // on, collapsing the schedule to zero slots.
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY;COUNT=3",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: {
        startsOn: d("2026-06-01T00:00:00Z"),
        endsOn: d("2026-06-30T00:00:00Z"),
      },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-30T23:59:59Z"),
      ctx,
    );
    // COUNT=3 → June 01, 02, 03 (one slot per day at 08:00 local).
    expect(slots).toHaveLength(3);
  });

  it("skips engine-side UNTIL when the user RRULE has UNTIL", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY;UNTIL=20260603T235959Z",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: {
        startsOn: d("2026-06-01T00:00:00Z"),
        endsOn: d("2026-06-30T00:00:00Z"),
      },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-30T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(3);
  });

  it("returns [] without throwing on a syntactically malformed rrule", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
    // Patch with a malformed RRULE that bypasses the Zod regex (the
    // engine accepts whatever the caller wired). Verifies the catch
    // surfaces zero slots instead of bubbling a ParseError.
    const broken = {
      ...schedule,
      rrule: "FREQ=DAILY;TWICE_DAILY",
    };
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    expect(() =>
      occurrencesBetween(
        broken,
        d("2026-06-01T00:00:00Z"),
        d("2026-06-02T23:59:59Z"),
        ctx,
      ),
    ).not.toThrow();
    const slots = occurrencesBetween(
      broken,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-02T23:59:59Z"),
      ctx,
    );
    expect(slots).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// nextOccurrenceAfter MAX_CHUNKS cap
// ────────────────────────────────────────────────────────────────────

describe("nextOccurrenceAfter chunk cap", () => {
  it("aborts after MAX_CHUNKS for a pathologically-rare schedule with a future startsOn", () => {
    // A schedule with a startsOn 50 years in the future will never
    // emit a slot within the 10-year hardCap. The chunk-walk would
    // otherwise iterate ~40+ 90-day chunks before terminating; with
    // MAX_CHUNKS the walk returns null in bounded time.
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2080-01-01T00:00:00Z") },
    });
    const start = Date.now();
    const next = nextOccurrenceAfter(schedule, d("2026-06-01T00:00:00Z"), ctx);
    const elapsed = Date.now() - start;
    expect(next).toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });
});

// ────────────────────────────────────────────────────────────────────
// Empty timesOfDay fallback
// ────────────────────────────────────────────────────────────────────

describe("empty timesOfDay fallback", () => {
  it("timesOfDay = [] falls back to [windowStart] for RRULE", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: [],
      windowStart: "09:30",
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-02T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(2);
    expect(slots[0].timeOfDay).toBe("09:30");
  });

  it("timesOfDay = [] falls back to [windowStart] for legacy", () => {
    const schedule = makeSchedule({
      daysOfWeek: null,
      timesOfDay: [],
      windowStart: "07:15",
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-02T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(2);
    expect(slots[0].timeOfDay).toBe("07:15");
  });
});

// ────────────────────────────────────────────────────────────────────
// Grace window
// ────────────────────────────────────────────────────────────────────

describe("grace window", () => {
  it("uses reminderGraceMinutes when set", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
      reminderGraceMinutes: 45,
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-01T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(1);
    const graceMs = slots[0].graceUntil.getTime() - slots[0].at.getTime();
    expect(graceMs).toBe(45 * 60_000);
  });

  it("falls back to windowEnd - windowStart when reminderGraceMinutes is null", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
      windowStart: "08:00",
      windowEnd: "10:00",
      reminderGraceMinutes: null,
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-01T23:59:59Z"),
      ctx,
    );
    const graceMs = slots[0].graceUntil.getTime() - slots[0].at.getTime();
    expect(graceMs).toBe(120 * 60_000);
  });

  it("defaults to 60 min when windowStart === windowEnd", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
      windowStart: "08:00",
      windowEnd: "08:00",
      reminderGraceMinutes: null,
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-01T23:59:59Z"),
      ctx,
    );
    const graceMs = slots[0].graceUntil.getTime() - slots[0].at.getTime();
    expect(graceMs).toBe(60 * 60_000);
  });
});

// ────────────────────────────────────────────────────────────────────
// nextOccurrenceAfter + matchesInstant smoke
// ────────────────────────────────────────────────────────────────────

describe("nextOccurrenceAfter + matchesInstant", () => {
  it("nextOccurrenceAfter walks forward to the next RRULE occurrence", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=15",
      timesOfDay: ["09:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-01-15T00:00:00Z") },
    });
    const next = nextOccurrenceAfter(schedule, d("2026-03-20T00:00:00Z"), ctx);
    expect(next).not.toBeNull();
    // Next monthly-15th after Mar 20 → Apr 15.
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(next!.at),
    ).toBe("2026-04-15");
  });

  it("matchesInstant returns true at an exact RRULE occurrence", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-02T23:59:59Z"),
      ctx,
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(matchesInstant(schedule, slots[0].at, ctx)).toBe(true);
  });

  it("matchesInstant returns false at a near-but-not-equal instant", () => {
    const schedule = makeSchedule({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-02T23:59:59Z"),
      ctx,
    );
    const offByTenMin = new Date(slots[0].at.getTime() + 10 * 60_000);
    expect(matchesInstant(schedule, offByTenMin, ctx)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.7.0 — PRN (as-needed)
// ────────────────────────────────────────────────────────────────────

describe("occurrencesBetween — PRN", () => {
  it("emits zero occurrences even with a daily rrule present", () => {
    const schedule = makeSchedule({
      scheduleType: "PRN",
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-01T00:00:00Z") },
    });
    const slots = occurrencesBetween(
      schedule,
      d("2026-06-01T00:00:00Z"),
      d("2026-06-30T23:59:59Z"),
      ctx,
    );
    expect(slots).toHaveLength(0);
  });

  it("nextOccurrenceAfter returns null for PRN", () => {
    const schedule = makeSchedule({
      scheduleType: "PRN",
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx();
    expect(nextOccurrenceAfter(schedule, d("2026-06-01T00:00:00Z"), ctx)).toBe(
      null,
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.7.0 — CYCLIC (on/off weeks)
// ────────────────────────────────────────────────────────────────────

describe("occurrencesBetween — CYCLIC", () => {
  // 2-on / 1-off daily schedule anchored to Sun 2026-06-07 (a week
  // start). Weeks: 0,1 on; 2 off; 3 on; 4 on; 5 off; …
  function cyclicDaily(): CanonicalSchedule {
    return makeSchedule({
      scheduleType: "CYCLIC",
      cyclicOnWeeks: 2,
      cyclicOffWeeks: 1,
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00"],
    });
  }

  it("emits in on-weeks (0,1) and skips the off-week (2), resumes week 3", () => {
    const schedule = cyclicDaily();
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-07T00:00:00Z") }, // Sunday
    });

    // Week 0 (Jun 7–13) — on.
    const week0 = occurrencesBetween(
      schedule,
      d("2026-06-07T00:00:00Z"),
      d("2026-06-13T23:59:59Z"),
      ctx,
    );
    expect(week0.length).toBeGreaterThan(0);

    // Week 2 (Jun 21–27) — off.
    const week2 = occurrencesBetween(
      schedule,
      d("2026-06-21T00:00:00Z"),
      d("2026-06-27T23:59:59Z"),
      ctx,
    );
    expect(week2).toHaveLength(0);

    // Week 3 (Jun 28–Jul 4) — on again.
    const week3 = occurrencesBetween(
      schedule,
      d("2026-06-28T00:00:00Z"),
      d("2026-07-04T23:59:59Z"),
      ctx,
    );
    expect(week3.length).toBeGreaterThan(0);
  });

  it("composes with BYDAY — only the matching weekday inside on-weeks", () => {
    const schedule = makeSchedule({
      scheduleType: "CYCLIC",
      cyclicOnWeeks: 1,
      cyclicOffWeeks: 1,
      rrule: "FREQ=WEEKLY;BYDAY=WE",
      timesOfDay: ["08:00"],
    });
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-07T00:00:00Z") }, // Sunday wk-start
    });
    // Week 0 (on) Wednesday is Jun 10.
    const onWeek = occurrencesBetween(
      schedule,
      d("2026-06-07T00:00:00Z"),
      d("2026-06-13T23:59:59Z"),
      ctx,
    );
    expect(onWeek).toHaveLength(1);
    // Week 1 (off) Wednesday is Jun 17 — suppressed.
    const offWeek = occurrencesBetween(
      schedule,
      d("2026-06-14T00:00:00Z"),
      d("2026-06-20T23:59:59Z"),
      ctx,
    );
    expect(offWeek).toHaveLength(0);
  });

  it("nextOccurrenceAfter lands in the next on-week, skipping the off-week", () => {
    const schedule = cyclicDaily();
    const ctx = makeCtx({
      medication: { startsOn: d("2026-06-07T00:00:00Z") },
    });
    // From the start of the off-week (Jun 21), the next due slot must be
    // in week 3 (Jun 28+), not inside the off week.
    const next = nextOccurrenceAfter(schedule, d("2026-06-21T00:00:00Z"), ctx);
    expect(next).not.toBe(null);
    expect(next!.at.getTime()).toBeGreaterThanOrEqual(
      d("2026-06-28T00:00:00Z").getTime(),
    );
  });
});
