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
};

export const MEASUREMENT_TYPE_COLORS: Record<string, string> = {
  WEIGHT: "bg-chart-1/20 text-chart-1",
  BLOOD_PRESSURE_SYS: "bg-chart-3/20 text-chart-3",
  BLOOD_PRESSURE_DIA: "bg-chart-3/20 text-chart-3",
  PULSE: "bg-chart-5/20 text-chart-5",
  BODY_FAT: "bg-chart-4/20 text-chart-4",
  SLEEP_DURATION: "bg-chart-2/20 text-chart-2",
  ACTIVITY_STEPS: "bg-chart-2/20 text-chart-2",
  BLOOD_GLUCOSE: "bg-chart-3/20 text-chart-3",
  TOTAL_BODY_WATER: "bg-chart-2/20 text-chart-2",
  BONE_MASS: "bg-chart-4/20 text-chart-4",
  OXYGEN_SATURATION: "bg-chart-5/20 text-chart-5",
  // ── v1.4.23 Apple Health additions ──
  HEART_RATE_VARIABILITY: "bg-chart-5/20 text-chart-5",
  RESTING_HEART_RATE: "bg-chart-3/20 text-chart-3",
  ACTIVE_ENERGY_BURNED: "bg-chart-4/20 text-chart-4",
  FLIGHTS_CLIMBED: "bg-chart-2/20 text-chart-2",
  WALKING_RUNNING_DISTANCE: "bg-chart-2/20 text-chart-2",
  VO2_MAX: "bg-chart-1/20 text-chart-1",
  BODY_TEMPERATURE: "bg-chart-4/20 text-chart-4",
  // ── v1.4.25 W5d Withings full coverage ──
  // chart-1 (mass), chart-3 (cardio), chart-4 (fat/temp), chart-5
  // (pulse-derived) — extend the existing color-family conventions.
  FAT_FREE_MASS: "bg-chart-1/20 text-chart-1",
  FAT_MASS: "bg-chart-4/20 text-chart-4",
  MUSCLE_MASS: "bg-chart-1/20 text-chart-1",
  SKIN_TEMPERATURE: "bg-chart-4/20 text-chart-4",
  PULSE_WAVE_VELOCITY: "bg-chart-5/20 text-chart-5",
  VASCULAR_AGE: "bg-chart-3/20 text-chart-3",
  VISCERAL_FAT: "bg-chart-4/20 text-chart-4",
  // ── v1.4.25 W8d Apple Health server-prep ──
  // chart-5 (pulse / sound family) carries audio exposure; chart-2
  // (activity / daylight family) carries time-in-daylight so the
  // existing palette conventions hold.
  AUDIO_EXPOSURE_ENV: "bg-chart-5/20 text-chart-5",
  AUDIO_EXPOSURE_HEADPHONE: "bg-chart-5/20 text-chart-5",
  TIME_IN_DAYLIGHT: "bg-chart-2/20 text-chart-2",
};
