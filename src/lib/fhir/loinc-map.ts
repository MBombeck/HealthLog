/**
 * v1.7.0 — HealthLog `MeasurementType` → FHIR R4 coding (LOINC + UCUM).
 *
 * Per the R-export spec table (§4.2). Types without a stable LOINC fall
 * back to a local `text`-only `CodeableConcept` with the UCUM unit, and
 * the absence of a `loinc` code documents that at the call site.
 *
 * BP is handled specially by the builder (panel 85354-9 with sys/dia
 * components 8480-6 / 8462-4), so the two BP component types are NOT in
 * this single-value map.
 */

export const LOINC_SYSTEM = "http://loinc.org";
export const UCUM_SYSTEM = "http://unitsofmeasure.org";

export type FhirObservationCategory =
  | "vital-signs"
  | "laboratory"
  | "activity";

export interface LoincMapping {
  /** LOINC code, or null when no stable LOINC applies (local text fallback). */
  loinc: string | null;
  display: string;
  /** UCUM unit string (also used as the `code`). */
  unit: string;
  category: FhirObservationCategory;
}

/**
 * Single-value measurement-type mapping. Keyed by `MeasurementType` enum
 * string. BP components are intentionally absent (the builder emits a BP
 * panel). Glucose is handled per-context by the builder using
 * `GLUCOSE_LOINC`.
 */
export const MEASUREMENT_LOINC: Record<string, LoincMapping> = {
  WEIGHT: {
    loinc: "29463-7",
    display: "Body weight",
    unit: "kg",
    category: "vital-signs",
  },
  BODY_MASS_INDEX: {
    loinc: "39156-5",
    display: "Body mass index (BMI) [Ratio]",
    unit: "kg/m2",
    category: "vital-signs",
  },
  PULSE: {
    loinc: "8867-4",
    display: "Heart rate",
    unit: "/min",
    category: "vital-signs",
  },
  RESTING_HEART_RATE: {
    loinc: "40443-4",
    display: "Heart rate --resting",
    unit: "/min",
    category: "vital-signs",
  },
  RESPIRATORY_RATE: {
    loinc: "9279-1",
    display: "Respiratory rate",
    unit: "/min",
    category: "vital-signs",
  },
  BODY_TEMPERATURE: {
    loinc: "8310-5",
    display: "Body temperature",
    unit: "Cel",
    category: "vital-signs",
  },
  OXYGEN_SATURATION: {
    loinc: "59408-5",
    display: "Oxygen saturation in Arterial blood by Pulse oximetry",
    unit: "%",
    category: "vital-signs",
  },
  BODY_FAT: {
    loinc: "41982-0",
    display: "Percentage of body fat Measured",
    unit: "%",
    category: "vital-signs",
  },
  VO2_MAX: {
    loinc: "96402-2",
    display: "Oxygen consumption maximum during exercise",
    unit: "mL/min/kg",
    category: "vital-signs",
  },
  HEART_RATE_VARIABILITY: {
    loinc: "80404-7",
    display: "R-R interval.standard deviation (Heart rate variability)",
    unit: "ms",
    category: "vital-signs",
  },
  ACTIVITY_STEPS: {
    loinc: "41950-7",
    display: "Number of steps in 24 hour Measured",
    unit: "{steps}",
    category: "activity",
  },
  // Stored canonically in MINUTES; the builder converts the emitted value to
  // hours so it matches the UCUM `h` unit (and the iOS table). PDF unaffected.
  SLEEP_DURATION: {
    loinc: "93832-4",
    display: "Sleep duration",
    unit: "h",
    category: "activity",
  },
  ACTIVE_ENERGY_BURNED: {
    loinc: "41981-2",
    display: "Calories burned",
    unit: "kcal",
    category: "activity",
  },
  WALKING_SPEED: {
    loinc: "41957-2",
    display: "Gait speed [Velocity] Measured",
    unit: "m/s",
    category: "vital-signs",
  },
  WALKING_ASYMMETRY: {
    loinc: "91557-1",
    display: "Walking asymmetry percentage",
    unit: "%",
    category: "vital-signs",
  },
  WALKING_STEP_LENGTH: {
    loinc: "41955-6",
    display: "Step length Measured",
    unit: "m",
    category: "vital-signs",
  },
  // Body-composition family with iOS-locked LOINC codes.
  TOTAL_BODY_WATER: {
    loinc: "73704-9",
    display: "Body water by Bioelectrical impedance analysis",
    unit: "kg",
    category: "vital-signs",
  },
  BONE_MASS: {
    loinc: "73708-0",
    display: "Bone mineral content by DXA",
    unit: "kg",
    category: "vital-signs",
  },
  // HK-placeholder codes — no published LOINC term. iOS emits the HealthKit
  // identifier STRING as the `code` (in the LOINC system slot); the server
  // must emit the identical placeholder, not invent a LOINC. The `loinc`
  // field below carries that placeholder string verbatim.
  WALKING_DOUBLE_SUPPORT: {
    loinc: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
    display: "Walking double support percentage",
    unit: "%",
    category: "vital-signs",
  },
  AUDIO_EXPOSURE_ENV: {
    loinc: "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
    display: "Environmental audio exposure",
    unit: "dB[A]",
    category: "vital-signs",
  },
  AUDIO_EXPOSURE_HEADPHONE: {
    loinc: "HKQuantityTypeIdentifierHeadphoneAudioExposure",
    display: "Headphone audio exposure",
    unit: "dB[A]",
    category: "vital-signs",
  },
  FLIGHTS_CLIMBED: {
    loinc: "HKQuantityTypeIdentifierFlightsClimbed",
    display: "Flights climbed",
    unit: "{flights}",
    category: "activity",
  },
  WALKING_RUNNING_DISTANCE: {
    loinc: "HKQuantityTypeIdentifierDistanceWalkingRunning",
    display: "Distance walking/running",
    unit: "m",
    category: "activity",
  },
  TIME_IN_DAYLIGHT: {
    loinc: "HKQuantityTypeIdentifierTimeInDaylight",
    display: "Time in daylight",
    unit: "min",
    category: "activity",
  },
  MUSCLE_MASS: {
    loinc: null,
    display: "Muscle mass",
    unit: "kg",
    category: "vital-signs",
  },
  FAT_MASS: {
    loinc: null,
    display: "Fat mass",
    unit: "kg",
    category: "vital-signs",
  },
  FAT_FREE_MASS: {
    loinc: null,
    display: "Fat-free mass",
    unit: "kg",
    category: "vital-signs",
  },
  LEAN_BODY_MASS: {
    loinc: null,
    display: "Lean body mass",
    unit: "kg",
    category: "vital-signs",
  },
  VISCERAL_FAT: {
    loinc: null,
    display: "Visceral fat",
    unit: "1",
    category: "vital-signs",
  },
};

