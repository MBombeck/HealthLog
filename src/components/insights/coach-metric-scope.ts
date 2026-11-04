import type { CoachScopeSource, CoachScopeWindow } from "@/lib/ai/coach/types";
import { COACH_SOURCE_DOMAIN_LABEL } from "@/lib/ai/coach/tools/source-keys";
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";

/**
 * v1.21.0 — metric → Coach scope + seed-question map.
 *
 * The Coach launch context can now carry a live `scope` (a
 * `CoachScopeSource` + window) and a `prefill` seed question into the
 * conversation. This module is the single place that resolves "the user
 * is looking at metric X" into "open the Coach narrowed to source X with
 * a data-aware opener."
 *
 * Two callers consume it:
 *   - `<SubPageShell>` registers the active metric's scope as the page's
 *     ambient scope so the global FAB opens contextual to that page
 *     (no per-metric header icon — CCH-04 stays intact).
 *   - the "Ask the Coach" affordance on insight/assessment cards passes
 *     an explicit scope so a card tap lands a pre-scoped conversation.
 *
 * v1.22 — seed questions are i18n KEYS (`insights.coach.seed.*`), not
 * hardcoded English: a German user was getting an English composer seed. The
 * consumer (`SubPageShell`) resolves the key through `t()` before handing it to
 * the composer, so the seed reads in the user's language.
 */

export interface CoachMetricScope {
  /** Primary source the snapshot narrows to. */
  metric: CoachScopeSource;
  /** Extra sources to include alongside `metric` (e.g. correlations). */
  also?: CoachScopeSource[];
  /** Optional day-window override; defaults to the route's `last30days`. */
  window?: CoachScopeWindow;
  /** i18n key for the composer seed question — resolved by the consumer. */
  question: string;
}

/**
 * `SubPageShell` passes the metric's `explainerMetric` token (the key
 * feeding `insights.subPage.explainer.<metric>Body`). Map the tokens that
 * resolve to a snapshot source to a scope + opener. Tokens absent here
 * (mobility / gait micro-metrics with no dedicated snapshot block) simply
 * carry no ambient scope — the FAB opens the default snapshot, exactly as
 * before, so this is purely additive.
 */
const EXPLAINER_METRIC_SCOPE: Record<string, CoachMetricScope> = {
  bloodPressure: {
    metric: "bp",
    question: "insights.coach.seed.bloodPressure",
  },
  weight: {
    metric: "weight",
    question: "insights.coach.seed.weight",
  },
  bmi: {
    metric: "bmi",
    question: "insights.coach.seed.bmi",
  },
  pulse: {
    metric: "pulse",
    question: "insights.coach.seed.pulse",
  },
  restingHr: {
    metric: "resting_hr",
    question: "insights.coach.seed.restingHr",
  },
  hrv: {
    metric: "hrv",
    question: "insights.coach.seed.hrv",
  },
  sleep: {
    metric: "sleep",
    question: "insights.coach.seed.sleep",
  },
  mood: {
    metric: "mood",
    question: "insights.coach.seed.mood",
  },
  medications: {
    metric: "compliance",
    question: "insights.coach.seed.medications",
  },
  steps: {
    metric: "steps",
    question: "insights.coach.seed.steps",
  },
  activeEnergy: {
    metric: "active_energy",
    question: "insights.coach.seed.activeEnergy",
  },
  cardioFitness: {
    metric: "vo2_max",
    question: "insights.coach.seed.cardioFitness",
  },
  bloodGlucose: {
    metric: "glucose",
    question: "insights.coach.seed.bloodGlucose",
  },
  oxygenSaturation: {
    metric: "spo2",
    question: "insights.coach.seed.oxygenSaturation",
  },
  respiratoryRate: {
    metric: "respiratory_rate",
    question: "insights.coach.seed.respiratoryRate",
  },
  workouts: {
    metric: "workouts",
    question: "insights.coach.seed.workouts",
  },
  // Recovery is a synthesis page; anchor on HRV + resting HR + sleep so the
  // Coach reads the inputs that drive the recovery read.
  recoveryPage: {
    metric: "hrv",
    also: ["resting_hr", "sleep"],
    window: "last7days",
    question: "insights.coach.seed.recoveryPage",
  },
};

/** Resolve a `SubPageShell` explainer token to a Coach scope, or null. */
export function metricScopeFromExplainer(
  explainerMetric: string | undefined,
): CoachMetricScope | null {
  if (!explainerMetric) return null;
  return EXPLAINER_METRIC_SCOPE[explainerMetric] ?? null;
}

