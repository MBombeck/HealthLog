/**
 * The card reads the server-resolved open dose only. The pill, the status
 * the escalation reads and the slot the take records come from
 * `currentDose`; the card compares its instants with the clock so a dose
 * fetched minutes ago still turns due, overdue or missed on time.
 */
import { describe, expect, it } from "vitest";

import {
  cardDisplayedSlot,
  cardDoseStatus,
  cardWindowPill,
  liveDoseState,
} from "../pill";

const SLOT = "2026-11-21T13:59:00.000Z";
const dose = {
  state: "due",
  targetAt: SLOT,
  dueAt: "2026-11-21T12:59:00.000Z",
  overdueSince: "2026-11-21T14:59:00.000Z",
  missedAfter: "2026-11-21T17:59:00.000Z",
};
const at = (iso: string) => new Date(iso);

describe("liveDoseState", () => {
  it("moves an open dose along its own instants", () => {
    const pending = { ...dose, state: "upcoming" };
    expect(liveDoseState(pending, at("2026-11-21T12:00:00Z"))).toBe("upcoming");
    expect(liveDoseState(pending, at("2026-11-21T13:00:00Z"))).toBe("due");
    expect(liveDoseState(dose, at("2026-11-21T15:00:00Z"))).toBe("overdue");
    expect(liveDoseState(dose, at("2026-11-21T18:00:00Z"))).toBe("missed");
  });

  it("keeps a recorded state", () => {
    const taken = { ...dose, state: "taken" };
    expect(liveDoseState(taken, at("2026-11-21T13:00:00Z"))).toBe("taken");
    expect(liveDoseState(null, at("2026-11-21T13:00:00Z"))).toBeNull();
  });
});

describe("cardWindowPill", () => {
  it("shows the dose window while due", () => {
    expect(cardWindowPill(dose, at("2026-11-21T14:10:00Z"), "UTC")).toEqual({
      status: "in_window",
      windowStart: "12:59",
      windowEnd: "14:59",
    });
  });

  it("escalates past the on-time window, and past its midpoint", () => {
    expect(
      cardWindowPill(dose, at("2026-11-21T15:00:00Z"), "UTC")?.status,
    ).toBe("late");
    expect(
      cardWindowPill(dose, at("2026-11-21T16:30:00Z"), "UTC")?.status,
    ).toBe("very_late");
  });

  it("no pill before the window, after the miss cutoff, or without a dose", () => {
    const pending = { ...dose, state: "upcoming" };
    expect(cardWindowPill(pending, at("2026-11-21T12:00:00Z"), "UTC")).toBe(
      null,
    );
    expect(cardWindowPill(dose, at("2026-11-21T18:00:00Z"), "UTC")).toBe(null);
    expect(cardWindowPill(undefined, at("2026-11-21T14:00:00Z"), "UTC")).toBe(
      null,
    );
  });
});

describe("cardDoseStatus", () => {
  it("reads the older vocabulary at the clock", () => {
    expect(cardDoseStatus(dose, at("2026-11-21T14:00:00Z"))).toBe(
      "on_time_window",
    );
    expect(cardDoseStatus(dose, at("2026-11-21T18:00:00Z"))).toBe("missed");
    expect(
      cardDoseStatus(
        { ...dose, state: "taken", takenLate: true },
        at("2026-11-21T18:00:00Z"),
      ),
    ).toBe("taken_late");
    expect(cardDoseStatus(undefined, at("2026-11-21T14:00:00Z"))).toBe(
      "upcoming",
    );
  });
});

describe("cardDisplayedSlot", () => {
  const tomorrow = "2026-11-22T13:59:00.000Z";

  it("records the open slot while due, overdue or missed", () => {
    for (const now of ["14:10", "15:30", "18:30"]) {
      expect(
        cardDisplayedSlot(dose, tomorrow, at(`2026-11-21T${now}:00Z`)),
      ).toEqual(at(SLOT));
    }
  });

  it("records the next due slot otherwise, and nothing without either", () => {
    const pending = { ...dose, state: "upcoming" };
    expect(
      cardDisplayedSlot(pending, tomorrow, at("2026-11-21T12:00:00Z")),
    ).toEqual(at(tomorrow));
    expect(cardDisplayedSlot(undefined, null, at("2026-11-21T12:00:00Z"))).toBe(
      null,
    );
  });
});
