import { describe, it, expect } from "vitest";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  DOCTOR_REPORT_VITAL_TYPES,
  DOCTOR_REPORT_TYPE_LABEL_KEYS,
  DOCTOR_REPORT_TYPE_UNIT_KEYS,
} from "@/lib/doctor-report-pdf-core";

// Single source of truth for which measurement types exist.
// V3 audit "enum drift cousins": 7 module-level hardcoded arrays were
// silently dropping new types (SpO2, TBW, BoneMass, BloodGlucose) from
// dashboard / analytics / AI insights / iOS adapters / import.
//
// All ingest, analytics and reporting paths are now derived from
// `measurementTypeEnum.options`, so adding a new type only needs touching
// the enum. This test asserts that contract.
const EXPECTED_TYPES = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "BLOOD_GLUCOSE",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "OXYGEN_SATURATION",
  // ── v1.4.23 Apple Health additions ──
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "ACTIVE_ENERGY_BURNED",
  "FLIGHTS_CLIMBED",
  "WALKING_RUNNING_DISTANCE",
  "VO2_MAX",
  "BODY_TEMPERATURE",
  // ── v1.4.25 W5d Withings full coverage ──
  "FAT_FREE_MASS",
  "FAT_MASS",
  "MUSCLE_MASS",
  "SKIN_TEMPERATURE",
  "PULSE_WAVE_VELOCITY",
  "VASCULAR_AGE",
  "VISCERAL_FAT",
  // ── v1.4.25 W8d Apple Health server-prep ──
  "AUDIO_EXPOSURE_ENV",
  "AUDIO_EXPOSURE_HEADPHONE",
  "TIME_IN_DAYLIGHT",
] as const;

describe("measurementTypeEnum coverage", () => {
  it("exposes the 28 canonical measurement types", () => {
    expect([...measurementTypeEnum.options].sort()).toEqual(
      [...EXPECTED_TYPES].sort(),
    );
  });

  // Documented exclusions from the doctor-report main vitals table:
  //  - BLOOD_GLUCOSE renders through the per-context `glucoseStats` section
  //  - SLEEP_DURATION + ACTIVITY_STEPS are intentionally omitted from the
  //    clinical PDF (lifestyle, not a vital sign — see source comment).
  //  - v1.4.23 Apple Health metrics (HRV, resting HR, active energy,
  //    flights, distance, VO2 max, body temperature) are excluded from
  //    the v1.4.23 release of the doctor PDF — they ship into the
  //    clinical surface alongside the iOS app's first paying-customer
  //    sync in v1.5 once layout + reference ranges are agreed.
  //  - v1.4.25 Withings additions (fat-free / fat / muscle mass, skin
  //    temperature, pulse-wave velocity, vascular age, visceral fat) are
  //    held under the same v1.5 gate. Body composition + cardiovascular
  //    risk markers warrant their own clinical layout (reference ranges
  //    differ by sex/age) which lands with the iOS-app clinical surface.
  // Updates to this set MUST be paired with a comment in
  // doctor-report-pdf-core.ts so the rationale stays discoverable.
  const PDF_VITAL_EXCLUSIONS = new Set([
    "BLOOD_GLUCOSE",
    "SLEEP_DURATION",
    "ACTIVITY_STEPS",
    "HEART_RATE_VARIABILITY",
    "RESTING_HEART_RATE",
    "ACTIVE_ENERGY_BURNED",
    "FLIGHTS_CLIMBED",
    "WALKING_RUNNING_DISTANCE",
    "VO2_MAX",
    "BODY_TEMPERATURE",
    "FAT_FREE_MASS",
    "FAT_MASS",
    "MUSCLE_MASS",
    "SKIN_TEMPERATURE",
    "PULSE_WAVE_VELOCITY",
    "VASCULAR_AGE",
    "VISCERAL_FAT",
    // v1.4.25 W8d Apple Health additions held under the same v1.5 gate.
    // Audio exposure and time-in-daylight are lifestyle / environment
    // metrics; reference ranges + clinical layout land alongside the
    // first iOS-app sync, not the v1.4.25 PDF.
    "AUDIO_EXPOSURE_ENV",
    "AUDIO_EXPOSURE_HEADPHONE",
    "TIME_IN_DAYLIGHT",
  ]);

  it("doctor-report PDF vital types cover the canonical enum minus documented exclusions", () => {
    const expected = measurementTypeEnum.options.filter(
      (t) => !PDF_VITAL_EXCLUSIONS.has(t),
    );
    expect([...DOCTOR_REPORT_VITAL_TYPES].sort()).toEqual([...expected].sort());
  });

  it("doctor-report PDF has a label key for every renderable type", () => {
    for (const type of DOCTOR_REPORT_VITAL_TYPES) {
      expect(
        DOCTOR_REPORT_TYPE_LABEL_KEYS[type],
        `missing label key for ${type}`,
      ).toBeTruthy();
    }
  });

  it("doctor-report PDF has a unit key for every renderable type", () => {
    for (const type of DOCTOR_REPORT_VITAL_TYPES) {
      const unit = DOCTOR_REPORT_TYPE_UNIT_KEYS[type];
      expect(
        unit === null || (typeof unit === "string" && unit.length > 0),
        `missing unit for ${type}`,
      ).toBe(true);
    }
  });
});