/**
 * Every generic metric-assessment id is classified here, including the ones
 * that intentionally cannot scope the Coach. A null entry means the snapshot
 * has no source backed by the exact data assessed on that card; near-matches
 * (for example wrist temperature → skin temperature) must stay unscoped.
 */
const STATUS_METRIC_SCOPE_SOURCE = {
  RESTING_HEART_RATE: "resting_hr",
  HEART_RATE_VARIABILITY: "hrv",
  OXYGEN_SATURATION: "spo2",
  RESPIRATORY_RATE: "respiratory_rate",
  BODY_TEMPERATURE: "body_temp",
  SKIN_TEMPERATURE: "skin_temp",
  BLOOD_GLUCOSE: "glucose",
  WALKING_HEART_RATE_AVERAGE: "walking_hr",
  PULSE_WAVE_VELOCITY: "pulse_wave_velocity",
  VASCULAR_AGE: "vascular_age",
  STEPS: "steps",
  ACTIVE_ENERGY: "active_energy",
  FLIGHTS_CLIMBED: "flights",
  WALKING_RUNNING_DISTANCE: "distance",
  TIME_IN_DAYLIGHT: "daylight",
  VO2_MAX: "vo2_max",
  TOTAL_BODY_WATER: "total_body_water",
  BONE_MASS: "bone_mass",
  FAT_FREE_MASS: "fat_free_mass",
  FAT_MASS: "fat_mass",
  MUSCLE_MASS: "muscle_mass",
  LEAN_BODY_MASS: "lean_body_mass",
  VISCERAL_FAT: "visceral_fat",
  WALKING_STEADINESS: "walking_steadiness",
  WALKING_ASYMMETRY: "walking_asymmetry",
  WALKING_DOUBLE_SUPPORT: "walking_double_support",
  WALKING_STEP_LENGTH: "walking_step_length",
  WALKING_SPEED: "walking_speed",
  AUDIO_EXPOSURE_ENV: "audio_env",
  AUDIO_EXPOSURE_HEADPHONE: "audio_headphone",
  AUDIO_EXPOSURE_EVENT: "audio_event",
  SLEEP_DURATION: "sleep",
  CARDIO_RECOVERY: null,
  WRIST_TEMPERATURE: null,
  FALL_COUNT: null,
  SIX_MINUTE_WALK_DISTANCE: null,
  STAIR_ASCENT_SPEED: null,
  STAIR_DESCENT_SPEED: null,
  BREATHING_DISTURBANCES: null,
  SLEEP_SCORE: null,
  ANS_CHARGE: null,
  DAY_STRAIN: null,
  WORKOUT_STRAIN: null,
  CARDIO_LOAD: null,
  BODY_BATTERY: null,
  STRESS_LEVEL: null,
  TRAINING_READINESS: null,
  ACUTE_TRAINING_LOAD: null,
  AVERAGE_HEART_RATE: null,
  MAX_HEART_RATE: null,
  ENERGY_EXPENDITURE_KJ: null,
  GRIP_STRENGTH: null,
  PAIN_NRS: null,
  WAIST_CIRCUMFERENCE: null,
  WAIST_TO_HEIGHT: null,
} as const satisfies Readonly<
  Record<MetricStatusMetricId, CoachScopeSource | null>
>;

/**
 * Recommendation cards use the insight snapshot's section-key vocabulary.
 * Keep those aliases declarative as well; status-card ids are resolved by the
 * exhaustive table above.
 */
const SNAPSHOT_METRIC_SCOPE_SOURCE: Readonly<Record<string, CoachScopeSource>> =
  {
    bloodpressure: "bp",
    blood_pressure: "bp",
    weight: "weight",
    pulse: "pulse",
    resting_hr: "resting_hr",
    restinghr: "resting_hr",
    hrv: "hrv",
    mood: "mood",
    sleep: "sleep",
    steps: "steps",
    activity: "steps",
    bloodglucose: "glucose",
    blood_glucose: "glucose",
    bmi: "bmi",
    medication: "compliance",
    "medications.compliance": "compliance",
    "medications.compliance7": "compliance",
    "medications.compliance30": "compliance",
    "medications.compliance90": "compliance",
  };

/**
 * Resolve a generic assessment id or recommendation `metricSource.type` to
 * the exact Coach snapshot source it is based on. Unsupported assessment ids
 * resolve to null explicitly through `STATUS_METRIC_SCOPE_SOURCE`.
 */
