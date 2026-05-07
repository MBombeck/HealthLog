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
] as const;

describe("measurementTypeEnum coverage", () => {
  it("exposes the 11 canonical measurement types", () => {
    expect([...measurementTypeEnum.options].sort()).toEqual(
      [...EXPECTED_TYPES].sort(),
    );
  });

  // Documented exclusions from the doctor-report main vitals table:
  //  - BLOOD_GLUCOSE renders through the per-context `glucoseStats` section
  //  - SLEEP_DURATION + ACTIVITY_STEPS are intentionally omitted from the
  //    clinical PDF (lifestyle, not a vital sign — see source comment).
  // Updates to this set MUST be paired with a comment in
  // doctor-report-pdf-core.ts so the rationale stays discoverable.
  const PDF_VITAL_EXCLUSIONS = new Set([
    "BLOOD_GLUCOSE",
    "SLEEP_DURATION",
    "ACTIVITY_STEPS",
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
