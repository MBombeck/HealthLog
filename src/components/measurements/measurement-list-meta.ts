/**
 * Per-measurement-type display metadata for the measurements list view.
 *
 * Extracted into its own module so we can:
 *   1. Run a coverage test that asserts every Zod-enum measurement type has
 *      an entry in every map (so future enum additions can't silently fall
 *      through to the raw-string fallback — which was the root cause of
 *      issue #109).
 *   2. Reuse the same icon/color set in adjacent surfaces (mobile list,
 *      edit dialog) without re-declaring it.
 *
 * Lead-architect note: this is the first step toward a single
 * `metrics.json` manifest the entire ecosystem derives from. Today this
 * module covers list-UI; phase P5 will subsume it into a cross-repo
 * manifest.
 */
import {
  Scale,
  Heart,
  Activity,
  Droplets,
  Droplet,
  Moon,
  Footprints,
  Bone,
  Wind,
  HeartPulse,
  Flame,
  TrendingUp,
  Thermometer,
  Gauge,
  Dumbbell,
  Volume2,
  Headphones,
  Sun,
  PersonStanding,
  Waves,
  type LucideIcon,
} from "lucide-react";

export const MEASUREMENT_TYPE_LABEL_KEYS: Record<string, string> = {
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
  GRIP_STRENGTH: "measurements.typeGripStrength",
  PAIN_NRS: "measurements.typePainNrs",
  WAIST_CIRCUMFERENCE: "measurements.typeWaistCircumference",
  WAIST_TO_HEIGHT: "measurements.typeWaistToHeight",
};

export const MEASUREMENT_TYPE_ICONS: Record<string, LucideIcon> = {
  WEIGHT: Scale,
  BLOOD_PRESSURE_SYS: Heart,
  BLOOD_PRESSURE_DIA: Heart,
  PULSE: Activity,
  BODY_FAT: Droplets,
  SLEEP_DURATION: Moon,
  ACTIVITY_STEPS: Footprints,
  BLOOD_GLUCOSE: Droplet,
  TOTAL_BODY_WATER: Droplet,
  BONE_MASS: Bone,
  OXYGEN_SATURATION: Wind,
  // ── v1.4.23 Apple Health additions ──
  HEART_RATE_VARIABILITY: HeartPulse,
  RESTING_HEART_RATE: Heart,
  ACTIVE_ENERGY_BURNED: Flame,
  FLIGHTS_CLIMBED: TrendingUp,
  WALKING_RUNNING_DISTANCE: Footprints,
  VO2_MAX: Gauge,
  BODY_TEMPERATURE: Thermometer,
  // ── v1.4.25 W5d Withings full coverage ──
  // Body-composition trio: Scale carries the mass-family (FFM is the
  // weight residual after fat); Droplets carries the fat-family
  // (BODY_FAT already uses it, so FAT_MASS + VISCERAL_FAT match);
  // Dumbbell is reserved for muscle so the three rows stay distinct
  // in the list view.
  FAT_FREE_MASS: Scale,
  FAT_MASS: Droplets,
  MUSCLE_MASS: Dumbbell,
  SKIN_TEMPERATURE: Thermometer,
  PULSE_WAVE_VELOCITY: Activity,
  VASCULAR_AGE: HeartPulse,
  VISCERAL_FAT: Droplets,
  // ── v1.4.25 W8d Apple Health server-prep ──
  // Volume2 carries the ambient-audio family (concert/traffic icon
  // convention), Headphones is the obvious AirPods-listening cue, and
  // Sun mirrors Apple Health's own time-in-daylight tile.
  AUDIO_EXPOSURE_ENV: Volume2,
  AUDIO_EXPOSURE_HEADPHONE: Headphones,
  TIME_IN_DAYLIGHT: Sun,
  // ── v1.4.30 R-F T1.4 + T1.5 ──
  // Activity/Gauge carries the mobility-steadiness signal (same
  // family as VO2_MAX). Volume2 is reused for the loud-listening
  // event flag — the event is a louder-cousin of the env quantity.
  WALKING_STEADINESS: Gauge,
  AUDIO_EXPOSURE_EVENT: Volume2,
  // ── v1.5.5 iOS-coord additions ──
  // Wind already carries the breathing family (SpO2 uses it);
  // Scale carries body-comp; HeartPulse rounds out the cardio
  // pair; Footprints + Gauge live in the gait family.
  RESPIRATORY_RATE: Wind,
  BODY_MASS_INDEX: Scale,
  LEAN_BODY_MASS: Scale,
  WALKING_HEART_RATE_AVERAGE: HeartPulse,
  WALKING_ASYMMETRY: Footprints,
  WALKING_DOUBLE_SUPPORT: Footprints,
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  // Footprints carries the stride/length signal; Gauge mirrors
  // the velocity-reading shape (same family as VO2_MAX +
  // WALKING_STEADINESS).
  WALKING_STEP_LENGTH: Footprints,
  WALKING_SPEED: Gauge,
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // HeartPulse carries the post-exercise cardiac-recovery signal;
  // Thermometer the overnight wrist reading; PersonStanding the
  // fall-detection tally; Gauge the gait-speed family (stairs + 6MWT);
  // Wind rounds out the sleep-breathing signal (SpO2 + resp rate
  // already use it).
  CARDIO_RECOVERY: HeartPulse,
  WRIST_TEMPERATURE: Thermometer,
  FALL_COUNT: PersonStanding,
  SIX_MINUTE_WALK_DISTANCE: Footprints,
  STAIR_ASCENT_SPEED: Gauge,
  STAIR_DESCENT_SPEED: Gauge,
  BREATHING_DISTURBANCES: Wind,
  // ── v1.10.0 — categorical events (WX-B) ──
  // Activity carries the irregular-rhythm trace shape; HeartPulse the
  // high/low-HR cardio pair; Footprints the steadiness/mobility family;
  // Wind the breathing family (SpO2 + respiratory rate already use it).
  IRREGULAR_RHYTHM_NOTIFICATION: Activity,
  HIGH_HEART_RATE_EVENT: HeartPulse,
  LOW_HEART_RATE_EVENT: HeartPulse,
  WALKING_STEADINESS_EVENT: Footprints,
  BREATHING_DISTURBANCE_EVENT: Wind,
  // ── v1.10.0 — computed scores (WX-C) ──
  // Gauge reads as a composite "index / score" dial for all three.
  RECOVERY_SCORE: Gauge,
  STRESS_SCORE: Gauge,
  STRAIN_SCORE: Gauge,
  // ── v1.11.0 — WHOOP-native score classes ──
  // Gauge reads as a composite "index / score" dial for the strain +
  // sleep-quality composites; the sleep-need recommendation borrows Moon
  // (sleep family), RMSSD borrows HeartPulse (cardiac), energy borrows
  // Flame (energy family, like ACTIVE_ENERGY_BURNED).
  HRV_RMSSD: HeartPulse,
  DAY_STRAIN: Gauge,
  WORKOUT_STRAIN: Gauge,
  SLEEP_PERFORMANCE: Moon,
  SLEEP_EFFICIENCY: Moon,
  SLEEP_CONSISTENCY: Moon,
  SLEEP_NEED: Moon,
  ENERGY_EXPENDITURE_KJ: Flame,
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion ──
  // HeartPulse + Heart carry the daily-aggregate cardiac pair (same family
  // as the other heart-rate signals); Waves reads as the per-night
  // sleep-disturbance signal.
  AVERAGE_HEART_RATE: HeartPulse,
  MAX_HEART_RATE: Heart,
  SLEEP_DISTURBANCE_COUNT: Waves,
  // ── v1.17.1 — Polar Nightly Recharge + Training Load Pro components ──
  // HeartPulse reads as the autonomic-charge signal; Gauge carries the
  // cardio-load strain figure (same family as DAY_STRAIN).
  ANS_CHARGE: HeartPulse,
  CARDIO_LOAD: Gauge,
  // ── v1.17.1 — Oura coverage completion ──
  SLEEP_SCORE: Moon,
  BODY_TEMPERATURE_DEVIATION: Thermometer,
  // ── v1.19.0 — Oura resilience ──
  // Gauge reads as the composite "index / level" dial, matching the other
  // recovery / score composites (RECOVERY_SCORE, DAY_STRAIN).
  RESILIENCE: Gauge,
  // ── v1.25 — clinical-signals wave ──
  // Gauge reads as the screener-score dial; Dumbbell carries grip strength;
  // Activity the pain trace; Scale the anthropometric waist pair.
  PHQ9_SCORE: Gauge,
  GAD7_SCORE: Gauge,
  // ── v1.27.9 — screening scores ride the same composite-dial icon ──
  WHO5_SCORE: Gauge,
  SCI_SCORE: Gauge,
  GRIP_STRENGTH: Dumbbell,
  PAIN_NRS: Activity,
  WAIST_CIRCUMFERENCE: Scale,
  WAIST_TO_HEIGHT: Scale,
};

