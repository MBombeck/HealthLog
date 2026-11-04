import { describe, it, expect } from "vitest";
import {
  getUnitForType,
  measurementTypeEnum,
} from "@/lib/validations/measurement";
import {
  DOCTOR_REPORT_VITAL_GROUPS,
  DOCTOR_REPORT_TYPE_UNIT_KEYS,
} from "@/lib/doctor-report-pdf-core";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";

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
  // ── v1.4.30 R-F T1.4 + T1.5 ──
  "WALKING_STEADINESS",
  "AUDIO_EXPOSURE_EVENT",
  // ── v1.5.5 iOS-coord — six previously-deferred HK identifiers wired ──
  "RESPIRATORY_RATE",
  "BODY_MASS_INDEX",
  "LEAN_BODY_MASS",
  "WALKING_HEART_RATE_AVERAGE",
  "WALKING_ASYMMETRY",
  "WALKING_DOUBLE_SUPPORT",
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  "WALKING_STEP_LENGTH",
  "WALKING_SPEED",
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  "CARDIO_RECOVERY",
  "WRIST_TEMPERATURE",
  "FALL_COUNT",
  "SIX_MINUTE_WALK_DISTANCE",
  "STAIR_ASCENT_SPEED",
  "STAIR_DESCENT_SPEED",
  "BREATHING_DISTURBANCES",
  // ── v1.10.0 — categorical events (WX-B) ──
  "IRREGULAR_RHYTHM_NOTIFICATION",
  "HIGH_HEART_RATE_EVENT",
  "LOW_HEART_RATE_EVENT",
  "WALKING_STEADINESS_EVENT",
  "BREATHING_DISTURBANCE_EVENT",
  // ── v1.10.0 — computed scores (WX-C) ──
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
  // ── v1.11.0 — WHOOP-native score classes ──
  "HRV_RMSSD",
  "DAY_STRAIN",
  "WORKOUT_STRAIN",
  "SLEEP_PERFORMANCE",
  "SLEEP_EFFICIENCY",
  "SLEEP_CONSISTENCY",
  "SLEEP_NEED",
  "ENERGY_EXPENDITURE_KJ",
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion ──
  "AVERAGE_HEART_RATE",
  "MAX_HEART_RATE",
  "SLEEP_DISTURBANCE_COUNT",
  // ── v1.17.1 — Polar Nightly Recharge + Training Load Pro components ──
  "ANS_CHARGE",
  "CARDIO_LOAD",
  // ── v1.17.1 — Oura coverage completion ──
  "SLEEP_SCORE",
  "BODY_TEMPERATURE_DEVIATION",
  // ── v1.19.0 — Oura resilience (ordinal-encoded level) ──
  "RESILIENCE",
  // ── v1.25 — clinical-signals wave ──
  "PHQ9_SCORE",
  "GAD7_SCORE",
  "GRIP_STRENGTH",
  "PAIN_NRS",
  "WAIST_CIRCUMFERENCE",
  "WAIST_TO_HEIGHT",
  // ── v1.27.9 — screening scores (WHO-5 percentage 0–100, SCI total 0–32;
  // both server-derived from a completed assessment, higher = better) ──
  "WHO5_SCORE",
  "SCI_SCORE",
  // ── v1.44 — Apple Health activity rings, mindfulness, State of Mind and
  // AFib burden ──
  "EXERCISE_MINUTES",
  "STAND_MINUTES",
  "STAND_HOURS",
  "MINDFUL_MINUTES",
  "STATE_OF_MIND_VALENCE",
  "AFIB_BURDEN",
  // ── v1.44 — room climate pushed through the ingest token ──
  "INDOOR_CO2",
  "INDOOR_TEMPERATURE",
  "INDOOR_HUMIDITY",
  // ── Garmin Personal API + bridged training figures ──
  "BODY_BATTERY",
  "STRESS_LEVEL",
  "TRAINING_READINESS",
  "ACUTE_TRAINING_LOAD",
] as const;

describe("measurementTypeEnum coverage", () => {
  it("exposes the 86 canonical measurement types", () => {
    expect([...measurementTypeEnum.options].sort()).toEqual(
      [...EXPECTED_TYPES].sort(),
    );
  });

  // Documented exclusions from the doctor-report main vitals table:
  //  - BLOOD_GLUCOSE renders through the per-context `glucoseStats` section
  //  - ACTIVITY_STEPS is intentionally omitted from the clinical PDF
  //    (lifestyle, not a vital sign — see source comment). SLEEP_DURATION
  //    DOES render in the vitals table (per-night asleep hours), gated on the
  //    default-ON `sleep` section toggle — see doctor-report-pdf-core.ts.
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

  it("doctor-report PDF renders every measurement type, grouped", () => {
    // The table used to be a fixed nine-type whitelist with a documented
    // exclusion list beside it, which meant a user could select resting heart
    // rate, get it in the FHIR bundle and the share view, and not find it in
    // the PDF. It is selection-driven now, so the assertion inverts: every
    // type in the enum appears in exactly one group, and the exclusion list is
    // gone with the whitelist that needed it.
    const rendered = DOCTOR_REPORT_VITAL_GROUPS.flatMap((g) => g.types);
    expect([...rendered].sort()).toEqual(
      [...measurementTypeEnum.options].sort(),
    );
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("doctor-report PDF has a label key for every renderable type", () => {
    for (const group of DOCTOR_REPORT_VITAL_GROUPS) {
      for (const type of group.types) {
        expect(
          MEASUREMENT_TYPE_LABEL_KEYS[type],
          `missing label key for ${type}`,
        ).toBeTruthy();
      }
    }
  });

  it("doctor-report PDF resolves a unit or honestly none for every type", () => {
    // A type with no recorded unit prints none. An absent unit is absent, not
    // the word "unknown" beside a clinical number.
    for (const group of DOCTOR_REPORT_VITAL_GROUPS) {
      for (const type of group.types) {
        const unit = DOCTOR_REPORT_TYPE_UNIT_KEYS[type] ?? getUnitForType(type);
        expect(typeof unit === "string" || unit === null).toBe(true);
      }
    }
  });
});
