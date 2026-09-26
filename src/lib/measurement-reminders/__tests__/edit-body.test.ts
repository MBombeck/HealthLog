import { describe, expect, it } from "vitest";

import { changedReminderFields, type ReminderEditBody } from "../edit-body";

const BASE: ReminderEditBody = {
  label: "Skin check",
  measurementType: null,
  intervalDays: 365,
  rrule: null,
  anchorDate: "2026-01-09T23:00:00.000Z",
  notifyHour: 9,
  location: null,
};

describe("changedReminderFields", () => {
  it("sends only what the edit changed", () => {
    expect(
      changedReminderFields(BASE, { ...BASE, label: "Dermatology" }),
    ).toEqual({ label: "Dermatology" });
  });

  it("sends nothing for an untouched form, so a save moves no date", () => {
    expect(changedReminderFields(BASE, { ...BASE })).toEqual({});
  });

  it("sends the cadence as a pair, since the two are mutually exclusive", () => {
    expect(
      changedReminderFields(BASE, {
        ...BASE,
        intervalDays: null,
        rrule: "FREQ=YEARLY",
      }),
    ).toEqual({ intervalDays: null, rrule: "FREQ=YEARLY" });
  });

  it("sends a changed first due date and notify hour", () => {
    expect(
      changedReminderFields(BASE, {
        ...BASE,
        anchorDate: "2026-02-01T23:00:00.000Z",
        notifyHour: 18,
      }),
    ).toEqual({ anchorDate: "2026-02-01T23:00:00.000Z", notifyHour: 18 });
  });
});
