/**
 * MeasurementType → PersonalRecordDirection resolver.
 *
 * Stored vocabulary is `MAX` (higher is the record) or `MIN` (lower is
 * the record). A `null` return value means "this metric does not have
 * a PersonalRecord" — the future detection worker short-circuits on
 * those types so it never writes a row that has ambiguous semantics.
 *
 * Buckets (full rationale in W8d implementation outline §5):
 *
 *   MAX direction:
 *     * Activity & daylight — more is the achievement.
 *     * VO2 max, HRV, fat-free / muscle mass, total body water,
 *       bone mass — biomarkers where a higher value is the goal.
 *
 *   MIN direction:
 *     * Resting heart rate — lower = better cardiovascular fitness.
 *     * Body fat, fat mass, visceral fat — composition metrics
 *       where lower is the goal.
 *     * Vascular age, pulse-wave velocity — lower = healthier
 *       arteries.
 *     * Audio exposure — lower = less hearing damage. The "record"
 *       is the quietest day (kept here for symmetry; the detection
 *       worker can still flag a too-loud day separately).
 *
 *   null (no PR):
 *     * Blood pressure (high reading isn't an achievement; low can
 *       also be clinically bad), blood glucose (extremes both ways),
 *       body & skin temperature (homeostatic, not a goal), pulse
 *       (spot-reading), oxygen saturation (homeostatic), weight
 *       (direction is user-goal-dependent — to defer until the
 *       v1.4.26 worker can read User.thresholdsJson), sleep duration
 *       (longer is not strictly better), fat-free mass when treated
 *       as a derived (weight − fat) value with the same ambiguity.
 *
 * Adding a new MeasurementType: extend the switch below. The
 * drift-guard test in `__tests__/pr-direction.test.ts` asserts every
 * canonical enum value lands in exactly one branch.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { PersonalRecordDirection } from "@/generated/prisma/client";

export function getPRDirection(
  metricType: MeasurementType,
): PersonalRecordDirection | null {
  switch (metricType) {
    // MAX direction — higher value is the record.
    case "ACTIVITY_STEPS":
    case "ACTIVE_ENERGY_BURNED":
    case "FLIGHTS_CLIMBED":
    case "WALKING_RUNNING_DISTANCE":
    case "VO2_MAX":
    case "HEART_RATE_VARIABILITY":
    case "TOTAL_BODY_WATER":
    case "BONE_MASS":
    case "MUSCLE_MASS":
    case "TIME_IN_DAYLIGHT":
      return PersonalRecordDirection.MAX;

    // MIN direction — lower value is the record.
    case "RESTING_HEART_RATE":
    case "BODY_FAT":
    case "FAT_MASS":
    case "VISCERAL_FAT":
    case "VASCULAR_AGE":
    case "PULSE_WAVE_VELOCITY":
    case "AUDIO_EXPOSURE_ENV":
    case "AUDIO_EXPOSURE_HEADPHONE":
      return PersonalRecordDirection.MIN;

    // Explicitly no PersonalRecord — see comment block above.
    case "BLOOD_PRESSURE_SYS":
    case "BLOOD_PRESSURE_DIA":
    case "BLOOD_GLUCOSE":
    case "BODY_TEMPERATURE":
    case "SKIN_TEMPERATURE":
    case "PULSE":
    case "OXYGEN_SATURATION":
    case "WEIGHT":
    case "SLEEP_DURATION":
    case "FAT_FREE_MASS":
      return null;
  }
}

/**
 * Convenience predicate for the future detection worker:
 * `if (!isPRTrackable(type)) return;` keeps the worker from writing
 * rows that wouldn't have a defined direction anyway.
 */
export function isPRTrackable(metricType: MeasurementType): boolean {
  return getPRDirection(metricType) !== null;
}
