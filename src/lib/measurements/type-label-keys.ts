/**
 * Per-measurement-type i18n label keys.
 *
 * Extracted from `measurement-list-meta.ts` so consumers that only need the
 * label map — the report selection catalogue, the jsPDF renderer, the public
 * clinician share view, any server component — do not pull the lucide icon
 * components into their module graph. The original module re-exports this map,
 * so there is one source of truth and no import site had to change.
 *
 * The `Record<MeasurementType, string>` annotation is the guarantee: a new
 * enum member without a label fails `pnpm typecheck` rather than reaching a
 * surface as a raw enum string.
 */
import type { MeasurementType } from "@/generated/prisma/client";

export const MEASUREMENT_TYPE_LABEL_KEYS: Record<MeasurementType, string> = {
  WEIGHT: "measurements.typeWeight",
  BLOOD_PRESSURE_SYS: "measurements.typeBpSys",
  BLOOD_PRESSURE_DIA: "measurements.typeBpDia",
  PULSE: "measurements.typePulse",
  BODY_FAT: "measurements.typeBodyFat",
  SLEEP_DURATION: "measurements.typeSleep",
  ACTIVITY_STEPS: "measurements.typeSteps",
  BLOOD_GLUCOSE: "measurements.typeBloodGlucose",
  BLOOD_KETONES: "measurements.typeBloodKetones",
  TOTAL_BODY_WATER: "measurements.typeTotalBodyWater",
  BONE_MASS: "measurements.typeBoneMass",
  OXYGEN_SATURATION: "measurements.typeOxygenSaturation",
  // ── v1.4.23 Apple Health additions ──
  HEART_RATE_VARIABILITY: "measurements.typeHeartRateVariability",
  RESTING_HEART_RATE: "measurements.typeRestingHeartRate",
  ACTIVE_ENERGY_BURNED: "measurements.typeActiveEnergyBurned",
  BASAL_ENERGY_BURNED: "measurements.typeBasalEnergyBurned",
  FLIGHTS_CLIMBED: "measurements.typeFlightsClimbed",
  WALKING_RUNNING_DISTANCE: "measurements.typeWalkingRunningDistance",
  VO2_MAX: "measurements.typeVo2Max",
  BODY_TEMPERATURE: "measurements.typeBodyTemperature",
  // ── v1.4.25 W5d Withings full coverage ──
  FAT_FREE_MASS: "measurements.typeFatFreeMass",
  FAT_MASS: "measurements.typeFatMass",
  MUSCLE_MASS: "measurements.typeMuscleMass",
  SKIN_TEMPERATURE: "measurements.typeSkinTemperature",
  PULSE_WAVE_VELOCITY: "measurements.typePulseWaveVelocity",
  VASCULAR_AGE: "measurements.typeVascularAge",
  VISCERAL_FAT: "measurements.typeVisceralFat",
  // ── v1.4.25 W8d Apple Health server-prep ──
  AUDIO_EXPOSURE_ENV: "measurements.typeAudioExposureEnv",
  AUDIO_EXPOSURE_HEADPHONE: "measurements.typeAudioExposureHeadphone",
  TIME_IN_DAYLIGHT: "measurements.typeTimeInDaylight",
  // ── v1.4.30 R-F T1.4 + T1.5 ──
  WALKING_STEADINESS: "measurements.typeWalkingSteadiness",
  AUDIO_EXPOSURE_EVENT: "measurements.typeAudioExposureEvent",
  // ── v1.5.5 iOS-coord additions ──
  RESPIRATORY_RATE: "measurements.typeRespiratoryRate",
  BODY_MASS_INDEX: "measurements.typeBodyMassIndex",
  LEAN_BODY_MASS: "measurements.typeLeanBodyMass",
  WALKING_HEART_RATE_AVERAGE: "measurements.typeWalkingHeartRateAverage",
  WALKING_ASYMMETRY: "measurements.typeWalkingAsymmetry",
  WALKING_DOUBLE_SUPPORT: "measurements.typeWalkingDoubleSupport",
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  WALKING_STEP_LENGTH: "measurements.typeWalkingStepLength",
  WALKING_SPEED: "measurements.typeWalkingSpeed",
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  CARDIO_RECOVERY: "measurements.typeCardioRecovery",
  WRIST_TEMPERATURE: "measurements.typeWristTemperature",
  FALL_COUNT: "measurements.typeFallCount",
  SIX_MINUTE_WALK_DISTANCE: "measurements.typeSixMinuteWalkDistance",
  STAIR_ASCENT_SPEED: "measurements.typeStairAscentSpeed",
  STAIR_DESCENT_SPEED: "measurements.typeStairDescentSpeed",
  BREATHING_DISTURBANCES: "measurements.typeBreathingDisturbances",
  // ── v1.10.0 — categorical events (WX-B) ──
  IRREGULAR_RHYTHM_NOTIFICATION: "measurements.typeIrregularRhythmNotification",
  HIGH_HEART_RATE_EVENT: "measurements.typeHighHeartRateEvent",
  LOW_HEART_RATE_EVENT: "measurements.typeLowHeartRateEvent",
  HYPERTENSION_EVENT: "measurements.typeHypertensionEvent",
  LOW_CARDIO_FITNESS_EVENT: "measurements.typeLowCardioFitnessEvent",
  MENOPAUSAL_STATE: "measurements.typeMenopausalState",
  BLEEDING_AFTER_MENOPAUSE: "measurements.typeBleedingAfterMenopause",
  INSULIN_DELIVERY: "measurements.typeInsulinDelivery",
  INHALER_USAGE: "measurements.typeInhalerUsage",
  FEV1: "measurements.typeFev1",
  FVC: "measurements.typeFvc",
  PEAK_EXPIRATORY_FLOW: "measurements.typePeakExpiratoryFlow",
  WALKING_STEADINESS_EVENT: "measurements.typeWalkingSteadinessEvent",
  BREATHING_DISTURBANCE_EVENT: "measurements.typeBreathingDisturbanceEvent",
  // ── v1.10.0 — computed scores (WX-C) ──
  RECOVERY_SCORE: "measurements.typeRecoveryScore",
  STRESS_SCORE: "measurements.typeStressScore",
  STRAIN_SCORE: "measurements.typeStrainScore",
  // ── v1.11.0 — WHOOP-native score classes ──
  HRV_RMSSD: "measurements.typeHrvRmssd",
  DAY_STRAIN: "measurements.typeDayStrain",
  WORKOUT_STRAIN: "measurements.typeWorkoutStrain",
  SLEEP_PERFORMANCE: "measurements.typeSleepPerformance",
  SLEEP_EFFICIENCY: "measurements.typeSleepEfficiency",
  SLEEP_CONSISTENCY: "measurements.typeSleepConsistency",
  SLEEP_NEED: "measurements.typeSleepNeed",
  ENERGY_EXPENDITURE_KJ: "measurements.typeEnergyExpenditureKj",
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion ──
  AVERAGE_HEART_RATE: "measurements.typeAverageHeartRate",
  MAX_HEART_RATE: "measurements.typeMaxHeartRate",
  SLEEP_DISTURBANCE_COUNT: "measurements.typeSleepDisturbanceCount",
  // ── v1.17.1 — Polar Nightly Recharge + Training Load Pro components ──
  ANS_CHARGE: "measurements.typeAnsCharge",
  CARDIO_LOAD: "measurements.typeCardioLoad",
  // ── v1.17.1 — Oura coverage completion ──
  SLEEP_SCORE: "measurements.typeSleepScore",
  BODY_TEMPERATURE_DEVIATION: "measurements.typeBodyTemperatureDeviation",
  // ── v1.19.0 — Oura resilience ──
  RESILIENCE: "measurements.typeResilience",
  // ── v1.25 — clinical-signals wave ──
  PHQ9_SCORE: "measurements.typePhq9Score",
  GAD7_SCORE: "measurements.typeGad7Score",
  // ── v1.27.9 — screening scores ──
  WHO5_SCORE: "measurements.typeWho5Score",
  SCI_SCORE: "measurements.typeSciScore",
  // ── v1.44 — activity rings, mindfulness, State of Mind, AFib burden ──
  EXERCISE_MINUTES: "measurements.typeExerciseMinutes",
  STAND_MINUTES: "measurements.typeStandMinutes",
  STAND_HOURS: "measurements.typeStandHours",
  MINDFUL_MINUTES: "measurements.typeMindfulMinutes",
  STATE_OF_MIND_VALENCE: "measurements.typeStateOfMindValence",
  AFIB_BURDEN: "measurements.typeAfibBurden",
  WORKOUT_EFFORT_SCORE: "measurements.typeWorkoutEffortScore",
  ESTIMATED_WORKOUT_EFFORT_SCORE:
    "measurements.typeEstimatedWorkoutEffortScore",
  PHYSICAL_EFFORT: "measurements.typePhysicalEffort",
  // Apple sport quantities (#1415).
  CYCLING_DISTANCE: "measurements.typeCyclingDistance",
  ROWING_DISTANCE: "measurements.typeRowingDistance",
  ROWING_SPEED: "measurements.typeRowingSpeed",
  RUNNING_SPEED: "measurements.typeRunningSpeed",
  RUNNING_POWER: "measurements.typeRunningPower",
  RUNNING_GROUND_CONTACT_TIME: "measurements.typeRunningGroundContactTime",
  RUNNING_VERTICAL_OSCILLATION: "measurements.typeRunningVerticalOscillation",
  RUNNING_STRIDE_LENGTH: "measurements.typeRunningStrideLength",
  INDOOR_CO2: "measurements.typeIndoorCo2",
  INDOOR_TEMPERATURE: "measurements.typeIndoorTemperature",
  INDOOR_HUMIDITY: "measurements.typeIndoorHumidity",
  BODY_BATTERY: "measurements.typeBodyBattery",
  STRESS_LEVEL: "measurements.typeStressLevel",
  TRAINING_READINESS: "measurements.typeTrainingReadiness",
  ACUTE_TRAINING_LOAD: "measurements.typeAcuteTrainingLoad",
  GRIP_STRENGTH: "measurements.typeGripStrength",
  PAIN_NRS: "measurements.typePainNrs",
  WAIST_CIRCUMFERENCE: "measurements.typeWaistCircumference",
  WAIST_TO_HEIGHT: "measurements.typeWaistToHeight",
};

