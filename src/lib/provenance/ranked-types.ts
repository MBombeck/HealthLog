/**
 * The measurement types that carry a source-priority ladder, as a plain list
 * the browser can import (the server's `RANKED_TYPES` lives beside SQL
 * builders and the schema library). `ranked-types.test.ts` holds the two
 * lists equal, so the metric picker on the provenance page offers exactly
 * the types the ladder decides for.
 */
export const PROVENANCE_TYPES = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "HRV_RMSSD",
  "RESPIRATORY_RATE",
  "OXYGEN_SATURATION",
  "BODY_TEMPERATURE",
  "SKIN_TEMPERATURE",
  "WEIGHT",
  "BODY_FAT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "VO2_MAX",
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "BODY_BATTERY",
  "STRESS_LEVEL",
  "TRAINING_READINESS",
  "ACUTE_TRAINING_LOAD",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "ACTIVE_ENERGY_BURNED",
  "WALKING_RUNNING_DISTANCE",
  "FLIGHTS_CLIMBED",
] as const;

export type ProvenanceType = (typeof PROVENANCE_TYPES)[number];

export function isProvenanceType(type: string): type is ProvenanceType {
  return (PROVENANCE_TYPES as readonly string[]).includes(type);
}
