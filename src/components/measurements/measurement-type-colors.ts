/**
 * The colour each measurement type carries in the list (a `--chart-N` wash
 * and text), and that its value line carries on the timeline. Class strings
 * over the theme tokens, so both themes retune them; no icon imports here,
 * so a colour-only consumer stays light.
 */
export const MEASUREMENT_TYPE_COLORS: Record<string, string> = {
  WEIGHT: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  BLOOD_PRESSURE_SYS: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  BLOOD_PRESSURE_DIA: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  PULSE: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  BODY_FAT: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  SLEEP_DURATION: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  ACTIVITY_STEPS: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  BLOOD_GLUCOSE: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  TOTAL_BODY_WATER: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  BONE_MASS: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  OXYGEN_SATURATION: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  // ── v1.4.23 Apple Health additions ──
  HEART_RATE_VARIABILITY: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  RESTING_HEART_RATE: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  ACTIVE_ENERGY_BURNED: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  FLIGHTS_CLIMBED: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  WALKING_RUNNING_DISTANCE: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  VO2_MAX: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  BODY_TEMPERATURE: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  // ── v1.4.25 W5d Withings full coverage ──
  // chart-1 (mass), chart-3 (cardio), chart-4 (fat/temp), chart-5
  // (pulse-derived) — extend the existing color-family conventions.
  FAT_FREE_MASS: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  FAT_MASS: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  MUSCLE_MASS: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  SKIN_TEMPERATURE: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  PULSE_WAVE_VELOCITY: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  VASCULAR_AGE: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  VISCERAL_FAT: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  // ── v1.4.25 W8d Apple Health server-prep ──
  // chart-5 (pulse / sound family) carries audio exposure; chart-2
  // (activity / daylight family) carries time-in-daylight so the
  // existing palette conventions hold.
  AUDIO_EXPOSURE_ENV: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  AUDIO_EXPOSURE_HEADPHONE: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  TIME_IN_DAYLIGHT: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  // ── v1.4.30 R-F T1.4 + T1.5 ──
  WALKING_STEADINESS: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  AUDIO_EXPOSURE_EVENT: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  // ── v1.5.5 iOS-coord additions ──
  // Reuse the existing palette families: chart-5 (cardio/pulse),
  // chart-1 (mass), chart-2 (activity/gait).
  RESPIRATORY_RATE: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  BODY_MASS_INDEX: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  LEAN_BODY_MASS: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  WALKING_HEART_RATE_AVERAGE: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  WALKING_ASYMMETRY: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  WALKING_DOUBLE_SUPPORT: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  // Stay in chart-2 (Dracula green) — the entire Mobility cluster
  // (steadiness + asymmetry + double-support + step length + speed)
  // shares the activity-family colour so the gait cards read as one
  // visual group on Insights.
  WALKING_STEP_LENGTH: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  WALKING_SPEED: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // chart-3 (cardio), chart-4 (temp), chart-2 (activity/gait family),
  // chart-5 (sleep-breathing, shares the SpO2 family).
  CARDIO_RECOVERY: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  WRIST_TEMPERATURE: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  FALL_COUNT: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  SIX_MINUTE_WALK_DISTANCE: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  STAIR_ASCENT_SPEED: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  STAIR_DESCENT_SPEED: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  BREATHING_DISTURBANCES: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  // ── v1.10.0 — categorical events (WX-B) ──
  // chart-3 (cardio family) carries the rhythm + heart-rate events;
  // chart-2 (activity/mobility) carries the steadiness event; chart-5
  // (respiratory/pulse family) carries the breathing event.
  IRREGULAR_RHYTHM_NOTIFICATION:
    "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  HIGH_HEART_RATE_EVENT: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  LOW_HEART_RATE_EVENT: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  WALKING_STEADINESS_EVENT: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  BREATHING_DISTURBANCE_EVENT: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  // ── v1.10.0 — computed scores (WX-C) ──
  // chart-1 (Dracula purple) marks the server-derived composites as their
  // own visual group, distinct from the raw-signal families above.
  RECOVERY_SCORE: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  STRESS_SCORE: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  STRAIN_SCORE: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  // ── v1.11.0 — WHOOP-native score classes ──
  // chart-1 (Dracula purple) for the strain composites (same group as the
  // WX-C scores); chart-2 (sleep/activity family) for the sleep-quality set
  // and energy; chart-5 (cardio/pulse family) for RMSSD HRV.
  HRV_RMSSD: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  DAY_STRAIN: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  WORKOUT_STRAIN: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  SLEEP_PERFORMANCE: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  SLEEP_EFFICIENCY: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  SLEEP_CONSISTENCY: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  SLEEP_NEED: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  ENERGY_EXPENDITURE_KJ: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion ──
  // chart-3 (cardio family) for the daily-aggregate heart-rate pair;
  // chart-2 (sleep/activity family) for the per-night disturbance count.
  AVERAGE_HEART_RATE: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  MAX_HEART_RATE: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  SLEEP_DISTURBANCE_COUNT: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  // ── v1.17.1 — Polar Nightly Recharge + Training Load Pro components ──
  // chart-1 (strain/score family) for both, matching DAY_STRAIN.
  ANS_CHARGE: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  CARDIO_LOAD: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  // ── v1.17.1 — Oura coverage completion ──
  // chart-2 (sleep family) for the Sleep Score; chart-5 (metabolic/thermal)
  // for the body-temperature deviation.
  SLEEP_SCORE: "bg-chart-2/10 text-chart-2 dark:bg-chart-2/20",
  BODY_TEMPERATURE_DEVIATION: "bg-chart-5/10 text-chart-5 dark:bg-chart-5/20",
  // ── v1.19.0 — Oura resilience ──
  // chart-1 (Dracula purple) marks the derived recovery / score composites as
  // their own visual group, matching RECOVERY_SCORE / DAY_STRAIN.
  RESILIENCE: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  // ── v1.25 — clinical-signals wave ──
  // chart-1 (composite/score family) for the screener totals + grip strength;
  // chart-3 (cardio/alert family) for pain; chart-4 (body family) for waist.
  PHQ9_SCORE: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  GAD7_SCORE: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  // ── v1.27.9 — screening scores join the composite/score colour family ──
  WHO5_SCORE: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  SCI_SCORE: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  GRIP_STRENGTH: "bg-chart-1/10 text-chart-1 dark:bg-chart-1/20",
  PAIN_NRS: "bg-chart-3/10 text-chart-3 dark:bg-chart-3/20",
  WAIST_CIRCUMFERENCE: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
  WAIST_TO_HEIGHT: "bg-chart-4/10 text-chart-4 dark:bg-chart-4/20",
};
