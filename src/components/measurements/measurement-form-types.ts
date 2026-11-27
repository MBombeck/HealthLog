/**
 * The measurement entry form's type table: every type the add form offers,
 * its label and its catalogue unit, plus the
 * `?add=<TYPE>` deep-link resolver built on it. Kept apart from the form so
 * the page, the deep-link test and the module gate read it without pulling
 * the form's client graph.
 */
import { isSurfaceVisible, type SurfaceModuleMap } from "@/lib/modules/surface";

/**
 * The width of a sheet that hosts this form with `chain` on a wide screen.
 * "Save and next value" is a long label in most languages, and the pair
 * (`ActionPair`) keeps both buttons as wide as the longer one; at the
 * default 448 px dialog the pair no longer fits beside the "⋯" and stacks.
 */
export const MEASUREMENT_SHEET_WIDTH = "lg" as const;

export const MEASUREMENT_TYPES = [
  {
    value: "BLOOD_PRESSURE",
    labelKey: "measurements.typeBloodPressure",
    unit: "mmHg",
  },
  {
    value: "WEIGHT",
    labelKey: "measurements.typeWeight",
    unit: "kg",
  },
  {
    value: "PULSE",
    labelKey: "measurements.typePulse",
    unit: "bpm",
  },
  // The resting heart rate has its own chart and series; a value read off a
  // watch or taken on waking belongs there rather than among spot pulses.
  {
    value: "RESTING_HEART_RATE",
    labelKey: "measurements.typeRestingHeartRate",
    unit: "bpm",
  },
  {
    value: "BODY_FAT",
    labelKey: "measurements.typeBodyFat",
    unit: "%",
  },
  {
    value: "SLEEP_DURATION",
    labelKey: "measurements.typeSleep",
    unitKey: "measurements.unitHours",
  },
  {
    value: "ACTIVITY_STEPS",
    labelKey: "measurements.typeSteps",
    unitKey: "measurements.unitSteps",
  },
  {
    value: "BLOOD_GLUCOSE",
    labelKey: "measurements.typeBloodGlucose",
    unit: "mg/dL",
  },
  // #1367 — ketones, with the same fingerstick's glucose (one entry).
  {
    value: "BLOOD_KETONES",
    labelKey: "measurements.typeBloodKetones",
    unit: "mmol/L",
  },
  {
    value: "TOTAL_BODY_WATER",
    labelKey: "measurements.typeTotalBodyWater",
    unit: "kg",
  },
  {
    value: "BONE_MASS",
    labelKey: "measurements.typeBoneMass",
    unit: "kg",
  },
  // The rest of what a body-composition scale reports. The server has
  // accepted all of these since the Withings and Apple Health work; only this
  // list lagged, so a reading typed off the scale's display had no row. The
  // guard in `measurement-form-body-composition.test.ts` keeps the two lists
  // from drifting again.
  {
    value: "FAT_MASS",
    labelKey: "measurements.typeFatMass",
    unit: "kg",
  },
  {
    value: "FAT_FREE_MASS",
    labelKey: "measurements.typeFatFreeMass",
    unit: "kg",
  },
  {
    value: "LEAN_BODY_MASS",
    labelKey: "measurements.typeLeanBodyMass",
    unit: "kg",
  },
  {
    value: "MUSCLE_MASS",
    labelKey: "measurements.typeMuscleMass",
    unit: "kg",
  },
  {
    // A scale's own rating (Withings prints 1-12), not a percent.
    value: "VISCERAL_FAT",
    labelKey: "measurements.typeVisceralFat",
    unitKey: "measurements.unitRating",
  },
  {
    value: "OXYGEN_SATURATION",
    labelKey: "measurements.typeOxygenSaturation",
    unit: "%",
  },
  {
    value: "BODY_TEMPERATURE",
    labelKey: "measurements.typeBodyTemperature",
    unit: "°C",
  },
  // Physical / clinical signals. Manual web capture so a web-only
  // self-hoster can log them (the iOS client + measurements API already do).
  {
    value: "WAIST_CIRCUMFERENCE",
    labelKey: "measurements.typeWaistCircumference",
    unit: "cm",
  },
  {
    value: "WAIST_TO_HEIGHT",
    labelKey: "measurements.typeWaistToHeight",
    unitKey: "measurements.unitRatio",
  },
  {
    value: "GRIP_STRENGTH",
    labelKey: "measurements.typeGripStrength",
    unit: "kg",
  },
  {
    value: "PAIN_NRS",
    labelKey: "measurements.typePainNrs",
    unitKey: "measurements.unitScore",
  },
] as const;

// The single source of truth for the `/measurements?add=<TYPE>`
// deep link the Insights empty-state CTAs ship. Derived from the form's
// MEASUREMENT_TYPES so a new row in the form is immediately usable as
// a deep-link target.
export const MEASUREMENT_FORM_TYPE_VALUES = MEASUREMENT_TYPES.map(
  (t) => t.value,
) as readonly string[];

/**
 * The types the form offers for a module map: a type a module owns
 * (`summary:<type>` in the surface map, the same ownership the server gates
 * measurement types on) is left out while that module is off. An unknown map
 * (the account still loading) offers every type.
 */
export function measurementFormTypes(
  modules: SurfaceModuleMap | null | undefined,
): ReadonlyArray<(typeof MEASUREMENT_TYPES)[number]> {
  return MEASUREMENT_TYPES.filter((mt) =>
    isSurfaceVisible(`summary:${mt.value}`, modules),
  );
}

// Legacy / Insights-internal tokens that predate the canonical enum.
// Older empty-state CTAs and a handful of dashboard tiles still emit
// these — translate them to the form's canonical value so the link
// keeps working without forcing every caller to rename in lockstep.
export const ADD_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  GLUCOSE: "BLOOD_GLUCOSE",
  TEMPERATURE: "BODY_TEMPERATURE",
  HEART_RATE: "PULSE",
  BMI: "WEIGHT",
};

/**
 * Resolve a `?add=<token>` deep-link value to a real form type, or
 * `null` when the token has no canonical mapping. Centralised so the
 * page-level dispatcher and the F-1 contract test consume the same
 * resolver.
 */
export function resolveAddToken(
  token: string | null | undefined,
): string | null {
  if (!token) return null;
  const aliased = ADD_TOKEN_ALIASES[token] ?? token;
  return MEASUREMENT_FORM_TYPE_VALUES.includes(aliased) ? aliased : null;
}
