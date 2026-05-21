/**
 * Blood-glucose unit conversions.
 *
 * HealthLog stores glucose canonically in **mg/dL**. The UI can display in
 * mmol/L for users who prefer that (SI-unit countries). Conversion factor is
 * 18.0182 (per DGIM / DDG S3 guideline). We round to clinically meaningful
 * precision: 0 fractional digits for mg/dL, 1 for mmol/L.
 */

export type GlucoseUnit = "mg/dL" | "mmol/L";

const MGDL_PER_MMOL = 18.0182;

export function mgdlToMmol(mgdl: number): number {
  return Math.round((mgdl / MGDL_PER_MMOL) * 10) / 10;
}

export function convertGlucose(value: number, to: GlucoseUnit): number {
  return to === "mmol/L" ? mgdlToMmol(value) : Math.round(value);
}

export function resolveGlucoseUnit(
  userPreference: string | null | undefined,
): GlucoseUnit {
  return userPreference === "mmol/L" ? "mmol/L" : "mg/dL";
}

/**
 * Threshold metric key corresponding to a glucose context. Keeps the
 * effective-range resolver the single source of truth.
 */
export function thresholdMetricForContext(
  context: "FASTING" | "POSTPRANDIAL" | "RANDOM" | "BEDTIME",
):
  | "BLOOD_GLUCOSE_FASTING"
  | "BLOOD_GLUCOSE_POSTPRANDIAL"
  | "BLOOD_GLUCOSE_RANDOM"
  | "BLOOD_GLUCOSE_BEDTIME" {
  switch (context) {
    case "FASTING":
      return "BLOOD_GLUCOSE_FASTING";
    case "POSTPRANDIAL":
      return "BLOOD_GLUCOSE_POSTPRANDIAL";
    case "RANDOM":
      return "BLOOD_GLUCOSE_RANDOM";
    case "BEDTIME":
      return "BLOOD_GLUCOSE_BEDTIME";
  }
}
