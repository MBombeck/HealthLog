import { describe, expect, it } from "vitest";

import {
  HOURLY_MEAN_DAY_TYPES,
  usesHourlyMeanDay,
  windowWeighting,
} from "../day-statistic";

describe("which types a day is the mean of the hours' means for", () => {
  it("is pulse, and only pulse", () => {
    expect([...HOURLY_MEAN_DAY_TYPES]).toEqual(["PULSE"]);
  });

  it.each(["PULSE"])(
    "%s uses the hourly mean and weighs each day once",
    (type) => {
      expect(usesHourlyMeanDay(type)).toBe(true);
      expect(windowWeighting(type)).toBe("day");
    },
  );

  // A CGM samples at a fixed rate, so glucose has no activity bias. HRV and
  // SpO2 may follow once the effect is shown on real data. Cumulative types sum.
  it.each([
    "BLOOD_GLUCOSE",
    "HEART_RATE_VARIABILITY",
    "OXYGEN_SATURATION",
    "RESTING_HEART_RATE",
    "WEIGHT",
    "ACTIVITY_STEPS",
    "HRV_RMSSD",
  ])("%s keeps the plain mean and weighs each day by its readings", (type) => {
    expect(usesHourlyMeanDay(type)).toBe(false);
    expect(windowWeighting(type)).toBe("count");
  });
});