export function scopeSourceFromMetricKey(
  metricKey: string | undefined,
): CoachScopeSource | null {
  if (!metricKey) return null;

  if (
    Object.prototype.hasOwnProperty.call(STATUS_METRIC_SCOPE_SOURCE, metricKey)
  ) {
    return STATUS_METRIC_SCOPE_SOURCE[
      metricKey as MetricStatusMetricId
    ] as CoachScopeSource | null;
  }

  return SNAPSHOT_METRIC_SCOPE_SOURCE[metricKey.toLowerCase()] ?? null;
}

/**
 * v1.21.2 — the human label for a launch scope's primary metric, for
 * the VISIBLE "the Coach is already on …" pill. The caller resolves the
 * i18n string via `t("insights.coach.scope.metric.<source>")`; this helper
 * supplies the English domain phrase as the deterministic fallback for any
 * source the bundle hasn't named yet, reusing the brand-free
 * `COACH_SOURCE_DOMAIN_LABEL` vocabulary the Coach inventory already
 * speaks. Returns null when there is no metric to label (a generic open).
 */
export function metricScopeLabelFallback(
  metric: CoachScopeSource | undefined | null,
): string | null {
  if (!metric) return null;
  return COACH_SOURCE_DOMAIN_LABEL[metric] ?? (metric as string);
}

/**
 * v1.21.2 — map a launch-scope source onto the EXISTING localised
 * `measurements.type*` metric-name key. The scope pill reads in the user's
 * own language for every measurement-backed source, instead of the English
 * `COACH_SOURCE_DOMAIN_LABEL` fallback that only carries the brand-free
 * domain phrase. Sources without a measurement name (mood, the gait / audio
 * long tail) keep that English fallback — they almost never become a scoped
 * launch. Returns the key, or null when the source has no localised name.
 */
const SCOPE_SOURCE_METRIC_LABEL_KEY: Partial<Record<CoachScopeSource, string>> =
  {
    bp: "measurements.typeBloodPressure",
    weight: "measurements.typeWeight",
    pulse: "measurements.typePulse",
    hrv: "measurements.typeHeartRateVariability",
    resting_hr: "measurements.typeRestingHeartRate",
    walking_hr: "measurements.typeWalkingHeartRateAverage",
    respiratory_rate: "measurements.typeRespiratoryRate",
    spo2: "measurements.typeOxygenSaturation",
    bmi: "measurements.typeBodyMassIndex",
    body_temp: "measurements.typeBodyTemperature",
    vo2_max: "measurements.typeVo2Max",
    pulse_wave_velocity: "measurements.typePulseWaveVelocity",
    vascular_age: "measurements.typeVascularAge",
    sleep: "measurements.typeSleep",
    body_fat: "measurements.typeBodyFat",
    fat_mass: "measurements.typeFatMass",
    fat_free_mass: "measurements.typeFatFreeMass",
    muscle_mass: "measurements.typeMuscleMass",
    lean_body_mass: "measurements.typeLeanBodyMass",
    bone_mass: "measurements.typeBoneMass",
    total_body_water: "measurements.typeTotalBodyWater",
    visceral_fat: "measurements.typeVisceralFat",
    active_energy: "measurements.typeActiveEnergyBurned",
    flights: "measurements.typeFlightsClimbed",
    steps: "measurements.typeSteps",
    distance: "measurements.typeWalkingRunningDistance",
    glucose: "measurements.typeBloodGlucose",
    walking_steadiness: "measurements.typeWalkingSteadiness",
    walking_asymmetry: "measurements.typeWalkingAsymmetry",
    walking_double_support: "measurements.typeWalkingDoubleSupport",
    walking_step_length: "measurements.typeWalkingStepLength",
    walking_speed: "measurements.typeWalkingSpeed",
    audio_env: "measurements.typeAudioExposureEnv",
    audio_headphone: "measurements.typeAudioExposureHeadphone",
    audio_event: "measurements.typeAudioExposureEvent",
    daylight: "measurements.typeTimeInDaylight",
    skin_temp: "measurements.typeSkinTemperature",
  };

export function scopeSourceMetricLabelKey(
  metric: CoachScopeSource | undefined | null,
): string | null {
  if (!metric) return null;
  return SCOPE_SOURCE_METRIC_LABEL_KEY[metric] ?? null;
}
