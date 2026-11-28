/**
 * v1.10.0 — the closed `DERIVED_METRIC_ID` enum + per-metric metadata.
 *
 * One single source the generic `/api/insights/derived` route, the
 * OpenAPI registration, and the QA inventory all share. An id added here
 * is accepted by the route automatically; an unknown id 422s against the
 * closed enum (the v1.8.7.1 `metric-status` pattern).
 *
 * ONE metric is implemented end-to-end as the reference: the personal
 * typical-range vitals baseline (`VITALS_BASELINE`). The other catalogue
 * metrics are registered here as metadata STUBS — their `archetype`
 * documents the shape a compute plugs into, but their compute functions
 * are still to come (`fitness-age.ts`, `vascular-age.ts`, `sleep-score.ts`,
 * `readiness.ts`, the coincident-deviation flag). A stubbed metric routed
 * before its compute lands returns `insufficient` via the dispatcher's
 * `not-implemented` guard, never a fabricated value.
 *
 * Metadata only — no compute, no server imports — so this stays
 * client-safe and the route enum / OpenAPI can import it freely.
 */
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * The closed set of derived-metric ids. The single vocabulary the route
 * query param, the OpenAPI enum, and the cache scope all speak.
 */
export type DerivedMetricId =
  /** FLAGSHIP (W1): personal typical-range band for one vital. */
  | "VITALS_BASELINE"
  /** W2: VO₂max → age/sex band + chronological-age delta (passthrough re-frame). */
  | "FITNESS_AGE"
  /** W2: VASCULAR_AGE/PWV → age-delta band (passthrough re-frame). */
  | "VASCULAR_AGE_DELTA"
  /** W3: transparent sleep composite. */
  | "SLEEP_SCORE"
  /** W3: wellness/readiness index (extends the health-score blend). */
  | "READINESS"
  /** W3: multi-signal coincident-deviation early-strain flag. */
  | "COINCIDENT_DEVIATION"
  /** W2: HRV (SDNN) personal-trend balance band (reuses the baseline engine). */
  | "HRV_BALANCE"
  /** W2: BMI from weight + height (fallback when no device BMI). */
  | "BMI"
  /** Persisted nightly recovery composite (passthrough read of COMPUTED rows). */
  | "RECOVERY_SCORE"
  /** Persisted nightly stress composite (passthrough read of COMPUTED rows). */
  | "STRESS_SCORE"
  /** Persisted nightly strain composite (passthrough read of COMPUTED rows). */
  | "STRAIN_SCORE"
  /** v1.10.3: overnight wrist-temperature personal-deviation band (baseline engine). */
  | "WRIST_TEMPERATURE_BASELINE"
  /** v1.10.3: stair-ascent-speed personal trend band (baseline engine). */
  | "STAIR_ASCENT_SPEED_BASELINE"
  /** v1.10.3: stair-descent-speed personal trend band (baseline engine). */
  | "STAIR_DESCENT_SPEED_BASELINE"
  /** v1.10.3: estimated 6-minute-walk distance vs Enright-predicted (passthrough re-frame). */
  | "SIX_MINUTE_WALK_BAND"
  /** Versioned cardiometabolic reference composite. */
  | "HEALTH_SCORE"
  /** v1.11.0: short-horizon OLS projection with a widening prediction band. */
  | "TRAJECTORY"
  /** v1.34.0: today's running total for a cumulative metric vs this person's own typical total at the same local hour. */
  | "SAME_TIME_BASELINE";

// Documented-as-omitted (v1.10.3): two additive HealthKit signals stay
// trend-only with NO derived band, on purpose —
//   - FALL_COUNT is a zero-inflated discrete safety EVENT (target = zero); a
//     median ± k·MAD band on a near-constant-zero series is meaningless and a
//     band would imply a smooth metric where there is none.
//   - BREATHING_DISTURBANCES is a regulated sleep-apnea SCREENING signal (Apple
//     publishes only NotElevated/Elevated, no numeric cutoff); a self-derived
//     band would read as a HealthLog verdict on a screening signal and imply a
//     diagnosis. The fired BREATHING_DISTURBANCE_EVENT carries the device's own
//     classification in the awareness card; the continuous index stays a plain
//     trend with the generic assessment.

