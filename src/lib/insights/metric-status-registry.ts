/**
 * v1.8.7.1 — generic per-metric assessment registry.
 *
 * The seven specialised assessment scopes (blood-pressure / pulse /
 * weight / bmi / mood / medication-compliance / general) each ship a
 * bespoke generator + prompt. The ~30 HealthKit metric pages
 * (`HealthKitMetricPage`) carried charts but no plain-language
 * assessment, because hand-writing 30 more prompts is not viable.
 *
 * This registry is the data-driven alternative: each HealthKit metric is
 * described by the small amount of metadata a generic generator needs to
 * assess it — a display name, a unit, the direction a "good" value moves,
 * an optional clinical/consumer normal range, and an archetype that
 * selects one of six shared prompt templates. A metric with no entry here
 * simply gets no assessment card (the safe default the spec calls for).
 *
 * Metric ids are the existing `InsightMetric` HealthKit identifiers
 * (WEIGHT, RESTING_HEART_RATE, SLEEP_DURATION, …) so the UI contract,
 * the route query param, and the cache scope all speak one vocabulary.
 * Internally each id maps to the `MeasurementType` the rollup tier and
 * the raw `Measurement` rows are keyed by (a handful differ — `STEPS`
 * is stored as `ACTIVITY_STEPS`, `ACTIVE_ENERGY` as `ACTIVE_ENERGY_BURNED`).
 *
 * The seven specialised metrics (WEIGHT, BLOOD_PRESSURE_*, PULSE, BMI,
 * MOOD, MEDICATION) are intentionally NOT registered here — they keep
 * their existing dedicated scopes and are never routed through the
 * generic path.
 *
 * Medical note (design §"Medical note"): normal ranges are population
 * anchors a generic consumer/clinical guideline supports, used only as a
 * coarse placement aid. The generator's primary signal is the user's OWN
 * baseline (the graded series), and where the profile stores age + sex
 * (`dateOfBirth` + `gender`) the generator threads them so the model can
 * sanity-check the placement. NO ancestry/region-of-birth ranges — that
 * is medically contentious and a data category HealthLog does not
 * collect.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { FEVER_BAND_C } from "@/lib/clinical-floors";

/** The five shared archetypes plus the dedicated sleep template. */
export type MetricArchetype =
  | "physiological-vital"
  | "activity-fitness"
  | "body-composition"
  | "mobility-gait"
  | "environmental-exposure"
  | "sleep";

/**
 * Direction a favourable value moves. `target-band` means neither
 * extreme is good — the value should sit inside `normalRange`.
 */
export type MetricDirection = "higher-better" | "lower-better" | "target-band";

export interface MetricNormalRange {
  low: number;
  high: number;
}

export interface MetricStatusMeta {
  /** The HealthKit metric id — the public route param + cache scope. */
  id: MetricStatusMetricId;
  /** The DB `MeasurementType` the rollup tier + raw reads are keyed by. */
  measurementType: MeasurementType;
  /** Stable English display name (the model localises its prose itself). */
  displayName: string;
  /** Canonical storage unit (matches the DB column semantics). */
  unit: string;
  direction: MetricDirection;
  /** Coarse population placement anchor; the user's own baseline leads. */
  normalRange?: MetricNormalRange;
  /**
   * D3-H1: single-reading fever band line (°C) for temperature metrics, bound
   * to the canonical `FEVER_BAND_C` so the status band and the illness engine's
   * sustained-fever escalation (`FEVER_RED_FLAG_C`) are visibly one intentional
   * pair from `@/lib/clinical-floors`, not two unrelated magic numbers.
   */
  feverBandC?: number;
  archetype: MetricArchetype;
}

/**
 * The metric ids the generic assessment path covers. A strict subset of
 * `InsightMetric` — the seven specialised metrics and the event-driven
 * MOOD / MEDICATION / WORKOUTS keys are excluded by construction.
 */
