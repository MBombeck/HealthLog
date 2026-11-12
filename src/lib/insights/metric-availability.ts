/**
 * v1.4.27 — single decision point for "does the user have
 * any observations on this metric?".
 *
 * Three render gates consume this helper:
 *
 *   1. The routed Insights sub-pages (`/insights/{slug}/page.tsx`)
 *      early-return an empty-state with a CTA when the gate is false.
 *   2. The Insights tab strip (`<InsightsTabStrip>`) filters pills so
 *      a metric with zero observations doesn't surface a navigation
 *      target the user can't act on.
 *   3. The dashboard tile registry (`src/app/page.tsx`) — wired in
 *      bucket B1 — applies the same gate per tile.
 *
 * Source signals:
 *
 *   - Sensor metrics (`PULSE`, `WEIGHT`, `BMI`, `BLOOD_PRESSURE_*`,
 *     `SLEEP_DURATION`, `VO2_MAX`, `STEPS`, `ACTIVE_ENERGY`) read
 *     `summaries[METRIC].count` from the analytics endpoint.
 *   - `BMI` is derived from `WEIGHT` so it inherits the weight count.
 *   - Event-driven metrics (`MOOD`, `MEDICATION`) read the boolean
 *     `hasMood` / `hasMedication` flags the caller threads in (the tab
 *     strip from `/api/insights/presence`).
 *
 * Auto-light-up behaviour: once the iOS native client uploads its
 * first Apple-Health measurement, `summaries[METRIC].count` flips
 * from 0 to ≥1 and the next React-Query refetch reveals the matching
 * pill, sub-page, and dashboard tile — no separate feature flag
 * needed. (F18.)
 */

/**
 * Metric keys the gating helper distinguishes. Mirrors the
 * `MeasurementType` enum for sensor metrics and adds synthetic keys
 * for `MOOD`, `MEDICATION`, and `BMI` (derived from `WEIGHT`).
 *
 * Adding a new metric is a one-place change: list it here, decide
 * which branch of `hasMetricData` handles it, and the sub-page /
 * tab strip / dashboard tile gates pick it up automatically.
 */
export type InsightMetric =
  | "BLOOD_PRESSURE_SYS"
  | "BLOOD_PRESSURE_DIA"
  | "PULSE"
  | "WEIGHT"
  | "BMI"
  | "MOOD"
  | "MEDICATION"
  | "SLEEP_DURATION"
  | "VO2_MAX"
  | "STEPS"
  // The analytics `summaries` map is keyed by `MeasurementType`, so the
  // gating helper reads `summaries[metric].count`. Steps are stored as
  // `ACTIVITY_STEPS`; the routed sub-page + tab strip pass this key so
  // the count resolves on the real DB key (mirrors how the active-energy
  // surface uses `ACTIVE_ENERGY_BURNED` rather than the `ACTIVE_ENERGY`
  // alias). The legacy `STEPS` / `ACTIVE_ENERGY` aliases stay for the
  // metric-status registry's separate id vocabulary.
  | "ACTIVITY_STEPS"
  | "ACTIVE_ENERGY"
  // v1.4.32 — wave-A HealthKit metrics promoted to first-class sub-pages.
  | "HEART_RATE_VARIABILITY"
  // v1.17.0 — RMSSD-flavoured HRV. Oura / Polar / WHOOP / Fitbit / Google
  // Health write nightly HRV as `HRV_RMSSD`; Apple Health and Health Connect
  // write SDNN as `HEART_RATE_VARIABILITY`. The `hrv` sub-page gates on either so a
  // ring / strap user's stored HRV lights the tab, pill, and dashboard.
  | "HRV_RMSSD"
  | "RESTING_HEART_RATE"
  | "OXYGEN_SATURATION"
  | "BODY_TEMPERATURE"
  | "ACTIVE_ENERGY_BURNED"
  // v1.4.32 — workouts surface; gate is event-driven (workouts table
  // row count, not a Measurement series) and threaded via `hasWorkouts`.
  | "WORKOUTS"
  // v1.7.0 — every previously-orphan MeasurementType now gets a
  // first-class sub-page. Each key equals its MeasurementType string so
  // the generic `hasMetricData` fallback gates it on
  // `summaries[metric].count > 0` with no new handler branch (the
  // metric auto-lights-up the moment the first reading lands).
  | "BLOOD_GLUCOSE"
  // #1367 — blood ketones, keyed on its MeasurementType like glucose.
  | "BLOOD_KETONES"
  | "TOTAL_BODY_WATER"
  | "BONE_MASS"
  // Body fat percentage, keyed on its MeasurementType like the rest of the
  // body-composition pages.
  | "BODY_FAT"
  | "FLIGHTS_CLIMBED"
  | "WALKING_RUNNING_DISTANCE"
  | "FAT_FREE_MASS"
  | "FAT_MASS"
  | "MUSCLE_MASS"
  | "SKIN_TEMPERATURE"
  | "PULSE_WAVE_VELOCITY"
  | "VASCULAR_AGE"
  | "VISCERAL_FAT"
  | "AUDIO_EXPOSURE_ENV"
  | "AUDIO_EXPOSURE_HEADPHONE"
  | "TIME_IN_DAYLIGHT"
  | "WALKING_STEADINESS"
  | "AUDIO_EXPOSURE_EVENT"
  | "RESPIRATORY_RATE"
  | "LEAN_BODY_MASS"
  | "WALKING_HEART_RATE_AVERAGE"
  | "WALKING_ASYMMETRY"
  | "WALKING_DOUBLE_SUPPORT"
  | "WALKING_STEP_LENGTH"
  | "WALKING_SPEED"
  // v1.10.0 — additive HealthKit signals (WX-A). Each key equals its
  // MeasurementType string so the generic `hasMetricData` fallback gates
  // it on `summaries[metric].count > 0` (auto-light-up on first reading).
  | "CARDIO_RECOVERY"
  | "WRIST_TEMPERATURE"
  | "FALL_COUNT"
  | "SIX_MINUTE_WALK_DISTANCE"
  | "STAIR_ASCENT_SPEED"
  | "STAIR_DESCENT_SPEED"
  | "BREATHING_DISTURBANCES"
  // v1.25 — physical / clinical signals. Each key equals its MeasurementType,
  // so the generic `hasMetricData` fallback gates it on
  // `summaries[metric].count > 0` (auto-light-up on the first reading).
  | "GRIP_STRENGTH"
  | "PAIN_NRS"
  | "WAIST_CIRCUMFERENCE"
  | "WAIST_TO_HEIGHT"
  // v1.29 — nutrient intake (hydration + micronutrients). Event/store
  // driven (`NutrientIntakeDay`, not a `Measurement` series) like
  // `MOOD` / `MEDICATION` / `WORKOUTS`, so it reads the boolean
  // `hasNutrients` flag rather than a `summaries[…].count` — and unlike
  // those, the flag tracks the opt-in module toggle, not row presence.
  | "NUTRIENTS";