// The colour map lives in its own icon-free module so a surface that only
// needs the colours (the timeline's value lines) does not pull every icon.
export { MEASUREMENT_TYPE_COLORS } from "./measurement-type-colors";

/**
 * Count-shaped types whose stored unit is a source token ("count",
 * "count/min", "steps") rather than a word a reader should see. The list
 * shows the same localised unit the type's insights page uses, so a row
 * reads "13 Etagen", not "13 count".
 */
export const MEASUREMENT_UNIT_LABEL_KEYS: Partial<Record<string, string>> = {
  ACTIVITY_STEPS: "insights.units.steps",
  FLIGHTS_CLIMBED: "insights.units.flights",
  FALL_COUNT: "insights.units.falls",
  BREATHING_DISTURBANCES: "insights.units.breathingEvents",
  RESPIRATORY_RATE: "insights.units.respiratoryRate",
};

/** The unit a list row shows for `type`: the localised word, else `unit`. */
export function measurementUnitLabel(
  type: string,
  unit: string,
  t: (key: string) => string,
): string {
  const key = MEASUREMENT_UNIT_LABEL_KEYS[type];
  if (key) return t(key);
  // A score or a rating is a bare number; "72 score" reads as a stray
  // English token next to the German label, not as a unit.
  if (UNITLESS_TOKENS.has(unit)) return "";
  return unit;
}

const UNITLESS_TOKENS: ReadonlySet<string> = new Set(["score", "rating"]);

/**
 * The unit as the lead of a row's meta line ("kg · 2 days ago"), or null
 * when the row has no unit word to show: a score or a rating would otherwise
 * open the line with a bare separator.
 */
export function measurementUnitMetaLead(
  type: string,
  unit: string,
  t: (key: string) => string,
): string | null {
  const label = measurementUnitLabel(type, unit, t);
  return label ? `${label} · ` : null;
}