/** Archetype of a derived metric — drives shaping + the QA inventory. */
export type DerivedArchetype =
  /** Renders whenever its single input series exists; no min-input threshold beyond its own history. */
  | "any-user-baseline"
  /** A device-computed value re-framed against a norm band — never recomputed. */
  | "passthrough-reframe"
  /** Needs a minimum-inputs threshold, reweights around missing inputs, shows coverage/confidence. */
  | "composite";

export interface DerivedMetricMeta {
  id: DerivedMetricId;
  /** Stable English display name (surfaces localise their own prose). */
  displayName: string;
  archetype: DerivedArchetype;
  /**
   * The named inputs the metric reads. For `VITALS_BASELINE` these are
   * `MeasurementType` names (the caller selects one via the route's
   * `type` opt); for a composite the set may also name non-measurement
   * signals (e.g. "MOOD", a derived sub-score) the coverage model counts
   * against — hence `string`, not `MeasurementType`.
   */
  inputs: string[];
  /**
   * Minimum distinct history-days an input needs before a band/headline
   * is produced. Below the floor the metric returns `insufficient`.
   */
  minHistoryDays: number;
  /**
   * For a composite: the minimum number of `inputs` that must be present
   * before a headline is produced (no 1-of-N headline). `1` for
   * any-user / passthrough metrics.
   */
  minInputs: number;
  /** `true` once a compute function backs this id; `false` = W2/W3 stub. */
  implemented: boolean;
}

/**
 * The vitals the typical-range baseline engine supports. The route's
 * `type` opt must name one of these; any other type 422s. Mirrors the
 * metric-1 input set from the catalogue (§1, row 1).
 */
export const VITALS_BASELINE_TYPES: MeasurementType[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "RESPIRATORY_RATE",
  "OXYGEN_SATURATION",
  "BODY_TEMPERATURE",
  "SKIN_TEMPERATURE",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "BLOOD_GLUCOSE",
  "PULSE",
  "WEIGHT",
];

/**
 * The cumulative metrics a same-time baseline is defined for.
 *
 * These four accumulate through the day, which is exactly why a "latest
 * reading" means nothing for them and a same-hour comparison means everything.
 *
 * `TIME_IN_DAYLIGHT` and `FALL_COUNT` are cumulative too and are deliberately
 * out. Daylight exposure is environmental rather than behavioural — a same-time
 * verdict on it would read as a judgement on the weather. A fall count is a
 * near-always-zero safety event whose target is zero, and "you are behind your
 * usual falls for this hour" is not a sentence this application will ever say.
 */
export const SAME_TIME_BASELINE_TYPES: MeasurementType[] = [
  "ACTIVITY_STEPS",
  "ACTIVE_ENERGY_BURNED",
  "WALKING_RUNNING_DISTANCE",
  "FLIGHTS_CLIMBED",
];

/** `true` when the type is one the same-time baseline is defined for. */
export function isSameTimeBaselineType(type: string): boolean {
  return (SAME_TIME_BASELINE_TYPES as string[]).includes(type);
}

/**
 * The trailing window the same-time baseline draws its typical day from.
 *
 * Four weeks. Long enough that every weekday is represented several times, so
 * a single unusual Tuesday cannot move the median; short enough that the
 * comparison still describes the life the person is living now rather than the
 * one they had last season.
 */
export const SAME_TIME_BASELINE_WINDOW_DAYS = 28;

/**
 * How many usable days must be in hand before the highlight says anything.
 *
 * THIS IS THE THRESHOLD. It is defined here, in the client-safe registry, so
 * the compute engine, the rail builder and the copy that explains the wait all
 * read the same number rather than each carrying their own.
 *
 * Two weeks, not the seven days the vitals baseline uses. A resting heart rate
 * is a stable physiological quantity and seven readings genuinely bound it. A
 * person's day is not: it has a weekday shape and a weekend shape, and a median
 * built from three working days would confidently call a Saturday morning
 * "behind" for no better reason than that Saturdays were never in the sample.
 * Fourteen days covers both twice over. Below it the metric returns the
 * `insufficient` arm with `learning_usual_day`, which is the honest answer and
 * the one this arm exists for.
 */
export const SAME_TIME_BASELINE_MIN_HISTORY_DAYS = 14;

/**
 * The complete days the day-total form of the same-time baseline draws the
 * usual full day from.
 *
 * A source that reports the day as one total (Garmin, Withings, a Gadgetbridge
 * import) carries no hours, so "usual by this hour" cannot be known for it.
 * What can be known is the usual full day, and the card sets today's running
 * total against that instead. Two weeks: every weekday twice, and recent
 * enough to describe the current routine.
 */
