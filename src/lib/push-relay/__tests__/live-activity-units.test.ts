import { describe, expect, it } from "vitest";

import {
  ContentStateError,
  doseContentState,
  relayContentState,
} from "@/lib/push-relay/live-activity-content";
import { resolveDoseState } from "@/lib/medications/dose-state/resolve";

const NOW = 1_795_000_000;
const ok = {
  status: "due",
  countdownTarget: NOW + 600,
  isOverdue: false,
  confirmed: false,
  pendingConfirm: false,
  timeFormatRaw: "AUTO",
};

describe("the relay content-state template", () => {
  it("passes exactly the six keys", () => {
    expect(relayContentState(ok, NOW)).toEqual(ok);
    expect(relayContentState({ ...ok, countdownTarget: 0 }, NOW)).toBeTruthy();
  });

  it.each([
    ["a name", { ...ok, medicationName: "Metformin" }],
    ["a missing key", { ...ok, pendingConfirm: undefined }],
    ["free text as status", { ...ok, status: "Take 2 Metformin" }],
    ["a time format outside the set", { ...ok, timeFormatRaw: "24h" }],
    ["a countdown too far ahead", { ...ok, countdownTarget: NOW + 72 * 3600 }],
    ["a countdown too old", { ...ok, countdownTarget: NOW - 25 * 3600 }],
    ["a fractional countdown", { ...ok, countdownTarget: NOW + 0.5 }],
    ["a string flag", { ...ok, isOverdue: "false" }],
  ])("refuses %s", (_label, state) => {
    const input = JSON.parse(JSON.stringify(state));
    expect(() => relayContentState(input, NOW)).toThrow(ContentStateError);
  });
});

describe("the state of a dose", () => {
  const at = (s: number) => new Date(s * 1000);
  // A stored custom window: open from 30 min before the slot to 3 h after,
  // then the daily late tail. A fixed 30-minute grace knows none of it.
  const SLOT = NOW + 3600;
  const band = {
    at: at(SLOT),
    earlyStart: at(SLOT - 5400),
    onTimeStart: at(SLOT - 1800),
    onTimeEnd: at(SLOT + 3 * 3600),
    overdueEnd: at(SLOT + 6 * 3600),
  };
  const dueAt = SLOT - 1800;
  const overdueSince = SLOT + 3 * 3600;
  const missedAfter = SLOT + 6 * 3600;
  const stateAt = (
    s: number,
    outcome: Parameters<typeof resolveDoseState>[1] = null,
    snoozedUntil: Date | null = null,
  ) =>
    doseContentState(
      { resolved: resolveDoseState(band, outcome, at(s)), snoozedUntil },
      "H24",
      at(s),
    );

  it("follows the medication's own window, not a fixed grace", () => {
    // 45 minutes past the slot: on time by the stored window.
    expect(stateAt(SLOT + 45 * 60)).toEqual({
      status: "due",
      countdownTarget: overdueSince,
      isOverdue: false,
      confirmed: false,
      pendingConfirm: false,
      timeFormatRaw: "H24",
    });
  });

  it("changes exactly at the band's boundaries", () => {
    expect(stateAt(dueAt - 1)).toMatchObject({
      status: "pending",
      countdownTarget: dueAt,
      isOverdue: false,
    });
    expect(stateAt(dueAt)).toMatchObject({
      status: "due",
      countdownTarget: overdueSince,
    });
    expect(stateAt(overdueSince)).toMatchObject({ status: "due" });
    expect(stateAt(overdueSince + 1)).toMatchObject({
      status: "overdue",
      countdownTarget: overdueSince,
      isOverdue: true,
    });
    expect(stateAt(missedAfter)).toMatchObject({ status: "overdue" });
    // Missed: nothing left to show, the Activity ends.
    expect(stateAt(missedAfter + 1)).toBeNull();
    expect(
      stateAt(SLOT, { takenAt: null, skipped: false, autoMissed: true }),
    ).toBeNull();
  });

  it("is taken, skipped and snoozed from the slot's own record", () => {
    expect(
      stateAt(SLOT + 60, { takenAt: at(SLOT), skipped: false }),
    ).toMatchObject({ status: "taken", countdownTarget: 0, confirmed: true });
    expect(
      stateAt(overdueSince + 600, {
        takenAt: at(overdueSince + 60),
        skipped: false,
      }),
    ).toMatchObject({ status: "taken", confirmed: true });
    expect(stateAt(SLOT, { takenAt: null, skipped: true })).toMatchObject({
      status: "skipped",
      countdownTarget: 0,
    });
    expect(stateAt(SLOT, null, at(SLOT + 600))).toMatchObject({
      status: "snoozed",
      countdownTarget: SLOT + 600,
      isOverdue: false,
    });
    // A snooze that ran out no longer holds the dose.
    expect(stateAt(SLOT, null, at(SLOT - 1))).toMatchObject({ status: "due" });
  });
});