export type MetricStatusMetricId =
  | "RESTING_HEART_RATE"
  | "HEART_RATE_VARIABILITY"
  | "OXYGEN_SATURATION"
  | "RESPIRATORY_RATE"
  | "BODY_TEMPERATURE"
  | "SKIN_TEMPERATURE"
  | "BLOOD_GLUCOSE"
  | "WALKING_HEART_RATE_AVERAGE"
  | "PULSE_WAVE_VELOCITY"
  | "VASCULAR_AGE"
  | "STEPS"
  | "ACTIVE_ENERGY"
  | "FLIGHTS_CLIMBED"
  | "WALKING_RUNNING_DISTANCE"
  | "TIME_IN_DAYLIGHT"
  | "VO2_MAX"
  | "TOTAL_BODY_WATER"
  | "BONE_MASS"
  | "FAT_FREE_MASS"
  | "FAT_MASS"
  | "MUSCLE_MASS"
  | "LEAN_BODY_MASS"
  | "VISCERAL_FAT"
  | "WALKING_STEADINESS"
  | "WALKING_ASYMMETRY"
  | "WALKING_DOUBLE_SUPPORT"
  | "WALKING_STEP_LENGTH"
  | "WALKING_SPEED"
  | "AUDIO_EXPOSURE_ENV"
  | "AUDIO_EXPOSURE_HEADPHONE"
  | "AUDIO_EXPOSURE_EVENT"
  | "SLEEP_DURATION"
  // v1.10.0 — additive HealthKit signals (WX-A).
  | "CARDIO_RECOVERY"
  | "WRIST_TEMPERATURE"
  | "FALL_COUNT"
  | "SIX_MINUTE_WALK_DISTANCE"
  | "STAIR_ASCENT_SPEED"
  | "STAIR_DESCENT_SPEED"
  | "BREATHING_DISTURBANCES"
  // v1.18.1 — nightly sleep-quality headline (WHOOP / Oura sleep score).
  // Carries a generic assessment so the Sleep page reads one matching text
  // per distinct chart group (duration/architecture AND quality), meeting
  // the canonical "multiple charts ⇒ multiple texts" rule recovery meets.
  | "SLEEP_SCORE"
  // v1.18.1 — device-native recovery / strain signals (WHOOP / Polar /
  // Oura). Each carries a generic assessment so the rebuilt
  // `/insights/recovery` page reads one matching text per chart.
  | "ANS_CHARGE"
  | "DAY_STRAIN"
  | "WORKOUT_STRAIN"
  | "CARDIO_LOAD"
  | "AVERAGE_HEART_RATE"
  | "MAX_HEART_RATE"
  | "ENERGY_EXPENDITURE_KJ"
  // Garmin's day scores and the bridged training figures.
  | "BODY_BATTERY"
  | "STRESS_LEVEL"
  | "TRAINING_READINESS"
  | "ACUTE_TRAINING_LOAD"
  // v1.25 — physical / clinical signals promoted to detail pages. Grip
  // strength + waist carry a sex-aware band via the `norms.ts` tables the
  // generic generator already threads through `lookupNormalRange`.
  | "GRIP_STRENGTH"
  | "PAIN_NRS"
  | "WAIST_CIRCUMFERENCE"
  | "WAIST_TO_HEIGHT";

/**
 * The registry. Keyed by the HealthKit metric id. Each entry's
 * `measurementType` is the DB enum the rollup tier reads against.
 *
 * Normal ranges are coarse consumer/clinical anchors (resting-pulse
 * 60–100 bpm, SpO2 95–100 %, …) — present only where a broadly-accepted
 * placement exists. Body-composition mass metrics carry no fixed band:
 * a healthy fat-free mass depends entirely on body size, so the
 * `target-band` direction defers wholly to the user's own baseline.
 */