/** BP panel + component LOINC codes. */
export const BP_PANEL_LOINC = "85354-9";
export const BP_SYS_LOINC = "8480-6";
export const BP_DIA_LOINC = "8462-4";
export const BP_UNIT = "mm[Hg]";

/**
 * Per-context glucose LOINC, byte-aligned to the iOS table:
 * - random / unspecified / bedtime → 2339-0 (Glucose in Blood)
 * - fasting / beforeMeal           → 1558-6 (Fasting glucose in Serum/Plasma)
 * - afterMeal (POSTPRANDIAL)        → 1521-4 (Glucose in Serum/Plasma 2h post meal)
 *
 * The server's `GlucoseContext` enum has no separate beforeMeal/afterMeal; its
 * POSTPRANDIAL value is the afterMeal case and maps to 1521-4.
 */
export const GLUCOSE_LOINC: Record<string, { loinc: string; display: string }> =
  {
    FASTING: {
      loinc: "1558-6",
      display: "Fasting glucose [Mass/volume] in Serum or Plasma",
    },
    POSTPRANDIAL: {
      loinc: "1521-4",
      display: "Glucose [Mass/volume] in Serum or Plasma --2 hours post meal",
    },
    RANDOM: { loinc: "2339-0", display: "Glucose [Mass/volume] in Blood" },
    BEDTIME: { loinc: "2339-0", display: "Glucose [Mass/volume] in Blood" },
  };

/** Medication-adherence Observation LOINC. */
export const MEDICATION_ADHERENCE_LOINC = "71799-1";
/** Mood Observation LOINC (opt-in only). */
export const MOOD_LOINC = "76542-6";
