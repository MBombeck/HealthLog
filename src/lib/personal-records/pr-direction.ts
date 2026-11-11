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
 *       (spot-reading), oxygen saturation (homeostatic), sleep duration
 *       (longer is not strictly better), fat-free mass when treated
 *       as a derived (weight − fat) value with the same ambiguity.
 *
 *   user-goal direction (v1.34):
 *     * Weight and BMI have no intrinsic direction, which is why they
 *       returned `null` from v1.5.5 until now. They do have the user's
 *       OWN direction once a weight target exists in
 *       `User.thresholdsJson`, so the resolver takes a context carrying
 *       it and answers MIN / MAX accordingly. No target, or a reading
 *       already inside the band, still returns `null` — the direction is
 *       read off the person's stated goal, never guessed from height.
 *
 * Adding a new MeasurementType: extend the switch below. The
 * drift-guard test in `__tests__/pr-direction.test.ts` asserts every
 * canonical enum value lands in exactly one branch.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { PersonalRecordDirection } from "@/generated/prisma/client";
import { weightTargetPosition } from "@/lib/targets/weight-trend";

/**
 * v1.34 — the user-goal facts the resolver needs for the goal-dependent
 * metrics. Everything else in the switch is goal-independent and ignores it.
 */
export interface PRDirectionContext {
  /**
   * Which way the user's OWN weight target points, resolved by
   * `resolveWeightGoalDirection` from `User.thresholdsJson` plus their latest
   * reading. `null` when no target is set, the reading is missing, or the
   * reading already sits inside the band — in all three cases weight and BMI
   * keep the historical "no record direction" answer.
   */
  weightGoal: "lower" | "higher" | null;
}

/**
 * Resolve the weight goal direction from the user's own target band and their
 * latest weight.
 *
 * Above the band → the goal is downward → the record is the lowest reading.
 * Below the band → upward. Inside the band → no direction: the person is where
 * they said they wanted to be, and neither end of the scale is an achievement
 * from there. No target → no direction, because inferring one from height or
 * population norms is the fabrication this release removes.
 *
 * Pure; the worker owns the reads.
 */
export function resolveWeightGoalDirection(
  target: { min: number; max: number } | null,
  latestWeightKg: number | null,
): "lower" | "higher" | null {
  // Same placement the weight tile's trend colour reads, so a record and an
  // arrow can never disagree about which side of the target a person is on.
  const position = weightTargetPosition(target, latestWeightKg);
  if (position === "above") return "lower";
  if (position === "below") return "higher";
  return null;
}