const REGISTRY: Record<MetricStatusMetricId, MetricStatusMeta> = {
  // ── physiological-vital ──
  RESTING_HEART_RATE: {
    id: "RESTING_HEART_RATE",
    measurementType: "RESTING_HEART_RATE",
    displayName: "Resting heart rate",
    unit: "bpm",
    direction: "lower-better",
    normalRange: { low: 50, high: 100 },
    archetype: "physiological-vital",
  },
  // HRV — no universal "normal" band (ESC/NASPE 1996): only the personal
  // trend is meaningful and overnight wearable RMSSD is not interchangeable
  // with the clinical 24-h SDNN norms. No `normalRange` by design; the user's
  // own baseline leads and single-night swings of ~±10% are routine noise
  // (see `reference-ranges.ts HEART_RATE_VARIABILITY.guidanceCaveat`).
  HEART_RATE_VARIABILITY: {
    id: "HEART_RATE_VARIABILITY",
    measurementType: "HEART_RATE_VARIABILITY",
    displayName: "Heart-rate variability (SDNN)",
    unit: "ms",
    direction: "higher-better",
    archetype: "physiological-vital",
  },
  // SpO₂ — healthy room-air 95–100% (StatPearls/NIH 2023). C4 equity note:
  // optical pulse oximeters can OVER-READ true saturation in people with
  // darker skin pigmentation (~3× more often than in lighter skin per the
  // US FDA 2024 review), so a single near-normal reading is not a clearance.
  // The band is unchanged; the caveat lives in the explainer copy +
  // `reference-ranges.ts OXYGEN_SATURATION.guidanceCaveat`. Do NOT set a
  // "higher is always better" goal — above ~98% adds no benefit.
  OXYGEN_SATURATION: {
    id: "OXYGEN_SATURATION",
    measurementType: "OXYGEN_SATURATION",
    displayName: "Blood oxygen (SpO₂)",
    unit: "%",
    direction: "higher-better",
    normalRange: { low: 95, high: 100 },
    archetype: "physiological-vital",
  },
  RESPIRATORY_RATE: {
    id: "RESPIRATORY_RATE",
    measurementType: "RESPIRATORY_RATE",
    displayName: "Respiratory rate",
    unit: "breaths/min",
    direction: "target-band",
    normalRange: { low: 12, high: 20 },
    archetype: "physiological-vital",
  },
  // Body temperature — the population oral-equivalent mean is ~36.6 °C, not
  // 37.0 °C, with a normal band ~35.7–37.4 °C and fever ≥ FEVER_BAND_C (J Gen
  // Intern Med systematic review, 2019). C6: the high anchor tightens
  // 37.5 → 37.2 so the band sits below the fever line; sites differ by up
  // to ~1 °C, so the read is a coarse placement only. D3-H1: the fever line is
  // the canonical `FEVER_BAND_C`, paired in one place with the engine's
  // sustained-fever escalation `FEVER_RED_FLAG_C`.
  BODY_TEMPERATURE: {
    id: "BODY_TEMPERATURE",
    measurementType: "BODY_TEMPERATURE",
    displayName: "Body temperature",
    unit: "°C",
    direction: "target-band",
    normalRange: { low: 36.1, high: 37.2 },
    feverBandC: FEVER_BAND_C,
    archetype: "physiological-vital",
  },
  SKIN_TEMPERATURE: {
    id: "SKIN_TEMPERATURE",
    measurementType: "SKIN_TEMPERATURE",
    displayName: "Wrist skin temperature",
    unit: "°C",
    direction: "target-band",
    archetype: "physiological-vital",
  },
  BLOOD_GLUCOSE: {
    id: "BLOOD_GLUCOSE",
    measurementType: "BLOOD_GLUCOSE",
    displayName: "Blood glucose",
    unit: "mg/dL",
    direction: "target-band",
    normalRange: { low: 70, high: 140 },
    archetype: "physiological-vital",
  },
  WALKING_HEART_RATE_AVERAGE: {
    id: "WALKING_HEART_RATE_AVERAGE",
    measurementType: "WALKING_HEART_RATE_AVERAGE",
    displayName: "Walking heart rate",
    unit: "bpm",
    direction: "lower-better",
    archetype: "physiological-vital",
  },
  // Pulse-wave velocity — the cf-PWV >10 m/s organ-damage marker is the
  // European clinical reference (ESC/ESH 2018). A consumer estimate is a
  // PROXY, not interchangeable with clinical cf-PWV tonometry; the band is
  // a coarse "below 10 is the reference side" placement only.
  PULSE_WAVE_VELOCITY: {
    id: "PULSE_WAVE_VELOCITY",
    measurementType: "PULSE_WAVE_VELOCITY",
    displayName: "Pulse-wave velocity",
    unit: "m/s",
    direction: "lower-better",
    normalRange: { low: 0, high: 10 },
    archetype: "physiological-vital",
  },
  VASCULAR_AGE: {
    id: "VASCULAR_AGE",
    measurementType: "VASCULAR_AGE",
    displayName: "Vascular age",
    unit: "years",
    direction: "lower-better",
    archetype: "physiological-vital",
  },
  // ── activity-fitness ──
  // Steps — C2/D4 reconcile: the canonical "green" floor is 8,000/day
  // (Saint-Maurice JAMA 2020: mortality risk falls steeply toward ~8k with
  // continued benefit through ~12k), aligning this display band with the
  // resolver + classifier so the cross-surface number stops contradicting.
  // The "10,000" target is a marketing slogan, not research.
  STEPS: {
    id: "STEPS",
    measurementType: "ACTIVITY_STEPS",
    displayName: "Steps",
    unit: "steps/day",
    direction: "higher-better",
    normalRange: { low: 8000, high: 15000 },
    archetype: "activity-fitness",
  },
  ACTIVE_ENERGY: {
    id: "ACTIVE_ENERGY",
    measurementType: "ACTIVE_ENERGY_BURNED",
    displayName: "Active energy",
    unit: "kcal/day",
    direction: "higher-better",
    archetype: "activity-fitness",
  },
  FLIGHTS_CLIMBED: {
    id: "FLIGHTS_CLIMBED",
    measurementType: "FLIGHTS_CLIMBED",
    displayName: "Flights climbed",
    unit: "flights/day",
    direction: "higher-better",
    archetype: "activity-fitness",
  },
  WALKING_RUNNING_DISTANCE: {
    id: "WALKING_RUNNING_DISTANCE",
    measurementType: "WALKING_RUNNING_DISTANCE",
    displayName: "Walking + running distance",
    unit: "m/day",
    direction: "higher-better",
    archetype: "activity-fitness",
  },
  TIME_IN_DAYLIGHT: {
    id: "TIME_IN_DAYLIGHT",
    measurementType: "TIME_IN_DAYLIGHT",
    displayName: "Time in daylight",
    unit: "min/day",
    direction: "higher-better",
    normalRange: { low: 30, high: 120 },
    archetype: "activity-fitness",
  },
  VO2_MAX: {
    id: "VO2_MAX",
    measurementType: "VO2_MAX",
    displayName: "VO₂ max (cardio fitness)",
    unit: "mL/(kg·min)",
    direction: "higher-better",
    archetype: "activity-fitness",
  },
  // ── body-composition ──
  TOTAL_BODY_WATER: {
    id: "TOTAL_BODY_WATER",
    measurementType: "TOTAL_BODY_WATER",
    displayName: "Total body water",
    unit: "kg",
    direction: "target-band",
    archetype: "body-composition",
  },
  BONE_MASS: {
    id: "BONE_MASS",
    measurementType: "BONE_MASS",
    displayName: "Bone mass",
    unit: "kg",
    direction: "target-band",
    archetype: "body-composition",
  },
  FAT_FREE_MASS: {
    id: "FAT_FREE_MASS",
    measurementType: "FAT_FREE_MASS",
    displayName: "Fat-free mass",
    unit: "kg",
    direction: "target-band",
    archetype: "body-composition",
  },
  FAT_MASS: {
    id: "FAT_MASS",
    measurementType: "FAT_MASS",
    displayName: "Fat mass",
    unit: "kg",
    direction: "lower-better",
    archetype: "body-composition",
  },
  MUSCLE_MASS: {
    id: "MUSCLE_MASS",
    measurementType: "MUSCLE_MASS",
    displayName: "Muscle mass",
    unit: "kg",
    direction: "higher-better",
    archetype: "body-composition",
  },
  LEAN_BODY_MASS: {
    id: "LEAN_BODY_MASS",
    measurementType: "LEAN_BODY_MASS",
    displayName: "Lean body mass",
    unit: "kg",
    direction: "target-band",
    archetype: "body-composition",
  },
  VISCERAL_FAT: {
    id: "VISCERAL_FAT",
    measurementType: "VISCERAL_FAT",
    displayName: "Visceral fat rating",
    unit: "rating",
    direction: "lower-better",
    normalRange: { low: 1, high: 12 },
    archetype: "body-composition",
  },
  // ── mobility-gait ──
  WALKING_STEADINESS: {
    id: "WALKING_STEADINESS",
    measurementType: "WALKING_STEADINESS",
    displayName: "Walking steadiness",
    unit: "%",
    direction: "higher-better",
    normalRange: { low: 50, high: 100 },
    archetype: "mobility-gait",
  },
  WALKING_ASYMMETRY: {
    id: "WALKING_ASYMMETRY",
    measurementType: "WALKING_ASYMMETRY",
    displayName: "Walking asymmetry",
    unit: "%",
    direction: "lower-better",
    archetype: "mobility-gait",
  },
  WALKING_DOUBLE_SUPPORT: {
    id: "WALKING_DOUBLE_SUPPORT",
    measurementType: "WALKING_DOUBLE_SUPPORT",
    displayName: "Double-support time",
    unit: "%",
    direction: "lower-better",
    normalRange: { low: 20, high: 40 },
    archetype: "mobility-gait",
  },
  WALKING_STEP_LENGTH: {
    id: "WALKING_STEP_LENGTH",
    measurementType: "WALKING_STEP_LENGTH",
    displayName: "Step length",
    unit: "m",
    direction: "higher-better",
    archetype: "mobility-gait",
  },
  WALKING_SPEED: {
    id: "WALKING_SPEED",
    measurementType: "WALKING_SPEED",
    displayName: "Walking speed",
    unit: "m/s",
    direction: "higher-better",
    normalRange: { low: 1.2, high: 1.4 },
    archetype: "mobility-gait",
  },
  // ── environmental-exposure ──
  AUDIO_EXPOSURE_ENV: {
    id: "AUDIO_EXPOSURE_ENV",
    measurementType: "AUDIO_EXPOSURE_ENV",
    displayName: "Environmental sound exposure",
    unit: "dBA",
    direction: "lower-better",
    normalRange: { low: 0, high: 80 },
    archetype: "environmental-exposure",
  },
  AUDIO_EXPOSURE_HEADPHONE: {
    id: "AUDIO_EXPOSURE_HEADPHONE",
    measurementType: "AUDIO_EXPOSURE_HEADPHONE",
    displayName: "Headphone audio exposure",
    unit: "dBA",
    direction: "lower-better",
    normalRange: { low: 0, high: 80 },
    archetype: "environmental-exposure",
  },
  AUDIO_EXPOSURE_EVENT: {
    id: "AUDIO_EXPOSURE_EVENT",
    measurementType: "AUDIO_EXPOSURE_EVENT",
    displayName: "Loud-exposure events",
    unit: "events",
    direction: "lower-better",
    archetype: "environmental-exposure",
  },
  // ── sleep (dedicated template) ──
  SLEEP_DURATION: {
    id: "SLEEP_DURATION",
    measurementType: "SLEEP_DURATION",
    // Stored in minutes (see schema MeasurementType.SLEEP_DURATION); the
    // template surfaces hours for the model's prose.
    displayName: "Sleep duration",
    unit: "min",
    direction: "target-band",
    normalRange: { low: 420, high: 540 },
    archetype: "sleep",
  },
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // Cardio recovery — bpm drop one minute after peak exercise. A larger
  // drop is the fitter, healthier signal (higher-better). No fixed band:
  // recovery scales with the peak HR + fitness, so the user's own
  // baseline leads. A blunted HRR1 (the long-cited Cole et al. NEJM 1999
  // ≤12 bpm marker) is a mortality predictor, but the absolute placement
  // depends on the workout intensity HealthLog does not capture here, so
  // we defer wholly to the user's trend rather than anchor a band.
  CARDIO_RECOVERY: {
    id: "CARDIO_RECOVERY",
    measurementType: "CARDIO_RECOVERY",
    displayName: "Cardio recovery",
    unit: "bpm",
    direction: "higher-better",
    archetype: "physiological-vital",
  },
  // Wrist temperature — overnight skin-side reading. Apple frames it as a
  // baseline deviation; we store the absolute °C and treat it as a
  // target-band metric whose anchor is the user's own nightly baseline.
  // No fixed population band: wrist (skin) temperature runs cooler than
  // core and varies by room temperature + bedding, so a hard band would
  // misplace it. The user's own series leads (same posture as
  // SKIN_TEMPERATURE).
  WRIST_TEMPERATURE: {
    id: "WRIST_TEMPERATURE",
    measurementType: "WRIST_TEMPERATURE",
    displayName: "Wrist temperature",
    unit: "°C",
    direction: "target-band",
    archetype: "physiological-vital",
  },
  // Fall count — fewer is better. Zero is the target; any sustained
  // non-zero count is a mobility-risk signal Apple surfaces prominently.
  FALL_COUNT: {
    id: "FALL_COUNT",
    measurementType: "FALL_COUNT",
    displayName: "Falls",
    unit: "falls/day",
    direction: "lower-better",
    archetype: "mobility-gait",
  },
  // Six-minute-walk distance — population reference for healthy adults is
  // ~400–700 m (ATS 2002 guideline + general-population reference
  // standards, Casanova et al. ERJ 2011 / population samples). The band
  // is a coarse placement aid; age, height, and sex shift it, so the
  // user's own baseline still leads.
  SIX_MINUTE_WALK_DISTANCE: {
    id: "SIX_MINUTE_WALK_DISTANCE",
    measurementType: "SIX_MINUTE_WALK_DISTANCE",
    displayName: "Six-minute walk distance",
    unit: "m",
    direction: "higher-better",
    normalRange: { low: 400, high: 700 },
    archetype: "mobility-gait",
  },
  // Stair ascent speed — faster is the fitter signal. No fixed band:
  // stair pace depends on stair geometry + leg length; the user's own
  // trend leads (same posture as WALKING_STEP_LENGTH).
  STAIR_ASCENT_SPEED: {
    id: "STAIR_ASCENT_SPEED",
    measurementType: "STAIR_ASCENT_SPEED",
    displayName: "Stair ascent speed",
    unit: "m/s",
    direction: "higher-better",
    archetype: "mobility-gait",
  },
  // Stair descent speed — gait companion to ascent speed.
  STAIR_DESCENT_SPEED: {
    id: "STAIR_DESCENT_SPEED",
    measurementType: "STAIR_DESCENT_SPEED",
    displayName: "Stair descent speed",
    unit: "m/s",
    direction: "higher-better",
    archetype: "mobility-gait",
  },
  // Breathing disturbances — per-night sleep-breathing index. Fewer is
  // better. Apple classifies the index as NotElevated / Elevated rather
  // than publishing a numeric cutoff, so no fixed band is encoded; the
  // direction + the user's own baseline carry the placement.
  BREATHING_DISTURBANCES: {
    id: "BREATHING_DISTURBANCES",
    measurementType: "BREATHING_DISTURBANCES",
    displayName: "Sleep breathing disturbances",
    unit: "count",
    direction: "lower-better",
    archetype: "sleep",
  },
  // Sleep score — the nightly headline sleep-quality score (WHOOP sleep
  // performance lineage / Oura sleep score), 0–100. Higher is the better
  // night. No fixed clinical band: the scales differ by device and the
  // user's own baseline carries the read; the assessment frames the trend.
  // Sits on the dedicated sleep template so its prose matches the duration
  // assessment's tone.
  SLEEP_SCORE: {
    id: "SLEEP_SCORE",
    measurementType: "SLEEP_SCORE",
    displayName: "Sleep score",
    unit: "score",
    direction: "higher-better",
    archetype: "sleep",
  },
  // ── v1.18.1 device-native recovery / strain signals ──
  // ANS charge — autonomic-nervous-system recharge (Polar Nightly
  // Recharge / ring readiness lineage). Higher = better recovered. No
  // fixed band: the device scales differ, so the user's own baseline
  // leads (target-band defers wholly to it).
  ANS_CHARGE: {
    id: "ANS_CHARGE",
    measurementType: "ANS_CHARGE",
    displayName: "ANS charge",
    unit: "score",
    direction: "higher-better",
    archetype: "physiological-vital",
  },
  // Day strain — WHOOP's 0–21 cardiovascular-load scale. Neither extreme
  // is a goal on its own (high strain with poor recovery is the risk);
  // the read is descriptive against the user's own pattern.
  DAY_STRAIN: {
    id: "DAY_STRAIN",
    measurementType: "DAY_STRAIN",
    displayName: "Day strain",
    unit: "score",
    direction: "target-band",
    archetype: "activity-fitness",
  },
  // Workout strain — per-workout strain on the same 0–21 scale.
  WORKOUT_STRAIN: {
    id: "WORKOUT_STRAIN",
    measurementType: "WORKOUT_STRAIN",
    displayName: "Workout strain",
    unit: "score",
    direction: "target-band",
    archetype: "activity-fitness",
  },
  // ── Garmin ──
  // Body Battery — Garmin's 0–100 energy reserve; the day's highest charge.
  BODY_BATTERY: {
    id: "BODY_BATTERY",
    measurementType: "BODY_BATTERY",
    displayName: "Body Battery",
    unit: "score",
    direction: "higher-better",
    archetype: "physiological-vital",
  },
  // Stress level — Garmin's 0–100 all-day average; lower is calmer.
  STRESS_LEVEL: {
    id: "STRESS_LEVEL",
    measurementType: "STRESS_LEVEL",
    displayName: "Stress level",
    unit: "score",
    direction: "lower-better",
    archetype: "physiological-vital",
  },
  // Training readiness — Garmin's 0–100 morning readiness, bridged in.
  TRAINING_READINESS: {
    id: "TRAINING_READINESS",
    measurementType: "TRAINING_READINESS",
    displayName: "Training readiness",
    unit: "score",
    direction: "higher-better",
    archetype: "physiological-vital",
  },
  // Acute training load — Garmin's seven-day load, bridged in. Descriptive
  // against the personal baseline like cardio load.
  ACUTE_TRAINING_LOAD: {
    id: "ACUTE_TRAINING_LOAD",
    measurementType: "ACUTE_TRAINING_LOAD",
    displayName: "Acute training load",
    unit: "load",
    direction: "target-band",
    archetype: "activity-fitness",
  },
  // Cardio load — training-load proxy (acute cardiovascular load).
  // Descriptive against the personal baseline.
  CARDIO_LOAD: {
    id: "CARDIO_LOAD",
    measurementType: "CARDIO_LOAD",
    displayName: "Cardio load",
    unit: "score",
    direction: "target-band",
    archetype: "activity-fitness",
  },
  // Whole-day average heart rate (WHOOP cycle average). Lower at rest is
  // the fitter signal, but this is a whole-cycle figure, so it is read as
  // a target-band against the user's own days rather than a flat lower.
  AVERAGE_HEART_RATE: {
    id: "AVERAGE_HEART_RATE",
    measurementType: "AVERAGE_HEART_RATE",
    displayName: "Average heart rate",
    unit: "bpm",
    direction: "target-band",
    archetype: "physiological-vital",
  },
  // Whole-day peak heart rate (WHOOP cycle max).
  MAX_HEART_RATE: {
    id: "MAX_HEART_RATE",
    measurementType: "MAX_HEART_RATE",
    displayName: "Max heart rate",
    unit: "bpm",
    direction: "target-band",
    archetype: "physiological-vital",
  },
  // Day energy expenditure in kilojoules (WHOOP reports kJ natively).
  // Higher reflects a more active day; no fixed band.
  ENERGY_EXPENDITURE_KJ: {
    id: "ENERGY_EXPENDITURE_KJ",
    measurementType: "ENERGY_EXPENDITURE_KJ",
    displayName: "Energy expenditure",
    unit: "kJ",
    direction: "higher-better",
    archetype: "activity-fitness",
  },
  // ── v1.25 — physical / clinical signals ──
  // Grip strength — EWGSOP2 strength-limb marker. The flat 16 kg floor is the
  // women's cut-off; the sex-aware `norms.ts` table sharpens it (men 27 /
  // women 16) when the profile carries sex. Fields mirror the signal-registry
  // entry exactly so the registry-invariant projection deep-equals this row.
  GRIP_STRENGTH: {
    id: "GRIP_STRENGTH",
    measurementType: "GRIP_STRENGTH",
    displayName: "Grip strength",
    unit: "kg",
    direction: "higher-better",
    normalRange: { low: 16, high: 60 },
    archetype: "activity-fitness",
  },
  // Pain NRS — the validated 0–10 numeric rating; lower is better, the
  // no-pain/mild band sits at 0–3.
  PAIN_NRS: {
    id: "PAIN_NRS",
    measurementType: "PAIN_NRS",
    displayName: "Pain (0–10 NRS)",
    unit: "score",
    direction: "lower-better",
    normalRange: { low: 0, high: 3 },
    archetype: "physiological-vital",
  },
  // Waist circumference — WHO increased-risk threshold. The flat 94 cm anchor
  // is the men's cut-off; the sex-aware `norms.ts` table sharpens it (men 94 /
  // women 80) when the profile carries sex.
  WAIST_CIRCUMFERENCE: {
    id: "WAIST_CIRCUMFERENCE",
    measurementType: "WAIST_CIRCUMFERENCE",
    displayName: "Waist circumference",
    unit: "cm",
    direction: "lower-better",
    normalRange: { low: 0, high: 94 },
    archetype: "body-composition",
  },
  // Waist-to-height ratio — NICE keep-waist-under-half-your-height rule. WHtR
  // ≥ 0.5 flags increased risk, so the last in-range value is 0.49.
  WAIST_TO_HEIGHT: {
    id: "WAIST_TO_HEIGHT",
    measurementType: "WAIST_TO_HEIGHT",
    displayName: "Waist-to-height ratio",
    unit: "ratio",
    direction: "lower-better",
    normalRange: { low: 0, high: 0.49 },
    archetype: "body-composition",
  },
};