/**
 * Short forms for the places a metric name has one line: a tile header, a
 * trend-strip label, a list row's type line. Each value is the glossary's
 * `short` for the metric (`src/lib/i18n/glossary.json`, the concept whose
 * `shortKey` names it), agreed with the iOS client so both shorten alike; a
 * locale without a short carries the full name under the key. Running text,
 * tooltips, accessible names and the doctor report keep the full name.
 * Read it through `metricName`, never directly: the glossary guard holds
 * this map, the bundle and the glossary to one another.
 */
export const MEASUREMENT_TYPE_SHORT_LABEL_KEYS: Partial<
  Record<MeasurementType, string>
> = {
  TOTAL_BODY_WATER: "measurements.shortTypeTotalBodyWater",
  RESTING_HEART_RATE: "measurements.shortTypeRestingHeartRate",
  BLOOD_GLUCOSE: "measurements.shortTypeBloodGlucose",
  WALKING_RUNNING_DISTANCE: "measurements.shortTypeWalkingRunningDistance",
  SKIN_TEMPERATURE: "measurements.shortTypeSkinTemperature",
  AUDIO_EXPOSURE_ENV: "measurements.shortTypeAudioExposureEnv",
  AUDIO_EXPOSURE_HEADPHONE: "measurements.shortTypeAudioExposureHeadphone",
  TIME_IN_DAYLIGHT: "measurements.shortTypeTimeInDaylight",
  AUDIO_EXPOSURE_EVENT: "measurements.shortTypeAudioExposureEvent",
  RESPIRATORY_RATE: "measurements.shortTypeRespiratoryRate",
  LEAN_BODY_MASS: "measurements.shortTypeLeanBodyMass",
  WALKING_HEART_RATE_AVERAGE: "measurements.shortTypeWalkingHeartRateAverage",
  WALKING_DOUBLE_SUPPORT: "measurements.shortTypeWalkingDoubleSupport",
  WALKING_SPEED: "measurements.shortTypeWalkingSpeed",
  CARDIO_RECOVERY: "measurements.shortTypeCardioRecovery",
  WRIST_TEMPERATURE: "measurements.shortTypeWristTemperature",
  SIX_MINUTE_WALK_DISTANCE: "measurements.shortTypeSixMinuteWalkDistance",
  STAIR_ASCENT_SPEED: "measurements.shortTypeStairAscentSpeed",
  IRREGULAR_RHYTHM_NOTIFICATION:
    "measurements.shortTypeIrregularRhythmNotification",
  HIGH_HEART_RATE_EVENT: "measurements.shortTypeHighHeartRateEvent",
  LOW_HEART_RATE_EVENT: "measurements.shortTypeLowHeartRateEvent",
  HYPERTENSION_EVENT: "measurements.shortTypeHypertensionEvent",
  LOW_CARDIO_FITNESS_EVENT: "measurements.shortTypeLowCardioFitnessEvent",
  INSULIN_DELIVERY: "measurements.shortTypeInsulinDelivery",
  PEAK_EXPIRATORY_FLOW: "measurements.shortTypePeakExpiratoryFlow",
  WALKING_STEADINESS_EVENT: "measurements.shortTypeWalkingSteadinessEvent",
  BREATHING_DISTURBANCE_EVENT:
    "measurements.shortTypeBreathingDisturbanceEvent",
  SLEEP_NEED: "measurements.shortTypeSleepNeed",
  AVERAGE_HEART_RATE: "measurements.shortTypeAverageHeartRate",
  MAX_HEART_RATE: "measurements.shortTypeMaxHeartRate",
  BODY_TEMPERATURE_DEVIATION: "measurements.shortTypeBodyTemperatureDeviation",
  WHO5_SCORE: "measurements.shortTypeWho5Score",
  MINDFUL_MINUTES: "measurements.shortTypeMindfulMinutes",
  WORKOUT_EFFORT_SCORE: "measurements.shortTypeWorkoutEffortScore",
  ESTIMATED_WORKOUT_EFFORT_SCORE:
    "measurements.shortTypeEstimatedWorkoutEffortScore",
  PHYSICAL_EFFORT: "measurements.shortTypePhysicalEffort",
  CYCLING_DISTANCE: "measurements.shortTypeCyclingDistance",
  RUNNING_GROUND_CONTACT_TIME: "measurements.shortTypeRunningGroundContactTime",
  RUNNING_VERTICAL_OSCILLATION:
    "measurements.shortTypeRunningVerticalOscillation",
  RUNNING_STRIDE_LENGTH: "measurements.shortTypeRunningStrideLength",
  INDOOR_HUMIDITY: "measurements.shortTypeIndoorHumidity",
  ACUTE_TRAINING_LOAD: "measurements.shortTypeAcuteTrainingLoad",
  WAIST_CIRCUMFERENCE: "measurements.shortTypeWaistCircumference",
  WAIST_TO_HEIGHT: "measurements.shortTypeWaistToHeight",
  BODY_MASS_INDEX: "measurements.shortTypeBodyMassIndex",
  HEART_RATE_VARIABILITY: "measurements.shortTypeHeartRateVariability",
  HRV_RMSSD: "measurements.shortTypeHrvRmssd",
  SCI_SCORE: "measurements.shortTypeSciScore",
  AFIB_BURDEN: "measurements.shortTypeAfibBurden",
  SLEEP_SCORE: "measurements.shortTypeSleepScore",
  RECOVERY_SCORE: "measurements.shortTypeRecoveryScore",
  STRESS_SCORE: "measurements.shortTypeStressScore",
  STRAIN_SCORE: "measurements.shortTypeStrainScore",
};

