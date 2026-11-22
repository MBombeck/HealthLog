/**
 * A day total of 0 is a real total; an instantaneous reading of 0 is not.
 *
 * When every sample of a day is deleted in Apple Health, the iPhone app sends
 * that day's `stats:` total once more with `value: 0`, so the old total does
 * not stay on the server (iOS #191). The batch route checks every value
 * against `VALUE_RANGES`, so a cumulative type whose band started above 0
 * would answer `value_out_of_range` and keep the stale total. The reverse
 * holds for a reading taken at an instant: a heart rate of 0 is a sensor
 * fault, and its band must keep refusing it.
 */
import { describe, expect, it } from "vitest";

import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { VALUE_RANGES } from "@/lib/measurements/value-ranges";

/** Readings taken at an instant, where 0 is never a measurement. */
const INSTANTANEOUS = [
  "PULSE",
  "RESTING_HEART_RATE",
  "WALKING_HEART_RATE_AVERAGE",
  "AVERAGE_HEART_RATE",
  "MAX_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "HRV_RMSSD",
  "OXYGEN_SATURATION",
  "RESPIRATORY_RATE",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "BLOOD_GLUCOSE",
  "BODY_TEMPERATURE",
  "WRIST_TEMPERATURE",
  "WEIGHT",
  "VO2_MAX",
] as const;

describe("day totals of 0", () => {
  it.each([...CUMULATIVE_HK_TYPES])(
    "%s: a cumulative day total admits 0",
    (type) => {
      const band = VALUE_RANGES[type];
      expect(band, `${type} declares a band`).toBeDefined();
      expect(band!.min).toBe(0);
    },
  );

  it.each(INSTANTANEOUS)("%s: an instantaneous reading refuses 0", (type) => {
    expect(CUMULATIVE_HK_TYPES.has(type)).toBe(false);
    expect(VALUE_RANGES[type]!.min).toBeGreaterThan(0);
  });
});
