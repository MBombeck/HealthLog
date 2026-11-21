import { describe, expect, it } from "vitest";

import {
  ContentStateError,
  doseContentState,
  relayContentState,
} from "@/lib/push-relay/live-activity";

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
  const dose = {
    scheduledFor: at(NOW + 1800),
    takenAt: null,
    skipped: false,
    snoozedUntil: null,
  };
  it("is pending, due, overdue and snoozed in unix seconds", () => {
    expect(doseContentState(dose, "H24", at(NOW))).toMatchObject({
      status: "pending",
      countdownTarget: NOW + 1800,
      timeFormatRaw: "H24",
    });
    expect(doseContentState(dose, null, at(NOW + 1900)).status).toBe("due");
    expect(doseContentState(dose, null, at(NOW + 4000))).toMatchObject({
      status: "overdue",
      isOverdue: true,
    });
    expect(
      doseContentState({ ...dose, snoozedUntil: at(NOW + 600) }, null, at(NOW)),
    ).toMatchObject({ status: "snoozed", countdownTarget: NOW + 600 });
  });
});