/** A metric's full name and the form for a one-line slot. */
export interface MetricName {
  /** The name for running text, tooltips, accessible names and reports. */
  full: string;
  /** The name for a one-line slot; the full name when there is no short. */
  short: string;
}

/**
 * The one way a surface names a measurement type. An unknown type reads as
 * itself in both forms rather than as a missing key.
 */
/**
 * Metrics read as one value that are no single `MeasurementType`: blood
 * pressure is systolic over diastolic, the Health score and readiness are
 * composed. Same contract as the maps above, the
 * full name and the glossary's short form, reached through `metricName`.
 */
export const COMPOSITE_METRIC_LABEL_KEYS = {
  BLOOD_PRESSURE: {
    full: "measurements.typeBloodPressure",
    short: "measurements.shortTypeBloodPressure",
  },
  HEALTH_SCORE: {
    full: "insights.healthScore.label",
    short: "measurements.shortTypeHealthScore",
  },
  READINESS: {
    full: "insights.derived.composite.READINESS.title",
    short: "measurements.shortTypeReadiness",
  },
} as const;

export function metricName(
  type: string,
  t: (key: string) => string,
): MetricName {
  if (Object.hasOwn(COMPOSITE_METRIC_LABEL_KEYS, type)) {
    const keys =
      COMPOSITE_METRIC_LABEL_KEYS[
        type as keyof typeof COMPOSITE_METRIC_LABEL_KEYS
      ];
    return { full: t(keys.full), short: t(keys.short) };
  }
  const fullKey = MEASUREMENT_TYPE_LABEL_KEYS[type as MeasurementType];
  const full = fullKey ? t(fullKey) : type;
  const shortKey = MEASUREMENT_TYPE_SHORT_LABEL_KEYS[type as MeasurementType];
  return { full, short: shortKey ? t(shortKey) : full };
}