export function getPRDirection(
  metricType: MeasurementType,
  context: PRDirectionContext,
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
    // v1.44 — the activity rings: more exercise, standing and mindful
    // minutes (and more stood hours) are the goal, as Apple frames them.
    case "EXERCISE_MINUTES":
    case "STAND_MINUTES":
    case "STAND_HOURS":
    case "MINDFUL_MINUTES":
    // v1.4.30 — walking steadiness on a 0-100 scale; Apple's own
    // Mobility section treats higher as the achievement (the
    // recovery direction from a low-steadiness window).
    case "WALKING_STEADINESS":
    // v1.5.5 — lean body mass is the muscle-mass-adjacent body-comp
    // axis where higher is the goal.
    case "LEAN_BODY_MASS":
    // v1.5.5 — walking speed is a well-established
    // clinical fitness marker (often called the "sixth vital
    // sign" in older-adult medicine); faster gait correlates
    // with cardiovascular fitness, sarcopenia recovery, and
    // overall mobility resilience. MAX direction matches Apple's
    // own Mobility-section framing.
    case "WALKING_SPEED":
    // v1.10.0 — cardio recovery (a larger one-minute HR drop is the
    // fitter result), six-minute-walk distance (the classic endurance
    // achievement), and the stair gait speeds (faster climb/descent =
    // more leg strength + mobility) all read MAX.
    case "CARDIO_RECOVERY":
    case "SIX_MINUTE_WALK_DISTANCE":
    case "STAIR_ASCENT_SPEED":
    case "STAIR_DESCENT_SPEED":
    // v1.25 — grip strength is a clean strength-achievement axis (higher is the
    // record), the strength limb of the EWGSOP2 sarcopenia algorithm.
    case "GRIP_STRENGTH":
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
    // v1.5.5 — gait asymmetry + double-support percentages: Apple's
    // Mobility section frames lower as the achievement (more
    // symmetric gait + shorter double-support fraction = healthier).
    case "WALKING_ASYMMETRY":
    case "WALKING_DOUBLE_SUPPORT":
    // v1.10.0 — fall count and the sleep-breathing-disturbance index
    // both read MIN: the "record" is the day/night with the fewest
    // events, and fewer is unambiguously the goal.
    case "FALL_COUNT":
    case "BREATHING_DISTURBANCES":
    // v1.12.8 — the per-night sleep disturbance count reads MIN: the
    // "record" is the night with the fewest disturbances, and fewer is
    // unambiguously the goal (mirrors BREATHING_DISTURBANCES).
    case "SLEEP_DISTURBANCE_COUNT":
      return PersonalRecordDirection.MIN;

    // v1.34 — weight + BMI are goal-dependent, and the goal finally has a
    // source the worker can read: the target the user set on `/targets`
    // (`User.thresholdsJson`). With one on file the record direction is the
    // direction of their OWN goal — lowest reading when they are working
    // down, highest when they are working up. Without a target, or while
    // they sit inside their band, both stay `null` exactly as they have
    // since v1.5.5: a record direction is not something to guess at from
    // height or a population norm.
    case "WEIGHT":
    case "BODY_MASS_INDEX":
      if (context.weightGoal === "lower") return PersonalRecordDirection.MIN;
      if (context.weightGoal === "higher") return PersonalRecordDirection.MAX;
      return null;

    // Explicitly no PersonalRecord (see above); ketones follow a clinician's plan.
    case "BLOOD_PRESSURE_SYS":
    case "BLOOD_PRESSURE_DIA":
    case "BLOOD_GLUCOSE":
    case "BLOOD_KETONES":
    case "BODY_TEMPERATURE":
    case "SKIN_TEMPERATURE":
    case "PULSE":
    case "OXYGEN_SATURATION":
    case "SLEEP_DURATION":
    case "FAT_FREE_MASS":
    // Resting energy follows body size, not effort.
    case "BASAL_ENERGY_BURNED":
    // v1.4.30 — audio-exposure events fire on a threshold-cross, not on a
    // goal axis; a "fewest loud days" record reads better as a streak.
    case "AUDIO_EXPOSURE_EVENT":
    // v1.5.5 — homeostatic / display-only metrics. Respiratory rate
    // is goal-neutral (homeostatic) and walking HR average is fitness
    // dependent without a clean direction (a higher value can be
    // either ill or harder-effort).
    case "RESPIRATORY_RATE":
    case "WALKING_HEART_RATE_AVERAGE":
    // v1.5.5 — walking step length is a state metric:
    // taller users have longer strides regardless of fitness, and
    // there is no clean "higher is better" axis (very long strides
    // can also signal an unsafe overstride). Defer to a null PR
    // direction; the future worker can still surface trend deltas
    // without claiming a record direction.
    case "WALKING_STEP_LENGTH":
    // v1.10.0 — wrist temperature is homeostatic and Apple frames it as
    // a baseline deviation, not a goal axis; neither a higher nor a
    // lower reading is an achievement. Defer to a null PR direction.
    case "WRIST_TEMPERATURE":
    // v1.10.0 — categorical events (WX-B). Device-flagged EVENT rows are
    // discrete occurrences (value is always 1), never a goal axis. A
    // "personal record" for a health-notification event would be both
    // meaningless and alarming, so they explicitly have no PR direction.
    case "IRREGULAR_RHYTHM_NOTIFICATION":
    // v1.44 — AFib burden is an awareness signal from a certified feature,
    // and a State of Mind valence is a self-report of how a moment felt.
    // Neither is a goal axis a record could celebrate.
    case "AFIB_BURDEN":
    case "STATE_OF_MIND_VALENCE":
    // v1.44 — room climate describes a room, not a person's effort.
    case "INDOOR_CO2":
    case "INDOOR_TEMPERATURE":
    case "INDOOR_HUMIDITY":
    case "HIGH_HEART_RATE_EVENT":
    case "LOW_HEART_RATE_EVENT":
    case "WALKING_STEADINESS_EVENT":
    case "BREATHING_DISTURBANCE_EVENT":
    // v1.10.0 — computed scores (WX-C). The server-derived wellness scores
    // are themselves derived composites recomputed nightly from the
    // underlying signals; a "personal record" on a derived score would
    // double-count the PRs of its own inputs and read as noise. They
    // explicitly have no PR direction, like the categorical events above.
    case "RECOVERY_SCORE":
    case "STRESS_SCORE":
    case "STRAIN_SCORE":
    // v1.11.0 — WHOOP-native score classes. These are device-derived daily
    // composites (recovery/strain/sleep-quality indices) and bounded /
    // homeostatic metrics, not a goal axis: a higher day-strain is neither
    // good nor bad, sleep-need is a recommendation rather than an achievement,
    // and RMSSD HRV is one nightly composite — they stay null like the other
    // derived scores rather than minting a duplicate HRV "record".
    case "HRV_RMSSD":
    case "DAY_STRAIN":
    case "WORKOUT_STRAIN":
    case "SLEEP_PERFORMANCE":
    case "SLEEP_EFFICIENCY":
    case "SLEEP_CONSISTENCY":
    case "SLEEP_NEED":
    case "ENERGY_EXPENDITURE_KJ":
    // v1.12.8 — the daily average / max heart rate are whole-cycle
    // aggregates without a clean goal axis: a higher value can mean either
    // a harder-effort day or an ailing one, exactly like the
    // WALKING_HEART_RATE_AVERAGE case above. Defer to a null PR direction.
    case "AVERAGE_HEART_RATE":
    case "MAX_HEART_RATE":
    // v1.17.1 — Polar-native recovery / strain components. ANS_CHARGE is a
    // baseline-relative autonomic deviation (homeostatic, not a goal axis) and
    // CARDIO_LOAD is a device-derived cardiovascular-load composite — neither a
    // higher nor a lower value is an achievement, so they stay null like the
    // other device-derived scores (HRV_RMSSD / DAY_STRAIN).
    case "ANS_CHARGE":
    case "CARDIO_LOAD":
    // Garmin's day scores and the bridged training figures are
    // device composites without a goal axis, like the ones above.
    case "BODY_BATTERY":
    case "STRESS_LEVEL":
    case "TRAINING_READINESS":
    case "ACUTE_TRAINING_LOAD":
    // v1.17.1 — Oura coverage. The Sleep Score is a nightly derived composite
    // and the body-temperature deviation a homeostatic signed offset centred
    // on 0: neither has a goal axis, so both stay null like the set above.
    case "SLEEP_SCORE":
    case "BODY_TEMPERATURE_DEVIATION":
    // v1.19.0 — Oura resilience. An ordinal-encoded categorical band
    // (limited=1 … exceptional=5) recomputed daily from recovery / stress
    // inputs — a derived composite with no clean goal axis, so it stays null
    // like the other device-derived scores.
    case "RESILIENCE":
    // v1.25 — clinical-signals wave. The mental-health screener totals are
    // deliberately NOT gamified (no streaks / "best score" framing around a
    // depression / anxiety screen — research safety rule). Pain NRS is a
    // symptom, not an achievement axis. Waist circumference + waist-to-height
    // are goal-dependent like WEIGHT (a lower waist is a goal for some, not
    // all). All defer to a null PR direction.
    case "PHQ9_SCORE":
    case "GAD7_SCORE":
    // v1.27.9 — WHO-5 / SCI screening totals follow the same no-gamification
    // safety rule (no streaks / "best score" framing around a screener).
    case "WHO5_SCORE":
    case "SCI_SCORE":
    case "PAIN_NRS":
    case "WAIST_CIRCUMFERENCE":
    case "WAIST_TO_HEIGHT":
      return null;
  }
}

/**
 * Convenience predicate for the detection worker:
 * `if (!isPRTrackable(type, ctx)) return;` keeps the worker from writing
 * rows that wouldn't have a defined direction anyway.
 */
export function isPRTrackable(
  metricType: MeasurementType,
  context: PRDirectionContext,
): boolean {
  return getPRDirection(metricType, context) !== null;
}
