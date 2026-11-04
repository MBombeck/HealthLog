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
  TOTAL_BODY_WATER: "measurements.typeTotalBodyWater",
  BONE_MASS: "measurements.typeBoneMass",
  OXYGEN_SATURATION: "measurements.typeOxygenSaturation",
  // ── v1.4.23 Apple Health additions ──
  HEART_RATE_VARIABILITY: "measurements.typeHeartRateVariability",
  RESTING_HEART_RATE: "measurements.typeRestingHeartRate",
  ACTIVE_ENERGY_BURNED: "measurements.typeActiveEnergyBurned",
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
