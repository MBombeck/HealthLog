/**
 * The canonical storage unit of every measurement type.
 *
 * Its own module, with no imports, because both ends read it: the write
 * validation in `validations/measurement.ts` and the client's display
 * transform (`display-transform.ts`), which runs on nearly every chart and
 * tile. Living inside the validation module it dragged Zod into each of those
 * routes for one table lookup. `validations/measurement.ts` re-exports
 * `getUnitForType`, so server callers keep their import.
 */

const unitMap: Record<string, string> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  // v1.4.23 — sleep duration shifted from hours to minutes so HealthKit
  // category-sample stages can be stored without precision loss. Older
  // surfaces that need hours convert at read time (`minutes / 60`).
  SLEEP_DURATION: "minutes",
  ACTIVITY_STEPS: "steps",
  BLOOD_GLUCOSE: "mg/dL",
  TOTAL_BODY_WATER: "kg",
  BONE_MASS: "kg",
  OXYGEN_SATURATION: "%",
  // ── v1.4.23 Apple Health canonical units ──
  HEART_RATE_VARIABILITY: "ms",
  RESTING_HEART_RATE: "bpm",
  ACTIVE_ENERGY_BURNED: "kcal",
  FLIGHTS_CLIMBED: "flights",
  WALKING_RUNNING_DISTANCE: "m",
  VO2_MAX: "mL/(kg·min)",
  BODY_TEMPERATURE: "celsius",
  // ── v1.4.25 W5d Withings full coverage ──
  FAT_FREE_MASS: "kg",
  FAT_MASS: "kg",
  MUSCLE_MASS: "kg",
  // Distinct from BODY_TEMPERATURE — surface temps run ~32 °C; sharing
  // the bucket would corrupt analytics. Same canonical unit (°C).
  SKIN_TEMPERATURE: "celsius",
  PULSE_WAVE_VELOCITY: "m/s",
  VASCULAR_AGE: "years",
  // Withings reports visceral fat as a 1–12 rating, not a percent. The
  // string mirrors what Withings prints in Health Mate.
  VISCERAL_FAT: "rating",
  // ── v1.4.25 W8d Apple Health server-prep ──
  // Sound-pressure level — A-weighted decibels (dBA). HealthKit reports
  // both audio-exposure metrics in dBASPL; we store the unweighted "dBA"
  // label because the A-weighting is implicit (every HealthKit audio
  // sample carries it). 30 dBA = quiet bedroom; 140 dBA = pain threshold.
  AUDIO_EXPOSURE_ENV: "dBA",
  AUDIO_EXPOSURE_HEADPHONE: "dBA",
  // Daily-rollup pattern (one sample = one day's outdoor-light minutes).
  // 0–1440 covers the 24-hour day; in practice indoor users sit near 0
  // and outdoor athletes accumulate a few hours.
  TIME_IN_DAYLIGHT: "minutes",
  // ── v1.5.5 iOS-coord additions ──
  // Respiratory rate breaths-per-minute — the HK identifier ships as
  // `count/min`; we keep the more conventional clinical label.
  RESPIRATORY_RATE: "breaths/min",
  // BMI kg/m² — HealthKit ships the unitless ratio; the canonical
  // display string mirrors clinical convention.
  BODY_MASS_INDEX: "kg/m²",
  // Lean body mass kg — body-composition partner to FAT_MASS.
  LEAN_BODY_MASS: "kg",
  // Walking heart rate average bpm — daily rollup; distinct from
  // RESTING_HEART_RATE (sleep-window minimum) and spot PULSE.
  WALKING_HEART_RATE_AVERAGE: "bpm",
  // Walking gait percent (0-100 after server-side ×100 scaling).
  // Same convention as WALKING_STEADINESS / BODY_FAT / OXYGEN_SATURATION
  // — see the project convention block in `apple-health-mapping.ts`.
  WALKING_ASYMMETRY: "%",
  WALKING_DOUBLE_SUPPORT: "%",
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  // Step length is metres; speed is metres per second. Both flow
  // raw on the wire — no server-side scaling. The unit strings
  // match HealthKit's `m` / `m/s` defaults.
  WALKING_STEP_LENGTH: "m",
  WALKING_SPEED: "m/s",
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // Cardio recovery is the bpm drop one minute after peak exercise.
  CARDIO_RECOVERY: "bpm",
  // Overnight wrist temperature in °C (absolute reading; Apple's own
  // display frames it as a baseline deviation, we store the reading).
  WRIST_TEMPERATURE: "celsius",
  // Hard-fall detections — a plain count.
  FALL_COUNT: "count",
  // Apple's estimated six-minute-walk-test distance in metres.
  SIX_MINUTE_WALK_DISTANCE: "m",
  // Stair gait speeds — raw metres-per-second (no scaling).
  STAIR_ASCENT_SPEED: "m/s",
  STAIR_DESCENT_SPEED: "m/s",
  // Per-night breathing-disturbance index — a unitless count Apple
  // classifies as NotElevated / Elevated.
  BREATHING_DISTURBANCES: "count",
  // ── v1.10.0 — categorical events (WX-B) ──
  // EVENT rows are dimensionless occurrences (value is always 1). The
  // canonical unit is the bare "event" so any accidental numeric surfacing
  // reads sensibly; the awareness timeline never displays the value.
  IRREGULAR_RHYTHM_NOTIFICATION: "event",
  HIGH_HEART_RATE_EVENT: "event",
  LOW_HEART_RATE_EVENT: "event",
  WALKING_STEADINESS_EVENT: "event",
  BREATHING_DISTURBANCE_EVENT: "event",
  // ── v1.10.0 — computed scores (WX-C) ──
  // Server-derived 0–100 wellness scores. The canonical unit is the bare
  // "score" so the value reads sensibly anywhere it surfaces.
  RECOVERY_SCORE: "score",
  STRESS_SCORE: "score",
  STRAIN_SCORE: "score",
  // ── v1.11.0 — WHOOP-native score classes ──
  // RMSSD HRV is in milliseconds, same canonical unit as the SDNN
  // HEART_RATE_VARIABILITY (different estimator, same dimension).
  HRV_RMSSD: "ms",
  // Day / workout strain ride WHOOP's bounded 0–21 scale; the bare "score"
  // unit reads sensibly wherever the value surfaces (distinct from the
  // 0–100 COMPUTED STRAIN_SCORE).
  DAY_STRAIN: "score",
  WORKOUT_STRAIN: "score",
  // Sleep quality percentages (0–100).
  SLEEP_PERFORMANCE: "%",
  SLEEP_EFFICIENCY: "%",
  SLEEP_CONSISTENCY: "%",
  // Recommended sleep duration in minutes (WHOOP reports ms; mapper ÷60000).
  SLEEP_NEED: "minutes",
  // Day energy expenditure in kilojoules (WHOOP-native; kept in kJ so the
  // device value round-trips rather than being converted to kcal).
  ENERGY_EXPENDITURE_KJ: "kJ",
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion ──
  // Daily average / max heart rate bpm — whole-cycle aggregates, distinct
  // from the spot PULSE / RESTING_HEART_RATE / WALKING_HEART_RATE_AVERAGE.
  AVERAGE_HEART_RATE: "bpm",
  MAX_HEART_RATE: "bpm",
  // Per-night sleep disturbance tally — a plain integer count.
  SLEEP_DISTURBANCE_COUNT: "count",
  // ── v1.17.1 — Polar Nightly Recharge + Training Load Pro components ──
  ANS_CHARGE: "score",
  CARDIO_LOAD: "score",
  // ── v1.17.1 — Oura coverage completion ──
  // Oura's headline 0–100 Sleep Score — bare "score" like the other 0–100 scores.
  SLEEP_SCORE: "score",
  // Signed body-temperature deviation in °C (Oura nightly baseline offset).
  BODY_TEMPERATURE_DEVIATION: "celsius",
  // ── v1.19.0 — Oura resilience ──
  // Ordinal level scale (1=limited … 5=exceptional) — the categorical band
  // encoded into the numeric value. See RESILIENCE_LEVELS in src/lib/oura/client.
  RESILIENCE: "level",
  // ── v1.25 — clinical-signals wave ──
  PHQ9_SCORE: "score",
  GAD7_SCORE: "score",
  // ── v1.27.9 — screening scores ──
  WHO5_SCORE: "score",
  SCI_SCORE: "score",
  GRIP_STRENGTH: "kg",
  PAIN_NRS: "score",
  WAIST_CIRCUMFERENCE: "cm",
  WAIST_TO_HEIGHT: "ratio",
};

export function getUnitForType(type: string): string {
  return unitMap[type] ?? "unknown";
}
