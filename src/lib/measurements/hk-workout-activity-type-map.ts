/**
 * `HKWorkoutActivityType` → HealthLog `WorkoutSportType` lookup table.
 *
 * Apple's `HKWorkoutActivityType` is an `NS_ENUM(NSUInteger, ...)` with
 * 75+ members at iOS 18. Only the canonical roster surfaced by the
 * Health app export (`workoutActivityType="HKWorkoutActivityType*"`)
 * gets a first-class entry here; anything outside the table falls
 * through to `"other"` — the escape hatch already on the
 * `workoutSportTypeEnum` union in `src/lib/validations/workout.ts`.
 *
 * Adding a new sport: append the literal to `workoutSportTypeEnum`,
 * then add the HK activity-type entry here. The unit test under
 * `__tests__/hk-workout-activity-type-map.test.ts` enforces that every
 * value referenced here exists in the canonical union.
 *
 * Source: Apple's `HealthKit/HKWorkoutActivityType.h` header (iOS 18
 * SDK) cross-checked against the activity strings observed in
 * open-source Apple Health export corpora — `apple-health-grafana`,
 * `healthkit-to-sqlite`, `apple-health-parser`. Locked per
 * `.planning/research/v1434-r-1-xml-import.md` §7.
 */
import type { WorkoutSportType } from "@/lib/validations/workout";

/**
 * Map every known `HKWorkoutActivityType` value (the literal string
 * Apple writes to `Workout.workoutActivityType` in `export.xml`) to a
 * HealthLog sport-type union member. Unknown identifiers fall through
 * to `"other"` at the call site; the parser increments the
 * `workouts.unknownActivityType` counter so operators can spot new
 * iOS releases that introduce a sport this table does not know yet.
 */
