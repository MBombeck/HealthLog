/**
 * v1.4.30 — UI-side categorisation overlay for `MeasurementType`.
 *
 * The flat 27-value enum is the correct storage shape (per R-F §4.1)
 * — Postgres enums are cheap; a per-category sub-table would explode
 * the read joins. The overlay below is presentation-only and drives:
 *
 *   - The iOS HealthKit permission picker — grouped by `category` so
 *     the user sees one consent screen per logical area (vitals,
 *     activity, sleep, …) rather than a flat 27-line list. The iOS
 *     side mirrors this map verbatim via the swift-openapi-generator
 *     codegen path (R-E H-8); a new MeasurementType is one change in
 *     this file + the Prisma enum + the Zod validator + this overlay.
 *
 *   - The web Insights nav (post-v1.5) — the sub-page strip stays
 *     curated at 7 pages, but the "All metrics" overview can group
 *     cards by category cheaply from this map.
 *
 *   - The Coach evidence shelf — chip-grouping by category makes the
 *     prose more navigable than a flat list.
 *
 * Locked: see `.planning/research/v15-r-f-apple-health-depth.md` §4.
 */
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * Apple-Health-flavoured category set. Collapses Apple's
 * Heart + Vitals into one `vitals` bucket and omits the ones we
 * deliberately don't track (Cycle, Nutrition, Respiratory clinical,
 * Symptoms).
 *
 * `cardiovascular` is distinct from `vitals` — vitals are point-in-
 * time signals (BP, pulse, HRV, body temp, SpO2); cardiovascular
 * holds derived risk markers that arrive less frequently (pulse-wave
 * velocity, vascular age).
 */
export type MeasurementCategory =
  | "vitals"
  | "body"
  | "activity"
  | "sleep"
  | "hearing"
  | "environment"
  | "cardiovascular"
  | "metabolic"
  // v1.10.0 — computed scores (WX-C). Server-derived wellness scores
  // (Recovery / Stress / Strain). Their own presentation cluster — they are
  // composite indices, not a raw signal in any of the above buckets.
  | "scores";

/**
 * Per-MeasurementType → category mapping. The map is exhaustive over
 * the current enum surface — adding a new MeasurementType is a
 * compile-time error in this file until a category is assigned.
 *
 * The map is intentionally `ReadonlyMap` rather than a plain object
 * literal so consumers cannot mutate it accidentally; a flat
 * `Record<MeasurementType, MeasurementCategory>` would be equally
 * valid but provides no immutability guard.
 */
export const MEASUREMENT_CATEGORIES: ReadonlyMap<
  MeasurementType,
  MeasurementCategory
