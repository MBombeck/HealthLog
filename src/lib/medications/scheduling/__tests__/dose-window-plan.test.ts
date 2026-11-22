import { describe, expect, it } from "vitest";

import { intradayDoseWindowPlan } from "../dose-window-plan";

describe("intradayDoseWindowPlan", () => {
  it("states the default band and tail for one dose", () => {
    expect(intradayDoseWindowPlan(["08:00"])).toEqual([
      { timeOfDay: "08:00", onTimeUntil: "09:00", lateUntil: "12:00" },
    ]);
  });

  it("uses an explicit window and caps the tail at the next dose", () => {
    expect(
      intradayDoseWindowPlan(
        ["10:00", "08:00"],
        [{ timeOfDay: "08:00", start: "07:00", end: "08:30" }],
      ),
    ).toEqual([
      // 08:30 + 3 h would be 11:30, but the 10:00 dose opens at 09:00.
      { timeOfDay: "08:00", onTimeUntil: "08:30", lateUntil: "09:00" },
      { timeOfDay: "10:00", onTimeUntil: "11:00", lateUntil: "14:00" },
    ]);
  });

  it("lets the next day's first dose cap a late evening dose", () => {
    expect(intradayDoseWindowPlan(["23:00", "02:30"])).toEqual([
      { timeOfDay: "02:30", onTimeUntil: "03:30", lateUntil: "06:30" },
      // 23:00 + 1 h + 3 h = 03:00, past the next day's 01:30 opening.
      { timeOfDay: "23:00", onTimeUntil: "00:00", lateUntil: "01:30" },
    ]);
  });

  it("ignores unreadable times and answers nothing without times", () => {
    expect(intradayDoseWindowPlan([])).toEqual([]);
    expect(intradayDoseWindowPlan(["nope"])).toEqual([]);
  });
});
