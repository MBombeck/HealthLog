import { describe, expect, it } from "vitest";
import { getPRDirection, isPRTrackable } from "../pr-direction";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  PersonalRecordDirection,
  type MeasurementType,
} from "@/generated/prisma/client";

describe("getPRDirection", () => {
  // Drift guard — every canonical MeasurementType MUST land in exactly
  // one branch of the switch so the future detection worker never
  // encounters an "I have a sample but no direction" race.
  it("returns either MAX, MIN, or null for every MeasurementType", () => {
    for (const type of measurementTypeEnum.options) {
      const result = getPRDirection(type as MeasurementType);
      expect(
        result === null ||
          result === PersonalRecordDirection.MAX ||
          result === PersonalRecordDirection.MIN,
        `getPRDirection(${type}) returned ${result}`,
      ).toBe(true);
    }
  });

  it("returns MAX for the activity + daylight + 'higher is better' metrics", () => {
    const maxMetrics: MeasurementType[] = [
      "ACTIVITY_STEPS",
      "ACTIVE_ENERGY_BURNED",
      "FLIGHTS_CLIMBED",
      "WALKING_RUNNING_DISTANCE",
      "VO2_MAX",
      "HEART_RATE_VARIABILITY",
      "TOTAL_BODY_WATER",
      "BONE_MASS",
      "MUSCLE_MASS",
      "TIME_IN_DAYLIGHT",
    ];
    for (const t of maxMetrics) {
      expect(getPRDirection(t)).toBe(PersonalRecordDirection.MAX);
    }
  });

  it("returns MIN for resting HR + composition + cardiovascular-risk + audio", () => {
    const minMetrics: MeasurementType[] = [
      "RESTING_HEART_RATE",
      "BODY_FAT",
      "FAT_MASS",
      "VISCERAL_FAT",
      "VASCULAR_AGE",
      "PULSE_WAVE_VELOCITY",
      "AUDIO_EXPOSURE_ENV",
      "AUDIO_EXPOSURE_HEADPHONE",
    ];
    for (const t of minMetrics) {
      expect(getPRDirection(t)).toBe(PersonalRecordDirection.MIN);
    }
  });

  it("returns null for BP, glucose, weight, sleep, and homeostatic vitals", () => {
    const noPRMetrics: MeasurementType[] = [
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "BLOOD_GLUCOSE",
      "BODY_TEMPERATURE",
      "SKIN_TEMPERATURE",
      "PULSE",
      "OXYGEN_SATURATION",
      "WEIGHT",
      "SLEEP_DURATION",
      "FAT_FREE_MASS",
    ];
    for (const t of noPRMetrics) {
      expect(getPRDirection(t)).toBeNull();
    }
  });
});

describe("isPRTrackable", () => {
  it("returns true exactly when getPRDirection is non-null", () => {
    for (const type of measurementTypeEnum.options) {
      const t = type as MeasurementType;
      expect(isPRTrackable(t)).toBe(getPRDirection(t) !== null);
    }
  });
});