> = new Map<MeasurementType, MeasurementCategory>([
  // ── Vitals (point-in-time signals) ──
  ["BLOOD_PRESSURE_SYS", "vitals"],
  ["BLOOD_PRESSURE_DIA", "vitals"],
  ["PULSE", "vitals"],
  ["OXYGEN_SATURATION", "vitals"],
  ["BODY_TEMPERATURE", "vitals"],
  // v1.5.5 — respiratory rate sits alongside SpO2 + body temp as a
  // point-in-time clinical vital.
  ["RESPIRATORY_RATE", "vitals"],

  // ── Body composition ──
  ["WEIGHT", "body"],
  ["BODY_FAT", "body"],
  ["FAT_FREE_MASS", "body"],
  ["FAT_MASS", "body"],
  ["MUSCLE_MASS", "body"],
  ["TOTAL_BODY_WATER", "body"],
  ["BONE_MASS", "body"],
  ["VISCERAL_FAT", "body"],
  // v1.5.5 — BMI + lean body mass round out the body-composition
  // surface (FAT_MASS already covers the fat side).
  ["BODY_MASS_INDEX", "body"],
  ["LEAN_BODY_MASS", "body"],

  // ── Activity (cumulative + fitness + mobility) ──
  ["ACTIVITY_STEPS", "activity"],
  ["ACTIVE_ENERGY_BURNED", "activity"],
  ["BASAL_ENERGY_BURNED", "activity"],
  ["FLIGHTS_CLIMBED", "activity"],
  ["WALKING_RUNNING_DISTANCE", "activity"],
  ["VO2_MAX", "activity"],
  ["WALKING_STEADINESS", "activity"],
  // v1.5.5 — gait + walking-HR-average sit alongside walking
  // steadiness as Apple-Health Mobility-section signals.
  ["WALKING_ASYMMETRY", "activity"],
  ["WALKING_DOUBLE_SUPPORT", "activity"],
  ["WALKING_HEART_RATE_AVERAGE", "activity"],
  // v1.5.5 — gait raw-SI pair join the same Mobility cluster.
  ["WALKING_STEP_LENGTH", "activity"],
  ["WALKING_SPEED", "activity"],

  // ── Sleep ──
  ["SLEEP_DURATION", "sleep"],

  // ── Hearing (audio exposure quantities + events) ──
  ["AUDIO_EXPOSURE_ENV", "hearing"],
  ["AUDIO_EXPOSURE_HEADPHONE", "hearing"],
  ["AUDIO_EXPOSURE_EVENT", "hearing"],

  // ── Environment ──
  ["TIME_IN_DAYLIGHT", "environment"],

  // ── Cardiovascular (derived risk markers + Apple-Health-grouped
  // heart-rate variants). v1.4.32 — RESTING_HEART_RATE +
  // HEART_RATE_VARIABILITY moved here from `vitals` to align with the
  // iOS handoff brief's category table (RESTING_HR, HRV →
  // cardiovascular). PULSE stays in `vitals` because spot-pulse
  // samples are point-in-time signals; the resting + variability
  // metrics are the derived cardiac-risk surface. ──
  ["RESTING_HEART_RATE", "cardiovascular"],
  ["HEART_RATE_VARIABILITY", "cardiovascular"],
  ["PULSE_WAVE_VELOCITY", "cardiovascular"],
  ["VASCULAR_AGE", "cardiovascular"],

  // ── Metabolic ──
  ["BLOOD_GLUCOSE", "metabolic"],
  ["SKIN_TEMPERATURE", "metabolic"],
  // v1.10.0 — wrist temperature is an overnight skin-side reading;
  // it sits with skin temperature in the metabolic cluster.
  ["WRIST_TEMPERATURE", "metabolic"],

  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // Cardio recovery is the post-exercise HR-drop autonomic-fitness
  // marker — it joins the derived cardiovascular surface.
  ["CARDIO_RECOVERY", "cardiovascular"],
  // Fall count, six-minute-walk distance, and the stair gait speeds are
  // Apple-Health Mobility-section signals alongside walking steadiness.
  ["FALL_COUNT", "activity"],
  ["SIX_MINUTE_WALK_DISTANCE", "activity"],
  ["STAIR_ASCENT_SPEED", "activity"],
  ["STAIR_DESCENT_SPEED", "activity"],
  // Breathing disturbances is a per-night sleep-breathing index.
  ["BREATHING_DISTURBANCES", "sleep"],

  // ── v1.10.0 — categorical events (WX-B) ──
  // Device-flagged EVENT rows slot into the category their signal
  // belongs to: the rhythm + heart-rate notifications join the
  // cardiovascular surface, the walking-steadiness alert joins the
  // activity/mobility cluster, and the breathing-disturbance flag joins
  // sleep (it fires during sleep). They never participate in
  // trend/rollup analytics — the category is only for list grouping.
  ["IRREGULAR_RHYTHM_NOTIFICATION", "cardiovascular"],
  ["HIGH_HEART_RATE_EVENT", "cardiovascular"],
  ["LOW_HEART_RATE_EVENT", "cardiovascular"],
  ["WALKING_STEADINESS_EVENT", "activity"],
  ["BREATHING_DISTURBANCE_EVENT", "sleep"],

  // ── v1.10.0 — computed scores (WX-C) ──
  // Server-derived wellness scores share their own presentation cluster.
  // The category is only for list grouping — scores never participate in
  // trend/rollup analytics (they ARE a nightly-computed composite).
  ["RECOVERY_SCORE", "scores"],
  ["STRESS_SCORE", "scores"],
  ["STRAIN_SCORE", "scores"],

  // ── v1.11.0 — WHOOP-native score classes ──
  // Day/workout strain are composite indices alongside the other scores.
  ["DAY_STRAIN", "scores"],
  ["WORKOUT_STRAIN", "scores"],
  // RMSSD HRV joins the derived cardiac surface alongside the SDNN variant.
  ["HRV_RMSSD", "cardiovascular"],
  // Sleep-quality indices + recommended sleep need sit in the sleep cluster.
  ["SLEEP_PERFORMANCE", "sleep"],
  ["SLEEP_EFFICIENCY", "sleep"],
  ["SLEEP_CONSISTENCY", "sleep"],
  ["SLEEP_NEED", "sleep"],
  // Day energy expenditure is a cumulative activity metric (kJ analogue of
  // ACTIVE_ENERGY_BURNED).
  ["ENERGY_EXPENDITURE_KJ", "activity"],

  // ── v1.12.8 — WHOOP cycle + sleep coverage completion ──
  // Daily average / max heart rate join the derived cardiac surface
  // alongside RESTING_HEART_RATE + HRV (whole-cycle aggregates, not spot
  // readings). The per-night disturbance count sits in the sleep cluster.
  ["AVERAGE_HEART_RATE", "cardiovascular"],
  ["MAX_HEART_RATE", "cardiovascular"],
  ["SLEEP_DISTURBANCE_COUNT", "sleep"],

  // ── v1.17.1 — Polar Nightly Recharge + Training Load Pro components ──
  // ANS charge + Cardio Load are device-native recovery / strain composites,
  // so they join the scores cluster alongside DAY_STRAIN.
  ["ANS_CHARGE", "scores"],
  ["CARDIO_LOAD", "scores"],
  // ── v1.17.1 — Oura coverage completion ──
  // The Sleep Score is a per-night sleep-quality index → sleep cluster.
  ["SLEEP_SCORE", "sleep"],
  // Body-temperature deviation is an overnight thermal signal that pairs with
  // skin / wrist temperature in the metabolic cluster.
  ["BODY_TEMPERATURE_DEVIATION", "metabolic"],
  // ── v1.19.0 — Oura resilience ──
  // The resilience level is a derived recovery composite (ordinal-encoded
  // band) → scores cluster alongside RECOVERY_SCORE / ANS_CHARGE.
  ["RESILIENCE", "scores"],

  // ── v1.25 — clinical-signals wave ──
  // PHQ-9 / GAD-7 totals are composite screener indices → scores cluster.
  ["PHQ9_SCORE", "scores"],
  ["GAD7_SCORE", "scores"],
  // ── v1.27.9 — WHO-5 / SCI totals join the same screener-index cluster.
  ["WHO5_SCORE", "scores"],
  ["SCI_SCORE", "scores"],
  // Grip strength is a strength/fitness reading → activity cluster.
  ["GRIP_STRENGTH", "activity"],
  // Pain NRS is a patient-reported clinical point-in-time signal → vitals.
  ["PAIN_NRS", "vitals"],
  // Waist circumference + waist-to-height are anthropometric → body cluster.
  ["WAIST_CIRCUMFERENCE", "body"],
  ["WAIST_TO_HEIGHT", "body"],
  // ── v1.44 — Apple Health activity rings, mindfulness, mood, AFib ──
  // The exercise and stand rings, and mindful minutes (time given to a
  // practice, the same day-total shape), sit with the activity cluster.
  ["EXERCISE_MINUTES", "activity"],
  ["STAND_MINUTES", "activity"],
  ["STAND_HOURS", "activity"],
  ["MINDFUL_MINUTES", "activity"],
  // The State of Mind valence is a self-report, like the WHO-5 total.
  ["STATE_OF_MIND_VALENCE", "scores"],
  // AFib burden joins the rhythm notifications on the cardiovascular surface.
  ["AFIB_BURDEN", "cardiovascular"],
  // ── v1.44 — room climate joins daylight in the environment cluster ──
  ["INDOOR_CO2", "environment"],
  ["INDOOR_TEMPERATURE", "environment"],
  ["INDOOR_HUMIDITY", "environment"],
  // ── Garmin scores join the device-native scores ──
  ["BODY_BATTERY", "scores"],
  ["STRESS_LEVEL", "scores"],
  ["TRAINING_READINESS", "scores"],
  ["ACUTE_TRAINING_LOAD", "scores"],
]);

/**
 * Lookup the category for a `MeasurementType`. Returns `undefined`
 * only if a new enum value lands in the schema without a sibling
 * entry in the map — the completeness test in
 * `__tests__/categories.test.ts` is the regression sentinel.
 */
export function getMeasurementCategory(
  type: MeasurementType,
): MeasurementCategory | undefined {
  return MEASUREMENT_CATEGORIES.get(type);
}

/**
 * List every `MeasurementType` belonging to a given category. Useful
 * for the iOS picker fan-out and the web Insights nav grouping. The
 * return order is the insertion order in `MEASUREMENT_CATEGORIES`
 * above — kept deterministic so the picker UX has a stable layout.
 */
export function measurementTypesForCategory(
  category: MeasurementCategory,
): MeasurementType[] {
  const out: MeasurementType[] = [];
  for (const [type, cat] of MEASUREMENT_CATEGORIES) {
    if (cat === category) out.push(type);
  }
  return out;
}
