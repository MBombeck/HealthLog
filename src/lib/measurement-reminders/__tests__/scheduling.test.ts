/**
 * v1.17.1 — server-authoritative next-due computation for Vorsorge
 * reminders. Pins the rolling + rrule cadence contract that web ↔ iOS
 * both read off `nextDueAt`.
 */
import { describe, it, expect } from "vitest";

import {
  byHourTimesOfDay,
  computeReminderNextDueAt,
  parseReminderAnchor,
  type ReminderScheduleInput,
} from "../scheduling";
import { relativeDueKey } from "../due-day";

const TZ = "Europe/Berlin";

function base(
  overrides: Partial<ReminderScheduleInput>,
): ReminderScheduleInput {
  return {
    intervalDays: null,
    rrule: null,
    anchorDate: null,
    notifyHour: 9,
    lastSatisfiedAt: null,
    createdAt: new Date("2026-06-01T08:00:00Z"),
    ...overrides,
  };
}

describe("computeReminderNextDueAt", () => {
  it("returns null when neither intervalDays nor rrule is set", () => {
    const now = new Date("2026-06-10T07:00:00Z");
    expect(computeReminderNextDueAt(base({}), TZ, now)).toBeNull();
  });

  it("rolling, never satisfied: first due AT the anchor day notify-hour", () => {
    // Anchor 2026-06-10; notifyHour 9 local (Berlin = UTC+2 in June → 07:00Z).
    const reminder = base({
      intervalDays: 7,
      anchorDate: new Date("2026-06-10T00:00:00Z"),
      notifyHour: 9,
      createdAt: new Date("2026-06-09T00:00:00Z"),
    });
    // "after" before the anchor → the first due is the anchor's slot.
    const due = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-09T12:00:00Z"),
    );
    expect(due).not.toBeNull();
    // 09:00 Berlin on 2026-06-10 == 07:00Z (DST).
    expect(due!.toISOString()).toBe("2026-06-10T07:00:00.000Z");
  });

  // The create and edit routes compute `nextDueAt` with exactly this call.
  // A first due date weeks back, never measured since, stays on that day, so
  // the card reads it as overdue: it is not walked forward past now.
  it("rolling, never satisfied, first due weeks back: stays on the anchor day", () => {
    const now = new Date("2026-11-08T19:40:00Z"); // 20:40 in Berlin
    const reminder = base({
      intervalDays: 2,
      notifyHour: 18,
      anchorDate: parseReminderAnchor("2026-10-04", TZ),
      createdAt: now,
    });
    const next = computeReminderNextDueAt(reminder, TZ, now);
    // 4 October, 18:00 in Berlin (UTC+2).
    expect(next).toEqual(new Date("2026-10-04T16:00:00Z"));
    expect(relativeDueKey(next!.toISOString(), now.getTime(), TZ)).toEqual({
      key: "measurementReminders.overdueByDays",
      days: 35,
    });
  });

  it("rolling, satisfied: next due is lastSatisfiedAt + N days at notify-hour", () => {
    const reminder = base({
      intervalDays: 7,
      lastSatisfiedAt: new Date("2026-06-10T15:00:00Z"),
      notifyHour: 9,
    });
    const due = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-10T16:00:00Z"),
    );
    expect(due).not.toBeNull();
    // 7 days after the satisfy → 2026-06-17, slot at 09:00 Berlin = 07:00Z.
    expect(due!.toISOString()).toBe("2026-06-17T07:00:00.000Z");
  });

  it("rolling honours the interval length (30 days)", () => {
    const reminder = base({
      intervalDays: 30,
      lastSatisfiedAt: new Date("2026-06-01T15:00:00Z"),
      notifyHour: 9,
    });
    const due = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-02T00:00:00Z"),
    );
    expect(due!.toISOString()).toBe("2026-07-01T07:00:00.000Z");
  });

  it("rrule annual: walks to the next yearly occurrence after now", () => {
    // FREQ=YEARLY anchored on the createdAt day (2026-06-01).
    const reminder = base({
      rrule: "FREQ=YEARLY",
      anchorDate: new Date("2026-06-01T00:00:00Z"),
      createdAt: new Date("2026-06-01T00:00:00Z"),
      notifyHour: 9,
    });
    // After the 2026 occurrence → expect the 2027 one.
    const due = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-02T00:00:00Z"),
    );
    expect(due).not.toBeNull();
    expect(due!.getUTCFullYear()).toBe(2027);
    expect(due!.getUTCMonth()).toBe(5); // June (0-indexed)
  });

  // v1.18.1 — the twice-daily BP protocol (BYHOUR=7,19) must fire at BOTH
  // clock hours, not collapse to the single notifyHour.
  it("rrule BYHOUR=7,19: next due lands on the earliest unfired clock hour", () => {
    const reminder = base({
      rrule: "FREQ=DAILY;BYHOUR=7,19;INTERVAL=1",
      anchorDate: new Date("2026-06-10T00:00:00Z"),
      createdAt: new Date("2026-06-10T00:00:00Z"),
      notifyHour: 7,
    });
    // After 06:00 Berlin (04:00Z) on the anchor day → the 07:00 slot.
    const morning = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-10T04:00:00Z"),
    );
    // 07:00 Berlin == 05:00Z (DST).
    expect(morning!.toISOString()).toBe("2026-06-10T05:00:00.000Z");

    // After the morning slot but before evening → the 19:00 slot SAME day.
    const evening = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-10T06:00:00Z"),
    );
    // 19:00 Berlin == 17:00Z (DST).
    expect(evening!.toISOString()).toBe("2026-06-10T17:00:00.000Z");
  });

  // A ten-year booster (tetanus, FSME, …) uses the engine's maximum rolling
  // interval — 3650 days. When such a reminder is satisfied, the satisfy path
  // computes the next due with `after === lastSatisfiedAt`, so the single
  // rolling slot lands exactly `intervalDays` out — right on the engine's
  // ten-year forward search horizon. The boundary slot must still be found;
  // a decade booster whose next dose is logged must roll forward, not vanish.
  it("rolling at the maximum interval (3650 days) still re-anchors on satisfy", () => {
    // Mirrors `satisfyReminder`: lastSatisfiedAt and `after` are the same
    // instant (the dose's day-granular occurredAt, at day start).
    const satisfiedAt = new Date("2026-08-08T00:00:00Z");
    const reminder = base({
      intervalDays: 3650,
      // Anchor from the original 2016 dose + interval — irrelevant once
      // satisfied, but this is what the mint wrote.
      anchorDate: new Date("2026-03-13T00:00:00Z"),
      lastSatisfiedAt: satisfiedAt,
      notifyHour: 9,
      createdAt: new Date("2026-08-08T00:00:00Z"),
    });
    const due = computeReminderNextDueAt(reminder, TZ, satisfiedAt);
    expect(due).not.toBeNull();
    // 3650 days after 2026-08-08 → 2036-08-05, slot at 09:00 Berlin (07:00Z).
    expect(due!.getUTCFullYear()).toBe(2036);
    expect(due!.getTime()).toBeGreaterThan(satisfiedAt.getTime());
  });
});

describe("byHourTimesOfDay", () => {
  it("parses BYHOUR into sorted, deduped HH:00 strings", () => {
    expect(byHourTimesOfDay("FREQ=DAILY;BYHOUR=19,7,7;INTERVAL=1")).toEqual([
      "07:00",
      "19:00",
    ]);
  });

  it("returns null for an rrule without BYHOUR", () => {
    expect(byHourTimesOfDay("FREQ=YEARLY")).toBeNull();
    expect(byHourTimesOfDay(null)).toBeNull();
  });

  it("drops out-of-range hours and returns null when none survive", () => {
    expect(byHourTimesOfDay("FREQ=DAILY;BYHOUR=24,99")).toBeNull();
    expect(byHourTimesOfDay("FREQ=DAILY;BYHOUR=6,30")).toEqual(["06:00"]);
  });
});