/**
 * Inputs the gating helper consumes. `summaries` is keyed by
 * `MeasurementType` and only its `count` is read, so an analytics
 * summaries map and the presence read's `metrics` both fit. Undefined
 * means the caller hasn't loaded it yet, which the helper treats as
 * "not available" so loading shells aren't accidentally lit up.
 */
export interface InsightInputs {
  summaries: Readonly<Record<string, { count: number }>> | undefined;
  /** Whether the user has logged at least one mood entry. */
  hasMood: boolean;
  /** Whether the user has at least one active medication. */
  hasMedication: boolean;
  /**
   * v1.4.32 — whether the user has at least one workout row. Drives
   * the workouts pill + the workout list page's empty-state gate.
   * Optional so legacy mounts that pre-date v1.4.32 keep type-checking;
   * the helper treats `undefined` as "not available".
   */
  hasWorkouts?: boolean;
  /**
   * v1.29 — whether the opt-in `nutrients` module is on. Drives the
   * nutrients pill directly (no row-count floor on top): the module is
   * a deliberate user choice, and the in-context enable CTA lives on
   * `/insights/nutrients` itself, so the pill must stay reachable the
   * moment the module is on even with zero rows recorded yet. Optional
   * so legacy mounts keep type-checking; the helper treats `undefined`
   * as "not available".
   */
  hasNutrients?: boolean;
}

/**
 * Decide whether a metric has enough observations to surface its
 * sub-page, tab pill, or dashboard tile. Returns `false` for any
 * unknown branch so a future metric added to `InsightMetric` without
 * a handler stays hidden until the gate is wired explicitly.
 */
export function hasMetricData(
  metric: InsightMetric,
  inputs: InsightInputs,
): boolean {
  if (metric === "MOOD") return inputs.hasMood;
  if (metric === "MEDICATION") return inputs.hasMedication;
  if (metric === "WORKOUTS") return inputs.hasWorkouts === true;
  if (metric === "NUTRIENTS") return inputs.hasNutrients === true;
  if (metric === "BMI") {
    // BMI is derived from WEIGHT + the profile height. The chart
    // mounts even at one weight reading; the gate matches.
    return (inputs.summaries?.WEIGHT?.count ?? 0) > 0;
  }
  if (metric === "HEART_RATE_VARIABILITY") {
    // v1.17.0 — surface SDNN (`HEART_RATE_VARIABILITY`, Apple Health)
    // OR RMSSD (`HRV_RMSSD`, Oura / Polar / WHOOP / Fitbit / Google Health). Either stream lights
    // the HRV tab, pill, and dashboard tile.
    return (
      (inputs.summaries?.HEART_RATE_VARIABILITY?.count ?? 0) > 0 ||
      (inputs.summaries?.HRV_RMSSD?.count ?? 0) > 0
    );
  }
  return (inputs.summaries?.[metric]?.count ?? 0) > 0;
}