export const HK_WORKOUT_ACTIVITY_TYPE_MAP: Record<string, WorkoutSportType> = {
  // ── Endurance ───────────────────────────────────────────────
  HKWorkoutActivityTypeWalking: "walking",
  HKWorkoutActivityTypeRunning: "running",
  HKWorkoutActivityTypeCycling: "cycling",
  HKWorkoutActivityTypeHiking: "hiking",
  HKWorkoutActivityTypeSwimming: "swimming",
  HKWorkoutActivityTypeSwimBikeRun: "crossTraining",
  HKWorkoutActivityTypeRowing: "rowing",
  HKWorkoutActivityTypeElliptical: "elliptical",
  HKWorkoutActivityTypeStairClimbing: "stairClimber",
  HKWorkoutActivityTypeStairs: "stairClimber",
  HKWorkoutActivityTypeStepTraining: "stairClimber",

  // ── Mind & body ─────────────────────────────────────────────
  HKWorkoutActivityTypeYoga: "yoga",
  HKWorkoutActivityTypeMindAndBody: "mindAndBody",
  HKWorkoutActivityTypeFlexibility: "mindAndBody",
  HKWorkoutActivityTypePilates: "mindAndBody",
  HKWorkoutActivityTypeTaiChi: "mindAndBody",
  HKWorkoutActivityTypeBarre: "mindAndBody",
  HKWorkoutActivityTypeCooldown: "mindAndBody",
  HKWorkoutActivityTypePreparationAndRecovery: "mindAndBody",

  // ── Strength ────────────────────────────────────────────────
  HKWorkoutActivityTypeFunctionalStrengthTraining: "strength",
  HKWorkoutActivityTypeTraditionalStrengthTraining: "strength",
  HKWorkoutActivityTypeCoreTraining: "strength",
  HKWorkoutActivityTypeKickboxing: "strength",
  HKWorkoutActivityTypeMartialArts: "strength",

  // ── High intensity / mixed ─────────────────────────────────
  HKWorkoutActivityTypeHighIntensityIntervalTraining: "hiit",
  HKWorkoutActivityTypeCrossTraining: "crossTraining",
  HKWorkoutActivityTypeMixedCardio: "mixedCardio",
  HKWorkoutActivityTypeMixedMetabolicCardioTraining: "mixedCardio",
  HKWorkoutActivityTypeJumpRope: "hiit",

  // ── Dance ───────────────────────────────────────────────────
  HKWorkoutActivityTypeDance: "dance",
  HKWorkoutActivityTypeDanceInspiredTraining: "dance",
  HKWorkoutActivityTypeSocialDance: "dance",
  HKWorkoutActivityTypeCardioDance: "dance",

  // ── Field & ball sports ─────────────────────────────────────
  HKWorkoutActivityTypeGolf: "golf",
  HKWorkoutActivityTypeTennis: "tennis",
  HKWorkoutActivityTypeBasketball: "basketball",
  HKWorkoutActivityTypeSoccer: "soccer",
  HKWorkoutActivityTypeAmericanFootball: "soccer",
  HKWorkoutActivityTypeAustralianFootball: "soccer",
  HKWorkoutActivityTypeRugby: "soccer",
  HKWorkoutActivityTypeBaseball: "tennis",
  HKWorkoutActivityTypeCricket: "tennis",
  HKWorkoutActivityTypeBadminton: "tennis",
  HKWorkoutActivityTypeRacquetball: "tennis",
  HKWorkoutActivityTypeSquash: "tennis",
  HKWorkoutActivityTypeTableTennis: "tennis",
  HKWorkoutActivityTypeVolleyball: "tennis",
  HKWorkoutActivityTypeHandball: "tennis",
  HKWorkoutActivityTypeHockey: "tennis",
  HKWorkoutActivityTypeLacrosse: "tennis",
  HKWorkoutActivityTypeSoftball: "tennis",
  HKWorkoutActivityTypePaddleSports: "rowing",
  HKWorkoutActivityTypePickleball: "tennis",

  // ── Snow / ice / water ──────────────────────────────────────
  HKWorkoutActivityTypeDownhillSkiing: "other",
  HKWorkoutActivityTypeCrossCountrySkiing: "other",
  HKWorkoutActivityTypeSnowboarding: "other",
  HKWorkoutActivityTypeSnowSports: "other",
  HKWorkoutActivityTypeSkatingSports: "other",
  HKWorkoutActivityTypeWaterFitness: "swimming",
  HKWorkoutActivityTypeWaterPolo: "swimming",
  HKWorkoutActivityTypeWaterSports: "swimming",
  HKWorkoutActivityTypeSurfingSports: "other",
  HKWorkoutActivityTypeSailing: "other",
  HKWorkoutActivityTypeFishing: "other",

  // ── Wheelchair ──────────────────────────────────────────────
  HKWorkoutActivityTypeWheelchairWalkPace: "walking",
  HKWorkoutActivityTypeWheelchairRunPace: "running",
  HKWorkoutActivityTypeHandCycling: "cycling",

  // ── Misc / catch-all ───────────────────────────────────────
  HKWorkoutActivityTypeBoxing: "strength",
  HKWorkoutActivityTypeFencing: "other",
  HKWorkoutActivityTypeArchery: "other",
  HKWorkoutActivityTypeBowling: "other",
  HKWorkoutActivityTypeClimbing: "other",
  HKWorkoutActivityTypeEquestrianSports: "other",
  HKWorkoutActivityTypeGymnastics: "other",
  HKWorkoutActivityTypeHunting: "other",
  HKWorkoutActivityTypePlay: "other",
  HKWorkoutActivityTypeOther: "other",
};

/**
 * Resolve a `WorkoutSportType` for the given `HKWorkoutActivityType`
 * identifier string. Returns `"other"` and a falsy `known` flag for
 * identifiers outside the table so the call site can increment its
 * `unknownActivityType` counter without losing the row.
 */
export function resolveHkWorkoutSportType(
  activityType: string,
): { sportType: WorkoutSportType; known: boolean } {
  const sportType = HK_WORKOUT_ACTIVITY_TYPE_MAP[activityType];
  if (sportType) return { sportType, known: true };
  return { sportType: "other", known: false };
}