/** Closed set of ids the generic route accepts (Zod enum source). */
export const METRIC_STATUS_IDS = Object.keys(
  REGISTRY,
) as MetricStatusMetricId[];

/** Type guard narrowing an arbitrary string to a registered metric id. */
export function isMetricStatusId(value: string): value is MetricStatusMetricId {
  return Object.prototype.hasOwnProperty.call(REGISTRY, value);
}

/** Resolve the metadata for a metric id, or null when unregistered. */
export function getMetricStatusMeta(metric: string): MetricStatusMeta | null {
  return isMetricStatusId(metric) ? REGISTRY[metric] : null;
}

/**
 * Reverse index: the DB `MeasurementType` → the generic metric id it backs
 * (built once at module load). A handful of types map under a different id
 * than their literal name (`ACTIVITY_STEPS` → `STEPS`,
 * `ACTIVE_ENERGY_BURNED` → `ACTIVE_ENERGY`); every other registered type
 * is its own id. Types with no registry entry (the seven specialised
 * metrics, WORKOUTS, …) are simply absent.
 */
const MEASUREMENT_TYPE_TO_METRIC_ID = new Map<
  MeasurementType,
  MetricStatusMetricId
>(
  (Object.values(REGISTRY) as MetricStatusMeta[]).map((meta) => [
    meta.measurementType,
    meta.id,
  ]),
);

/**
 * Resolve the generic metric id a `MeasurementType` feeds, or null when
 * the type carries no generic assessment card. Used by the ingest
 * invalidation path to re-warm the matching `metric:<ID>` scope when a
 * fresh measurement of a data-bearing type lands.
 */
export function metricIdForMeasurementType(
  type: MeasurementType,
): MetricStatusMetricId | null {
  return MEASUREMENT_TYPE_TO_METRIC_ID.get(type) ?? null;
}

/**
 * The cache/scope id for a metric assessment. The `metric:` prefix keeps
 * the generic scopes disjoint from the seven bare specialised scope
 * slugs while the trailing `-status.` substring (appended at cache-key
 * time, like every other scope) keeps the eviction + invalidation
 * sweeps matching. Example cache action:
 * `insights.metric:RESTING_HEART_RATE-status.de`.
 */
export function metricStatusScope(
  metric: MetricStatusMetricId,
): `metric:${MetricStatusMetricId}` {
  return `metric:${metric}`;
}