export const SAME_TIME_DAILY_TOTAL_WINDOW_DAYS = 14;

/**
 * Days with a total the day-total form needs before it shows a range. Seven,
 * as for the vitals baseline: the range is the middle half of whole days, and
 * a week of them bounds it, where the hourly form needs fourteen to tell a
 * weekday morning from a weekend one. Below it the metric returns the
 * `insufficient` arm with `learning_usual_total`.
 */
export const SAME_TIME_DAILY_TOTAL_MIN_HISTORY_DAYS = 7;

const REGISTRY: Record<DerivedMetricId, DerivedMetricMeta> = {
  VITALS_BASELINE: {
    id: "VITALS_BASELINE",
    displayName: "Personal typical range",
    archetype: "any-user-baseline",
    inputs: VITALS_BASELINE_TYPES,
    minHistoryDays: 7,
    minInputs: 1,
    implemented: true,
  },
  FITNESS_AGE: {
    id: "FITNESS_AGE",
    displayName: "Cardio-fitness band",
    archetype: "passthrough-reframe",
    inputs: ["VO2_MAX"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: true,
  },
  VASCULAR_AGE_DELTA: {
    id: "VASCULAR_AGE_DELTA",
    displayName: "Vascular-age delta",
    archetype: "passthrough-reframe",
    inputs: ["VASCULAR_AGE", "PULSE_WAVE_VELOCITY"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: true,
  },
  SLEEP_SCORE: {
    id: "SLEEP_SCORE",
    displayName: "Sleep score",
    archetype: "composite",
    inputs: ["SLEEP_DURATION"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: true,
  },
  READINESS: {
    id: "READINESS",
    displayName: "Wellness / readiness index",
    archetype: "composite",
    inputs: [
      "RESTING_HEART_RATE",
      "HEART_RATE_VARIABILITY",
      "SLEEP_DURATION",
      "RESPIRATORY_RATE",
      "MOOD",
    ],
    minHistoryDays: 7,
    minInputs: 2,
    implemented: true,
  },
  COINCIDENT_DEVIATION: {
    id: "COINCIDENT_DEVIATION",
    displayName: "Coincident-deviation flag",
    archetype: "composite",
    inputs: VITALS_BASELINE_TYPES,
    minHistoryDays: 7,
    minInputs: 2,
    implemented: true,
  },
  HRV_BALANCE: {
    id: "HRV_BALANCE",
    displayName: "HRV (SDNN) balance",
    archetype: "any-user-baseline",
    inputs: ["HEART_RATE_VARIABILITY"],
    minHistoryDays: 7,
    minInputs: 1,
    implemented: true,
  },
  BMI: {
    id: "BMI",
    displayName: "Body-mass index",
    archetype: "any-user-baseline",
    inputs: ["WEIGHT", "HEIGHT"],
    minHistoryDays: 1,
    minInputs: 2,
    implemented: true,
  },
  RECOVERY_SCORE: {
    id: "RECOVERY_SCORE",
    displayName: "Recovery score",
    archetype: "passthrough-reframe",
    inputs: ["RECOVERY_SCORE"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: true,
  },
  STRESS_SCORE: {
    id: "STRESS_SCORE",
    displayName: "Stress score",
    archetype: "passthrough-reframe",
    inputs: ["STRESS_SCORE"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: true,
  },
  STRAIN_SCORE: {
    id: "STRAIN_SCORE",
    displayName: "Strain score",
    archetype: "passthrough-reframe",
    inputs: ["STRAIN_SCORE"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: true,
  },
  WRIST_TEMPERATURE_BASELINE: {
    id: "WRIST_TEMPERATURE_BASELINE",
    displayName: "Wrist-temperature baseline",
    archetype: "any-user-baseline",
    inputs: ["WRIST_TEMPERATURE"],
    minHistoryDays: 7,
    minInputs: 1,
    implemented: true,
  },
  STAIR_ASCENT_SPEED_BASELINE: {
    id: "STAIR_ASCENT_SPEED_BASELINE",
    displayName: "Stair-ascent-speed baseline",
    archetype: "any-user-baseline",
    inputs: ["STAIR_ASCENT_SPEED"],
    minHistoryDays: 7,
    minInputs: 1,
    implemented: true,
  },
  STAIR_DESCENT_SPEED_BASELINE: {
    id: "STAIR_DESCENT_SPEED_BASELINE",
    displayName: "Stair-descent-speed baseline",
    archetype: "any-user-baseline",
    inputs: ["STAIR_DESCENT_SPEED"],
    minHistoryDays: 7,
    minInputs: 1,
    implemented: true,
  },
  SIX_MINUTE_WALK_BAND: {
    id: "SIX_MINUTE_WALK_BAND",
    displayName: "Estimated 6-minute-walk band",
    archetype: "passthrough-reframe",
    inputs: ["SIX_MINUTE_WALK_DISTANCE"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: true,
  },
  TRAJECTORY: {
    id: "TRAJECTORY",
    // Short-horizon OLS projection over a single chosen metric. The caller
    // selects the projected type via the route's `type` opt (validated
    // against `TRAJECTORY_TYPES`); below the R²/history/staleness floor the
    // engine returns `insufficient`, never a weak line — so the
    // `minHistoryDays` here documents the engine's own 14-day fit floor.
    displayName: "Short-horizon projection",
    archetype: "any-user-baseline",
    inputs: VITALS_BASELINE_TYPES,
    minHistoryDays: 14,
    minInputs: 1,
    implemented: true,
  },
  HEALTH_SCORE: {
    id: "HEALTH_SCORE",
    displayName: "Cardiometabolic reference score",
    archetype: "composite",
    // The seven ids below are the CATALOGUE of scorable pillars, and since
    // v1.35.0 they are not the recipe. What counts toward an account's
    // composite is the resolved per-user composition
    // (`resolveHealthScoreConfig`) intersected with the modules that record
    // data, so no static list here can say what any one person's score is
    // made of. The list is kept in step with `SCORE_PILLAR_IDS` by
    // `health-score-coverage-contract.test.ts`; edit both or neither.
    inputs: [
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
      "WELLBEING",
      "LIPIDS",
    ],
    minHistoryDays: 1,
    // NOT the composite's floor, and not read by anything. The coverage and
    // confidence this metric publishes are built in `computeComposite`
    // (`src/lib/analytics/score/composite.ts`) over the resolved
    // composition, never from this entry, which is why a person who counts
    // four pillars is not measured against a denominator of seven. The real
    // floor is the breadth rule in `src/lib/analytics/score/breadth.ts`: at
    // least three distinct DOMAINS including one physiological pillar. Three
    // of the seven ids above share the cardiometabolic domain, so "three
    // inputs" and "enough breadth for a score" are different questions and
    // this number answers neither. The field stays because every registry
    // entry carries it; reading it as a threshold would be wrong.
    minInputs: 3,
    implemented: true,
  },
  SAME_TIME_BASELINE: {
    id: "SAME_TIME_BASELINE",
    displayName: "Same-time baseline",
    archetype: "any-user-baseline",
    inputs: SAME_TIME_BASELINE_TYPES,
    minHistoryDays: SAME_TIME_BASELINE_MIN_HISTORY_DAYS,
    minInputs: 1,
    implemented: true,
  },
};

/** Closed set of ids the generic route accepts (Zod enum source). */
export const DERIVED_METRIC_IDS = Object.keys(REGISTRY) as DerivedMetricId[];

/** Type guard narrowing an arbitrary string to a registered derived id. */
export function isDerivedMetricId(value: string): value is DerivedMetricId {
  return Object.prototype.hasOwnProperty.call(REGISTRY, value);
}

/** Resolve a derived metric's metadata, or `null` when unregistered. */
export function getDerivedMetricMeta(metric: string): DerivedMetricMeta | null {
  return isDerivedMetricId(metric) ? REGISTRY[metric] : null;
}

/** `true` when the type is a vital the baseline engine supports. */
export function isVitalsBaselineType(type: string): boolean {
  return (VITALS_BASELINE_TYPES as string[]).includes(type);
}

/**
 * The metrics the short-horizon `TRAJECTORY` engine supports. Reuses the
 * vitals baseline set — slow, daily physiological day-series for which a
 * conservative 7–14-day OLS projection is honest; the engine gates anything
 * without a real trend out to `insufficient` regardless.
 */
// A distinct array (not an alias of VITALS_BASELINE_TYPES) so the trajectory
// set can diverge later and stays a single, non-duplicate export.
export const TRAJECTORY_TYPES: MeasurementType[] = [...VITALS_BASELINE_TYPES];

/** `true` when the type is a metric the trajectory engine supports. */
export function isTrajectoryType(type: string): boolean {
  return (TRAJECTORY_TYPES as string[]).includes(type);
}
