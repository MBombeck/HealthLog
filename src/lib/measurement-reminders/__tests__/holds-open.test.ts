/**
 * v1.39.2 — which reminders stay due after they are sent. One predicate for
 * the reminder tick, the daily digest and the edit route, so the three cannot
 * disagree about whether a reminder is an open task or a rhythm.
 */
import { describe, expect, it } from "vitest";

import {
  HOLD_OPEN_MIN_CYCLE_DAYS,
  holdsOpenAfterReminder,
} from "../holds-open";

const TZ = "Europe/Berlin";
const SLOT = new Date("2026-09-26T07:00:00.000Z");

function r(over: Partial<Parameters<typeof holdsOpenAfterReminder>[0]> = {}) {
  return {
    origin: "VORSORGE",
    intervalDays: null as number | null,
    rrule: null as string | null,
    anchorDate: null,
    notifyHour: 9,
    lastSatisfiedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

describe("holdsOpenAfterReminder", () => {
  it("holds a cycle longer than a week open", () => {
    expect(HOLD_OPEN_MIN_CYCLE_DAYS).toBe(7);
    expect(holdsOpenAfterReminder(r({ intervalDays: 14 }), TZ, SLOT)).toBe(
      true,
    );
    expect(holdsOpenAfterReminder(r({ intervalDays: 8 }), TZ, SLOT)).toBe(true);
  });

  it("lets a weekly or shorter interval roll on", () => {
    expect(holdsOpenAfterReminder(r({ intervalDays: 7 }), TZ, SLOT)).toBe(
      false,
    );
    expect(holdsOpenAfterReminder(r({ intervalDays: 1 }), TZ, SLOT)).toBe(
      false,
    );
  });

  it("reads a rule by the gap to its next occurrence", () => {
    expect(
      holdsOpenAfterReminder(r({ rrule: "FREQ=YEARLY;INTERVAL=1" }), TZ, SLOT),
    ).toBe(true);
    expect(
      holdsOpenAfterReminder(r({ rrule: "FREQ=MONTHLY;INTERVAL=1" }), TZ, SLOT),
    ).toBe(true);
    expect(holdsOpenAfterReminder(r({ rrule: "FREQ=WEEKLY" }), TZ, SLOT)).toBe(
      false,
    );
    expect(
      holdsOpenAfterReminder(r({ rrule: "FREQ=DAILY;BYHOUR=9,19" }), TZ, SLOT),
    ).toBe(false);
  });

  it("holds a rule with no occurrence left open: its last slot is the task", () => {
    expect(
      holdsOpenAfterReminder(
        r({ rrule: "FREQ=DAILY;UNTIL=20260926T235959Z" }),
        TZ,
        SLOT,
      ),
    ).toBe(true);
  });

  it("holds a reminder with no cadence open", () => {
    expect(holdsOpenAfterReminder(r(), TZ, SLOT)).toBe(true);
  });

  it("never holds an appointment", () => {
    expect(holdsOpenAfterReminder(r({ origin: "ENCOUNTER" }), TZ, SLOT)).toBe(
      false,
    );
    expect(
      holdsOpenAfterReminder(
        r({ origin: "ENCOUNTER", intervalDays: 365 }),
        TZ,
        SLOT,
      ),
    ).toBe(false);
  });

  it("holds the last occurrence open when it is sent", () => {
    // The tick passes the send instant, a few seconds past the occurrence.
    expect(
      holdsOpenAfterReminder(
        r({ rrule: "FREQ=DAILY;UNTIL=20260926T235959Z" }),
        TZ,
        new Date(SLOT.getTime() + 20_000),
      ),
    ).toBe(true);
  });

  it("measures the gap that follows the slot, not the one after it", () => {
    // Twice a month, on the 3rd and on the 1st: from a slot on the 3rd the
    // next occurrence is four weeks out, and it is that cycle that is open.
    const rule = r({ rrule: "FREQ=MONTHLY;BYMONTHDAY=1,3" });
    expect(
      holdsOpenAfterReminder(rule, TZ, new Date("2026-09-03T07:00:00.000Z")),
    ).toBe(true);
    expect(
      holdsOpenAfterReminder(rule, TZ, new Date("2026-09-01T07:00:00.000Z")),
    ).toBe(false);
  });
});
