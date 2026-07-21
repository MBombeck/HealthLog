/**
 * v1.8.5 — `computeNextDueAt` tests, focused on the rolling-cadence
 * first-dose semantics.
 *
 * The server computes `nextDueAt` by asking the canonical engine for the
 * earliest next slot across a medication's schedules. The medically
 * important case: a rolling course whose `startsOn` is earlier today with
 * no intake logged must surface its start dose as DUE/OVERDUE ("take
 * now"), not roll it forward by N days (which also suppressed its
 * reminder, since the worker shares the engine).
 */
import { describe, expect, it } from "vitest";

import {
  computeDisplayDue,
  computeNextDueAt,
  toResolvedSlotMark,
  type ResolvedSlotMark,
} from "../next-due";
import type { WorkerMedicationRow, WorkerScheduleRow } from "../worker-helpers";

/** A slot-anchored resolved mark (the write paths' canonical shape). */
function mark(at: Date): ResolvedSlotMark {
  return { at, slotAnchored: true };
}

function d(iso: string): Date {
  return new Date(iso);
}

function makeMedication(
  overrides: Partial<WorkerMedicationRow> = {},
): WorkerMedicationRow {
  return {
    id: "med-1",
    startsOn: null,
    endsOn: null,
    oneShot: false,
    createdAt: d("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRollingSchedule(
  overrides: Partial<WorkerScheduleRow> = {},
): WorkerScheduleRow {
  return {
    id: "sched-1",
    windowStart: "08:00",
    windowEnd: "09:00",
    daysOfWeek: null,
    timesOfDay: ["08:00"],
    reminderGraceMinutes: null,
    rrule: null,
    rollingIntervalDays: 7,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    ...overrides,
  };
}

const BERLIN = "Europe/Berlin";

function berlinDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

describe("computeNextDueAt — rolling first dose", () => {
  it("surfaces an overdue first dose (past startsOn, no intake) as DUE today", () => {
    const startsOn = d("2026-06-10T06:00:00Z"); // 08:00 Berlin slot is past
    const now = d("2026-06-10T12:00:00Z"); // noon, after the slot
    const next = computeNextDueAt({
      medication: makeMedication({ startsOn }),
      schedules: [makeRollingSchedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeLessThan(now.getTime()); // overdue
    expect(berlinDay(next!)).toBe("2026-06-10");
  });

  it("returns the future first dose AT startsOn (no intake) without adding N", () => {
    const startsOn = d("2026-06-12T00:00:00Z");
    const now = d("2026-06-10T12:00:00Z");
    const next = computeNextDueAt({
      medication: makeMedication({ startsOn }),
      schedules: [makeRollingSchedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).not.toBeNull();
    expect(berlinDay(next!)).toBe("2026-06-12");
  });

  it("re-anchors on lastIntakeAt + N once an intake exists", () => {
    const now = d("2026-06-10T12:00:00Z");
    const next = computeNextDueAt({
      medication: makeMedication({ startsOn: d("2026-06-01T00:00:00Z") }),
      schedules: [makeRollingSchedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: d("2026-06-09T08:00:00Z"),
    });
    expect(next).not.toBeNull();
    expect(berlinDay(next!)).toBe("2026-06-16"); // 2026-06-09 + 7d
  });

  it("returns null when no schedules", () => {
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [],
      now: d("2026-06-10T12:00:00Z"),
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).toBeNull();
  });
});

/**
 * v1.15.10 BUG 2 — next-due must advance past slots the user has already
 * resolved (taken / skipped / auto-missed) and surface the next genuinely
 * OPEN slot, not re-surface a present/past resolved slot ("träge").
 *
 * Twice-daily med, 07:00 + 19:00 Berlin. In June Berlin is UTC+2, so the
 * canonical slots are 05:00 UTC (07:00) and 17:00 UTC (19:00).
 */
describe("computeNextDueAt — skip resolved slots (twice-daily)", () => {
  function twiceDaily(): WorkerScheduleRow {
    return {
      id: "sched-2x",
      windowStart: "07:00",
      windowEnd: "19:00",
      daysOfWeek: null,
      timesOfDay: ["07:00", "19:00"],
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
    };
  }

  it("advances to tomorrow's 07:00 when both of today's slots are resolved", () => {
    // Afternoon: 07:00 already past + logged, 19:00 logged early. Both today's
    // slots resolved → next must be tomorrow 07:00, not today 19:00.
    const now = d("2026-06-10T16:00:00Z"); // 18:00 Berlin, before the 19:00 slot
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [twiceDaily()],
      now,
      userTz: BERLIN,
      lastIntakeAt: d("2026-06-10T15:30:00Z"),
      resolvedSlots: [
        mark(d("2026-06-10T05:00:00Z")), // today 07:00 Berlin
        mark(d("2026-06-10T17:00:00Z")), // today 19:00 Berlin
      ],
    });
    expect(next).not.toBeNull();
    expect(berlinDay(next!)).toBe("2026-06-11");
    // 07:00 Berlin = 05:00 UTC.
    expect(next!.toISOString()).toBe("2026-06-11T05:00:00.000Z");
  });

  it("surfaces today's 19:00 when only the 07:00 slot is resolved", () => {
    const now = d("2026-06-10T16:00:00Z"); // 18:00 Berlin
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [twiceDaily()],
      now,
      userTz: BERLIN,
      lastIntakeAt: d("2026-06-10T07:13:00Z"),
      resolvedSlots: [mark(d("2026-06-10T05:00:00Z"))], // only today 07:00
    });
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-06-10T17:00:00.000Z"); // today 19:00
  });

  it("keeps the legacy purely-time-anchored next-due when no resolvedSlots passed", () => {
    const now = d("2026-06-10T16:00:00Z"); // 18:00 Berlin → next slot is 19:00
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [twiceDaily()],
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-06-10T17:00:00.000Z"); // today 19:00
  });
});

/**
 * v1.16.1 — a stale / degenerate legacy window must NEVER determine
 * next-due once `timesOfDay` exists. Regression fixture: a twice-daily
 * med whose schedule row still carries the historic `07:00 / 07:00`
 * point window while the canonical dose times moved to 09:00 / 21:00.
 * The card read "today, 07:00" off the window; the engine must anchor on
 * the timesOfDay slots exclusively.
 */
describe("computeNextDueAt — stale degenerate window never wins over timesOfDay", () => {
  function staleWindowTwiceDaily(): WorkerScheduleRow {
    return {
      id: "sched-stale",
      windowStart: "07:00",
      windowEnd: "07:00",
      daysOfWeek: null,
      timesOfDay: ["09:00", "21:00"],
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
    };
  }

  it("returns today's 09:00 slot before the morning dose", () => {
    const now = d("2026-06-10T06:00:00Z"); // 08:00 Berlin
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [staleWindowTwiceDaily()],
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).not.toBeNull();
    // 09:00 Berlin (CEST, UTC+2) = 07:00 UTC — never the stale 07:00 window.
    expect(next!.toISOString()).toBe("2026-06-10T07:00:00.000Z");
  });

  it("returns today's 21:00 slot between the doses", () => {
    const now = d("2026-06-10T08:00:00Z"); // 10:00 Berlin
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [staleWindowTwiceDaily()],
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).not.toBeNull();
    // 21:00 Berlin = 19:00 UTC.
    expect(next!.toISOString()).toBe("2026-06-10T19:00:00.000Z");
  });
});

/**
 * v1.16.4 — `computeDisplayDue`: an unresolved slot whose anchor has
 * passed must stay on the card as an OPEN overdue slot while `now` is
 * still inside its catch-up band (`anchor < now ≤ overdueEnd`); only a
 * closed or resolved band advances to the future next-due.
 */
function makeDailySchedule(
  overrides: Partial<WorkerScheduleRow> = {},
): WorkerScheduleRow {
  return {
    id: "sched-daily-1",
    windowStart: "09:00",
    windowEnd: "21:00",
    daysOfWeek: null,
    timesOfDay: ["09:00", "21:00"],
    reminderGraceMinutes: null,
    rrule: null,
    rollingIntervalDays: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    ...overrides,
  };
}

describe("computeDisplayDue — open overdue slot", () => {
  // Berlin is UTC+2 in June: the 21:00 local slot on 2026-06-10 is
  // 19:00Z; its default band is 20:00–22:00 local with a 3 h late tail,
  // so the catch-up window stays open until 01:00 local (23:00Z).
  const medication = makeMedication();
  const schedules = [makeDailySchedule()];

  it("surfaces the unresolved 21:00 slot at 22:30 (inside the catch-up tail) as overdue", () => {
    const now = d("2026-06-10T20:30:00Z"); // 22:30 Berlin
    const due = computeDisplayDue({
      medication,
      schedules,
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(due).not.toBeNull();
    expect(due!.overdue).toBe(true);
    expect(due!.at.toISOString()).toBe("2026-06-10T19:00:00.000Z"); // 21:00 Berlin
  });

  it("advances to the next future slot (09:00) once the band closed at 02:00", () => {
    const now = d("2026-06-11T00:00:00Z"); // 02:00 Berlin — past the 01:00 tail end
    const due = computeDisplayDue({
      medication,
      schedules,
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(due).not.toBeNull();
    expect(due!.overdue).toBe(false);
    expect(due!.at.toISOString()).toBe("2026-06-11T07:00:00.000Z"); // 09:00 Berlin
  });

  it("treats a slot with a live taken/skipped row on the anchor as resolved", () => {
    const now = d("2026-06-10T20:30:00Z");
    const due = computeDisplayDue({
      medication,
      schedules,
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
      resolvedSlots: [mark(d("2026-06-10T19:00:00Z"))],
    });
    expect(due).not.toBeNull();
    expect(due!.overdue).toBe(false);
    expect(due!.at.toISOString()).toBe("2026-06-11T07:00:00.000Z");
  });

  it("never claims an overdue anchor from before the current era floor", () => {
    const now = d("2026-06-10T20:30:00Z");
    const due = computeDisplayDue({
      medication,
      schedules,
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
      eraStart: d("2026-06-10T19:30:00Z"), // schedules replaced after the slot
    });
    expect(due).not.toBeNull();
    expect(due!.overdue).toBe(false);
  });
});

describe("computeDisplayDue — canonical availability start", () => {
  const weekly = makeDailySchedule({
    id: "sched-weekly",
    windowStart: "08:00",
    windowEnd: "08:00",
    timesOfDay: ["08:00"],
    daysOfWeek: "3",
    rrule: "FREQ=WEEKLY;BYDAY=WE",
  });

  it("carries the weekly default band's early start for a future slot", () => {
    const due = computeDisplayDue({
      medication: makeMedication(),
      schedules: [weekly],
      now: d("2026-06-09T05:30:00Z"),
      userTz: BERLIN,
      lastIntakeAt: null,
    });

    expect(due?.at.toISOString()).toBe("2026-06-10T06:00:00.000Z");
    expect(due?.overdue).toBe(false);
    expect(due?.availableFrom?.toISOString()).toBe("2026-06-09T05:00:00.000Z");
  });

  it("uses an explicit weekly dose-window boundary instead of the default day-scale lead", () => {
    const due = computeDisplayDue({
      medication: makeMedication(),
      schedules: [
        {
          ...weekly,
          doseWindows: [{ timeOfDay: "08:00", start: "06:00", end: "10:00" }],
        },
      ],
      now: d("2026-06-09T05:30:00Z"),
      userTz: BERLIN,
      lastIntakeAt: null,
    });

    expect(due?.at.toISOString()).toBe("2026-06-10T06:00:00.000Z");
    expect(due?.availableFrom?.toISOString()).toBe("2026-06-10T03:00:00.000Z");
  });
});

/**
 * v1.16.9 — an AD-HOC row (`scheduledFor === takenAt`) must never
 * ±6h-resolve a DIFFERENT slot. The proven failure: twice-daily 08:00 /
 * 20:00 Berlin, an ad-hoc take at 14:30 sat within 6h of tonight's 20:00
 * anchor and resolved it — the genuinely-due dose disappeared from the
 * card while the ledger still counted the slot missed.
 */
describe("resolved-slot marks — ad-hoc rows only match their own anchor", () => {
  const medication = makeMedication();
  // 08:00 / 20:00 Berlin (CEST): 06:00Z / 18:00Z.
  function schedule(): WorkerScheduleRow {
    return {
      id: "sched-2x",
      windowStart: "08:00",
      windowEnd: "20:00",
      daysOfWeek: null,
      timesOfDay: ["08:00", "20:00"],
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
    };
  }
  const ADHOC_1430 = d("2026-06-10T12:30:00Z"); // 14:30 Berlin

  it("a 14:30 ad-hoc take leaves tonight's 20:00 slot due", () => {
    const now = d("2026-06-10T15:00:00Z"); // 17:00 Berlin
    const next = computeNextDueAt({
      medication,
      schedules: [schedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: ADHOC_1430,
      resolvedSlots: [
        // The morning slot was genuinely taken (slot-anchored row)…
        mark(d("2026-06-10T06:00:00Z")),
        // …and the 14:30 take recorded ad-hoc (`scheduledFor === takenAt`).
        toResolvedSlotMark({ scheduledFor: ADHOC_1430, takenAt: ADHOC_1430 }),
      ],
    });
    expect(next).not.toBeNull();
    // Tonight's 20:00 Berlin (18:00Z) stays due — the ad-hoc row must not
    // resolve it across the radius.
    expect(next!.toISOString()).toBe("2026-06-10T18:00:00.000Z");
  });

  it("a 14:30 ad-hoc take does not suppress the 20:00 overdue pill either", () => {
    const now = d("2026-06-10T19:00:00Z"); // 21:00 Berlin — inside the late tail
    const due = computeDisplayDue({
      medication,
      schedules: [schedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: ADHOC_1430,
      resolvedSlots: [
        mark(d("2026-06-10T06:00:00Z")),
        toResolvedSlotMark({ scheduledFor: ADHOC_1430, takenAt: ADHOC_1430 }),
      ],
    });
    expect(due).not.toBeNull();
    expect(due!.overdue).toBe(true);
    expect(due!.at.toISOString()).toBe("2026-06-10T18:00:00.000Z");
  });

  it("a slot-anchored attributed row still resolves its slot across drift", () => {
    const now = d("2026-06-10T19:00:00Z"); // 21:00 Berlin
    const due = computeDisplayDue({
      medication,
      schedules: [schedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: d("2026-06-10T18:05:00Z"),
      resolvedSlots: [
        mark(d("2026-06-10T06:00:00Z")),
        // Attributed take: scheduledFor on the anchor, takenAt 20:05.
        toResolvedSlotMark({
          scheduledFor: d("2026-06-10T18:00:00Z"),
          takenAt: d("2026-06-10T18:05:00Z"),
        }),
      ],
    });
    expect(due).not.toBeNull();
    expect(due!.overdue).toBe(false);
    // Both today's slots resolved → tomorrow's 08:00 Berlin (06:00Z).
    expect(due!.at.toISOString()).toBe("2026-06-11T06:00:00.000Z");
  });

  it("an ad-hoc row sitting exactly on the anchor still resolves that slot", () => {
    const now = d("2026-06-10T19:00:00Z");
    const due = computeDisplayDue({
      medication,
      schedules: [schedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: d("2026-06-10T18:00:00Z"),
      resolvedSlots: [
        mark(d("2026-06-10T06:00:00Z")),
        // Take recorded at the exact anchor instant — ad-hoc shaped but ON
        // the slot; the near-exact epsilon keeps it resolving.
        toResolvedSlotMark({
          scheduledFor: d("2026-06-10T18:00:00Z"),
          takenAt: d("2026-06-10T18:00:00Z"),
        }),
      ],
    });
    expect(due).not.toBeNull();
    expect(due!.overdue).toBe(false);
    expect(due!.at.toISOString()).toBe("2026-06-11T06:00:00.000Z");
  });

  it("behaves identically in a non-European zone (Pacific/Auckland)", () => {
    const AUCKLAND = "Pacific/Auckland"; // UTC+12 in June (NZST)
    // 08:00 / 20:00 Auckland on 2026-06-10 = 2026-06-09T20:00Z / 2026-06-10T08:00Z.
    const adhoc = d("2026-06-10T02:30:00Z"); // 14:30 Auckland
    const now = d("2026-06-10T09:00:00Z"); // 21:00 Auckland
    const due = computeDisplayDue({
      medication,
      schedules: [schedule()],
      now,
      userTz: AUCKLAND,
      lastIntakeAt: adhoc,
      resolvedSlots: [
        mark(d("2026-06-09T20:00:00Z")),
        toResolvedSlotMark({ scheduledFor: adhoc, takenAt: adhoc }),
      ],
    });
    expect(due).not.toBeNull();
    expect(due!.overdue).toBe(true);
    expect(due!.at.toISOString()).toBe("2026-06-10T08:00:00.000Z");
  });
});

/**
 * v1.16.11 (#316) — as-needed (PRN) medications persist ZERO schedule
 * rows, so every due surface (list cards, dashboard, reminder worker)
 * resolves null by construction. Pin both the forward next-due and the
 * display-due (open-overdue) paths on the empty schedule list, with a
 * recent intake present — a logged ad-hoc take must not conjure a due.
 */
describe("as-needed (zero schedules) — never due", () => {
  it("computeNextDueAt returns null even with a recent intake", () => {
    const now = new Date();
    const next = computeNextDueAt({
      medication: makeMedication({
        createdAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      }),
      schedules: [],
      now,
      userTz: BERLIN,
      lastIntakeAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    });
    expect(next).toBeNull();
  });

  it("computeDisplayDue returns null — no overdue escalation can ever mint", () => {
    const now = new Date();
    const display = computeDisplayDue({
      medication: makeMedication({
        createdAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      }),
      schedules: [],
      now,
      userTz: BERLIN,
      lastIntakeAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      resolvedSlots: [],
    });
    expect(display).toBeNull();
  });
});
