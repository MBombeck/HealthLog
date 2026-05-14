/**
 * Apple HealthKit identifier → HealthLog measurement mapping.
 *
 * Mirrors the Withings `MEASURE_TYPE_MAP` in `src/lib/withings/client.ts`
 * but keyed by the HealthKit string identifier rather than a numeric
 * type code. The `POST /api/measurements/batch` endpoint walks each
 * inbound HealthKit sample through `mapAppleHealthEntry()` to produce
 * the row shape the existing `Measurement` model expects.
 *
 * Adding a new identifier is a one-place change — append an entry to
 * `APPLE_HEALTH_TYPE_MAP`. The unit-conversion helper, the canonical
 * DB unit, and the aggregation hint all live alongside the identifier
 * so future analytics work has a single discoverable surface.
 *
 * Identifier mappings derived from open-source reference projects:
 *   - k0rventen/apple-health-grafana (MIT) — `ingester/ingester.py`
 *     ROUTE_AND_FORMAT type map cross-checked against Apple's
 *     `HKQuantityTypeIdentifier` index.
 *   - dogsheep/healthkit-to-sqlite (Apache-2.0) —
 *     `healthkit_to_sqlite/utils.py` workout/sample identifier list.
 * Only the lookup data (HKQuantityTypeIdentifier* string → HealthLog
 * MeasurementType) was ported; no upstream code is incorporated. The
 * unit, conversion, and aggregation columns are HealthLog-specific
 * decisions checked against Apple's HKUnit documentation.
 */
import type { MeasurementType, SleepStage } from "@/generated/prisma/client";

/**
 * How a batch of HealthKit samples for the same identifier should be
 * reduced into stored `Measurement` rows. The batch ingest endpoint
 * stores every sample as-is in v1.4.23 — the aggregation hint is
 * advisory metadata for downstream summarisation (analytics, AI
 * Coach evidence chips). Future work can move the reduction earlier
 * in the pipeline once we observe the production sample volume.
 */
export type AppleHealthAggregation =
  | "sum"
  | "mean"
  | "latest"
  | "max"
  | "median";

export interface AppleHealthMapping {
  /** HealthKit identifier (e.g. `HKQuantityTypeIdentifierBodyMass`). */
  hkIdentifier: string;
  /** HealthLog `MeasurementType` enum value. */
  measurementType: MeasurementType;
  /** Apple's HK unit string (e.g. `kg`, `count/min`, `mL/(kg*min)`). */
  hkUnit: string;
  /** HealthLog canonical DB unit (must match `getUnitForType()`). */
  dbUnit: string;
  /** Convert a HK sample value into the canonical DB unit. Identity for most. */
  convertToDbUnit: (hkValue: number) => number;
  /** Advisory aggregation hint — see `AppleHealthAggregation` doc. */
  aggregation: AppleHealthAggregation;
  /**
   * `true` for metrics behind an explicit consent screen (HRV, VO2 Max,
   * sleep stages). The iOS app is responsible for asking; the server
   * trusts the inbound batch. Recorded here so the server-side audit
   * trail can flag privacy-sensitive ingest separately if needed.
   */
  isPrivacySensitive?: boolean;
  /**
   * Numeric `HKCategoryValueSleepAnalysis` → `SleepStage` map, only
   * populated for `HKCategoryTypeIdentifierSleepAnalysis`. Apple's
   * value enum is integer-valued; we accept the integer in the inbound
   * sample and look up the DB-side stage here.
   */
  sleepStageMap?: Record<number, SleepStage>;
}

/**
 * Numeric values of `HKCategoryValueSleepAnalysis`. Apple's enum is
 * platform-versioned; the values below match the iOS 16+ codepoints.
 * Legacy iOS 15- only emits `inBed` (0) and `asleepUnspecified` (1) —
 * the latter maps to `ASLEEP` so old samples still round-trip.
 *
 * Source: Apple's `HealthKit/HKCategoryValueSleepAnalysis.h` header.
 */
export const APPLE_HEALTH_SLEEP_STAGE_MAP: Record<number, SleepStage> = {
  0: "IN_BED",
  1: "ASLEEP", // legacy iOS 15- `asleepUnspecified`
  2: "AWAKE",
  3: "CORE", // iOS 16+ `asleepCore`
  4: "DEEP", // iOS 16+ `asleepDeep`
  5: "REM", // iOS 16+ `asleepREM`
};

/**
 * The mapping table. `convertToDbUnit` is identity for most metrics
 * because we picked DB units that match Apple's defaults. Two
 * exceptions:
 *
 * - `HKQuantityTypeIdentifierOxygenSaturation` ships as a 0..1
 *   fraction; HealthLog stores percent (0..100).
 * - `HKQuantityTypeIdentifierBodyFatPercentage` ships as a 0..1
 *   fraction; HealthLog stores percent (0..100).
 */
export const APPLE_HEALTH_TYPE_MAP: Record<string, AppleHealthMapping> = {
  // ── Body composition ────────────────────────────────────────
  HKQuantityTypeIdentifierBodyMass: {
    hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
    measurementType: "WEIGHT",
    hkUnit: "kg",
    dbUnit: "kg",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  HKQuantityTypeIdentifierBodyFatPercentage: {
    hkIdentifier: "HKQuantityTypeIdentifierBodyFatPercentage",
    measurementType: "BODY_FAT",
    hkUnit: "%",
    dbUnit: "%",
    // Apple ships 0..1 fraction; HealthLog stores 0..100.
    convertToDbUnit: (v) => v * 100,
    aggregation: "latest",
  },
  HKQuantityTypeIdentifierBodyTemperature: {
    hkIdentifier: "HKQuantityTypeIdentifierBodyTemperature",
    measurementType: "BODY_TEMPERATURE",
    hkUnit: "degC",
    dbUnit: "celsius",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },

  // ── Cardiovascular ──────────────────────────────────────────
  HKQuantityTypeIdentifierBloodPressureSystolic: {
    hkIdentifier: "HKQuantityTypeIdentifierBloodPressureSystolic",
    measurementType: "BLOOD_PRESSURE_SYS",
    hkUnit: "mmHg",
    dbUnit: "mmHg",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  HKQuantityTypeIdentifierBloodPressureDiastolic: {
    hkIdentifier: "HKQuantityTypeIdentifierBloodPressureDiastolic",
    measurementType: "BLOOD_PRESSURE_DIA",
    hkUnit: "mmHg",
    dbUnit: "mmHg",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  HKQuantityTypeIdentifierHeartRate: {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
    measurementType: "PULSE",
    hkUnit: "count/min",
    dbUnit: "bpm",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  HKQuantityTypeIdentifierRestingHeartRate: {
    hkIdentifier: "HKQuantityTypeIdentifierRestingHeartRate",
    measurementType: "RESTING_HEART_RATE",
    hkUnit: "count/min",
    dbUnit: "bpm",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
    measurementType: "HEART_RATE_VARIABILITY",
    hkUnit: "ms",
    dbUnit: "ms",
    convertToDbUnit: (v) => v,
    aggregation: "mean",
    isPrivacySensitive: true,
  },

  // ── Activity (cumulative) ───────────────────────────────────
  HKQuantityTypeIdentifierStepCount: {
    hkIdentifier: "HKQuantityTypeIdentifierStepCount",
    // Reuses existing enum value (the W1 research recommended this
    // over a parallel STEP_COUNT value to avoid analytics-side
    // duplication; see `.planning/phase-W1-v1423-research.md`).
    measurementType: "ACTIVITY_STEPS",
    hkUnit: "count",
    dbUnit: "steps",
    convertToDbUnit: (v) => v,
    aggregation: "sum",
  },
  HKQuantityTypeIdentifierActiveEnergyBurned: {
    hkIdentifier: "HKQuantityTypeIdentifierActiveEnergyBurned",
    measurementType: "ACTIVE_ENERGY_BURNED",
    hkUnit: "kcal",
    dbUnit: "kcal",
    convertToDbUnit: (v) => v,
    aggregation: "sum",
  },
  HKQuantityTypeIdentifierFlightsClimbed: {
    hkIdentifier: "HKQuantityTypeIdentifierFlightsClimbed",
    measurementType: "FLIGHTS_CLIMBED",
    hkUnit: "count",
    dbUnit: "flights",
    convertToDbUnit: (v) => v,
    aggregation: "sum",
  },
  HKQuantityTypeIdentifierDistanceWalkingRunning: {
    hkIdentifier: "HKQuantityTypeIdentifierDistanceWalkingRunning",
    measurementType: "WALKING_RUNNING_DISTANCE",
    hkUnit: "m",
    dbUnit: "m",
    convertToDbUnit: (v) => v,
    aggregation: "sum",
  },

  // ── Fitness ─────────────────────────────────────────────────
  HKQuantityTypeIdentifierVO2Max: {
    hkIdentifier: "HKQuantityTypeIdentifierVO2Max",
    measurementType: "VO2_MAX",
    hkUnit: "mL/(kg*min)",
    dbUnit: "mL/(kg·min)",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
    isPrivacySensitive: true,
  },

  // ── Other in-scope metrics already mapped via existing enums ──
  HKQuantityTypeIdentifierBloodGlucose: {
    hkIdentifier: "HKQuantityTypeIdentifierBloodGlucose",
    measurementType: "BLOOD_GLUCOSE",
    hkUnit: "mg/dL",
    dbUnit: "mg/dL",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  HKQuantityTypeIdentifierOxygenSaturation: {
    hkIdentifier: "HKQuantityTypeIdentifierOxygenSaturation",
    measurementType: "OXYGEN_SATURATION",
    hkUnit: "fraction",
    dbUnit: "%",
    // Apple ships 0..1 fraction; HealthLog stores 0..100.
    convertToDbUnit: (v) => v * 100,
    aggregation: "latest",
  },

  // ── Sleep (category type) ───────────────────────────────────
  HKCategoryTypeIdentifierSleepAnalysis: {
    hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
    measurementType: "SLEEP_DURATION",
    hkUnit: "category",
    dbUnit: "minutes",
    // value here is duration-in-minutes (caller computes
    // `endDate - startDate` and converts to minutes); the per-stage
    // label arrives in `sleepStage` and is mapped via `sleepStageMap`.
    convertToDbUnit: (v) => v,
    aggregation: "sum",
    isPrivacySensitive: true,
    sleepStageMap: APPLE_HEALTH_SLEEP_STAGE_MAP,
  },

  // ── v1.4.25 W8d Apple Health server-prep ────────────────────
  // Environmental audio exposure — Watch + iPhone microphone, sampled
  // every ~30 s while the Watch is worn. Apple's HK identifier is
  // `HKQuantityTypeIdentifierEnvironmentalAudioExposure` despite the
  // categorical name; the value is a continuous dBA SPL number.
  HKQuantityTypeIdentifierEnvironmentalAudioExposure: {
    hkIdentifier: "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
    measurementType: "AUDIO_EXPOSURE_ENV",
    hkUnit: "dBASPL",
    dbUnit: "dBA",
    convertToDbUnit: (v) => v,
    aggregation: "mean",
  },
  // Headphone audio exposure — AirPods + supported Beats earbuds.
  // Apple's "Reduce Loud Sounds" warning triggers at 80 dBA average
  // over 7 days; we keep the canonical unit as plain dBA so the
  // analytics layer doesn't have to thread a separate weighting flag.
  HKQuantityTypeIdentifierHeadphoneAudioExposure: {
    hkIdentifier: "HKQuantityTypeIdentifierHeadphoneAudioExposure",
    measurementType: "AUDIO_EXPOSURE_HEADPHONE",
    hkUnit: "dBASPL",
    dbUnit: "dBA",
    convertToDbUnit: (v) => v,
    aggregation: "mean",
  },
  // Time in daylight — iOS 17+ Health app metric, derived from Watch
  // ambient-light + GPS. One sample per day in practice; the DB unit
  // is minutes (Apple ships `min` directly).
  HKQuantityTypeIdentifierTimeInDaylight: {
    hkIdentifier: "HKQuantityTypeIdentifierTimeInDaylight",
    measurementType: "TIME_IN_DAYLIGHT",
    hkUnit: "min",
    dbUnit: "minutes",
    convertToDbUnit: (v) => v,
    aggregation: "sum",
  },
};

/**
 * HK identifiers the iOS app may emit that HealthLog deliberately does
 * NOT map yet. Listing them here means the batch route can log a
 * "deferred, not unknown" signal and the iOS DTO can decide upstream
 * to skip the request altogether — both better than silently dropping
 * the row inside `mapAppleHealthEntry()`.
 *
 * Each entry is paired with the planned-shipment release in
 * `apple-health-ecosystem-scan.md` §7 (v1.5 baseline; later releases
 * carry the long-tail). Refresh this set when a mapping moves out of
 * defer status above so the test in
 * `__tests__/apple-health-mapping.test.ts` flags double-bookings.
 */
export const HK_QUANTITY_TYPE_DEFERRED = new Set<string>([
  // Body composition / vitals — v1.5
  "HKQuantityTypeIdentifierBodyMassIndex", // computed from weight + height — never stored
  "HKQuantityTypeIdentifierHeight", // already on User.heightCm
  "HKQuantityTypeIdentifierLeanBodyMass",
  "HKQuantityTypeIdentifierRespiratoryRate",
  "HKQuantityTypeIdentifierWalkingHeartRateAverage",
  "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
  "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
  "HKQuantityTypeIdentifierBasalEnergyBurned",
  "HKQuantityTypeIdentifierAppleExerciseTime", // implied by Workout rows
  "HKQuantityTypeIdentifierAppleStandTime", // implied by Workout rows
  "HKCategoryTypeIdentifierAppleStandHour", // implied by Workout rows
  // Running / walking form — v1.5+
  "HKQuantityTypeIdentifierWalkingSpeed",
  "HKQuantityTypeIdentifierWalkingStepLength",
  "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
  "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
  "HKQuantityTypeIdentifierStairAscentSpeed",
  "HKQuantityTypeIdentifierStairDescentSpeed",
  "HKQuantityTypeIdentifierSixMinuteWalkTestDistance",
  "HKQuantityTypeIdentifierRunningSpeed",
  "HKQuantityTypeIdentifierRunningPower",
  "HKQuantityTypeIdentifierRunningStrideLength",
  "HKQuantityTypeIdentifierRunningGroundContactTime",
  "HKQuantityTypeIdentifierRunningVerticalOscillation",
  // Cycling (iOS 17) — v1.5
  "HKQuantityTypeIdentifierCyclingCadence",
  "HKQuantityTypeIdentifierCyclingFunctionalThresholdPower",
  "HKQuantityTypeIdentifierCyclingPower",
  "HKQuantityTypeIdentifierCyclingSpeed",
  "HKQuantityTypeIdentifierDistanceCycling",
  // Sport-specific distances + speeds (iOS 18) — v1.5+
  "HKQuantityTypeIdentifierDistanceCrossCountrySkiing",
  "HKQuantityTypeIdentifierCrossCountrySkiingSpeed",
  "HKQuantityTypeIdentifierDistancePaddleSports",
  "HKQuantityTypeIdentifierPaddleSportsSpeed",
  "HKQuantityTypeIdentifierDistanceRowing",
  "HKQuantityTypeIdentifierRowingSpeed",
  "HKQuantityTypeIdentifierDistanceSkatingSports",
  "HKQuantityTypeIdentifierDistanceSwimming",
  "HKQuantityTypeIdentifierSwimmingStrokeCount",
  // Workout-effort scores (iOS 18) — v1.5+
  "HKQuantityTypeIdentifierEstimatedWorkoutEffortScore",
  "HKQuantityTypeIdentifierWorkoutEffortScore",
  "HKQuantityTypeIdentifierPhysicalEffort",
  // Sleep apnea + breathing (iOS 18) — v1.5+
  "HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances",
  "HKCategoryTypeIdentifierSleepApneaEvent",
  // Nutrition — Marc directive, indefinite hold
  "HKQuantityTypeIdentifierDietaryWater",
  "HKQuantityTypeIdentifierDietaryCaffeine",
  "HKQuantityTypeIdentifierDietaryEnergyConsumed",
  "HKQuantityTypeIdentifierDietaryCarbohydrates",
  "HKQuantityTypeIdentifierDietaryProtein",
  "HKQuantityTypeIdentifierDietaryFatTotal",
  "HKQuantityTypeIdentifierDietarySugar",
  "HKQuantityTypeIdentifierDietaryFiber",
  "HKQuantityTypeIdentifierDietarySodium",
  // Mental-state / mindfulness — v1.5 (route to existing mood model)
  "HKCategoryTypeIdentifierMindfulSession",
  "HKDataTypeIdentifierStateOfMind",
  // Pregnancy / cycle — explicit hold (privacy stance)
  "HKCategoryTypeIdentifierBleedingAfterPregnancy",
  "HKCategoryTypeIdentifierBleedingDuringPregnancy",
  "HKCategoryTypeIdentifierMenstrualFlow",
  "HKCategoryTypeIdentifierIntermenstrualBleeding",
  "HKCategoryTypeIdentifierCervicalMucusQuality",
  "HKCategoryTypeIdentifierOvulationTestResult",
  // Clinical (FHIR) — v1.6+
  "HKClinicalTypeIdentifierAllergyRecord",
  "HKClinicalTypeIdentifierConditionRecord",
  "HKClinicalTypeIdentifierImmunizationRecord",
  "HKClinicalTypeIdentifierLabResultRecord",
  "HKClinicalTypeIdentifierMedicationRecord",
  "HKClinicalTypeIdentifierProcedureRecord",
  "HKClinicalTypeIdentifierVitalSignRecord",
  // ECG / waveforms — defer
  "HKElectrocardiogramType",
  // Scored assessments (iOS 18) — v1.5 (PHQ-9 / GAD-7 mapping TBD)
  "HKScoredAssessmentTypeIdentifierGAD7",
  "HKScoredAssessmentTypeIdentifierPHQ9",
  // ── v1.4.25 W16a — iOS-17 + iOS-18 long-tail closure ──
  // Cardiovascular / clinical (iOS 16+) — no HealthLog counterpart yet;
  // clinical decision-support territory, defer behind a stricter user
  // opt-in than the existing Health-share prompt.
  "HKQuantityTypeIdentifierAtrialFibrillationBurden",
  "HKQuantityTypeIdentifierPeripheralPerfusionIndex",
  // Mobility (iOS 15+) — surface as a wellness signal in v1.5 once the
  // Insights cardio sub-page has room for a steadiness gauge.
  "HKQuantityTypeIdentifierAppleWalkingSteadiness",
  "HKQuantityTypeIdentifierNumberOfTimesFallen",
  "HKCategoryTypeIdentifierAppleWalkingSteadinessEvent",
  // Respiratory / pulmonary clinical (iOS 17) — pair with FHIR clinical
  // bucket; no Measurement enum mapping today.
  "HKQuantityTypeIdentifierForcedExpiratoryVolume1",
  "HKQuantityTypeIdentifierForcedVitalCapacity",
  "HKQuantityTypeIdentifierPeakExpiratoryFlowRate",
  "HKQuantityTypeIdentifierInhalerUsage",
  // Other quantity identifiers — explicit hold (privacy / not in scope).
  "HKQuantityTypeIdentifierInsulinDelivery",
  "HKQuantityTypeIdentifierUVExposure",
  "HKQuantityTypeIdentifierElectrodermalActivity",
  "HKQuantityTypeIdentifierBloodAlcoholContent",
  "HKQuantityTypeIdentifierNikeFuel", // legacy Nike+iPod fitness points
  // Heart-rhythm event flags (iOS 9+ but watch-detected; iOS 18
  // refreshed surfaces) — would land as Measurement annotations rather
  // than rows; defer until the annotation column lands.
  "HKCategoryTypeIdentifierLowHeartRateEvent",
  "HKCategoryTypeIdentifierHighHeartRateEvent",
  "HKCategoryTypeIdentifierIrregularHeartRhythmEvent",
  "HKCategoryTypeIdentifierLowCardioFitnessEvent",
  // Audio-exposure events (iOS 13+) — the continuous AUDIO_EXPOSURE_*
  // quantity identifiers ARE mapped above; these are the
  // "loud-event-fired" flags that pair with them. Defer until we
  // surface event chips in the Insights audio sub-page.
  "HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent",
  "HKCategoryTypeIdentifierHeadphoneAudioExposureEvent",
  "HKCategoryTypeIdentifierEnvironmentalSoundReduction",
  // Behavioural / habit category-types — not in HealthLog scope yet.
  "HKCategoryTypeIdentifierHandwashingEvent",
  "HKCategoryTypeIdentifierToothbrushingEvent",
  // Reproductive / fertility / pregnancy — explicit privacy hold
  // (matches the menstrual-flow stance already encoded above).
  "HKCategoryTypeIdentifierContraceptive",
  "HKCategoryTypeIdentifierLactation",
  "HKCategoryTypeIdentifierPregnancy",
  "HKCategoryTypeIdentifierPregnancyTestResult",
  "HKCategoryTypeIdentifierProgesteroneTestResult",
  "HKCategoryTypeIdentifierSexualActivity",
  "HKCategoryTypeIdentifierSleepChanges",
  "HKCategoryTypeIdentifierPersistentIntermenstrualBleeding",
  "HKCategoryTypeIdentifierProlongedMenstrualPeriods",
  "HKCategoryTypeIdentifierIrregularMenstrualCycles",
  "HKCategoryTypeIdentifierInfrequentMenstrualCycles",
] as const);

/** Input to `mapAppleHealthEntry()`. */
export interface AppleHealthEntryInput {
  hkIdentifier: string;
  /** Numeric value as Apple delivers it (pre-conversion). */
  value: number;
  /** Apple's unit string, captured for audit; not currently validated. */
  unit: string;
  /** ISO timestamp string (e.g. HealthKit `startDate`). */
  startDate: string;
  /** ISO timestamp string (e.g. HealthKit `endDate`). */
  endDate: string;
  /**
   * For `HKCategoryTypeIdentifierSleepAnalysis` only — the integer
   * `HKCategoryValueSleepAnalysis` codepoint. Ignored for quantity
   * types.
   */
  sleepStage?: number;
}

/** Output of `mapAppleHealthEntry()`. */
export interface AppleHealthEntryOutput {
  type: MeasurementType;
  value: number;
  unit: string;
  takenAt: Date;
  /** Set only for sleep entries. */
  sleepStage?: SleepStage;
}

/**
 * Map a single inbound HealthKit sample into the row shape the
 * `Measurement` model expects. Returns `null` if the identifier is
 * unknown — the caller should treat that as a "skipped" entry rather
 * than a hard error so a single rogue sample doesn't poison a batch.
 *
 * - `takenAt` is the sample's `endDate` because that's the moment the
 *   measurement was completed (Apple's convention; matches our
 *   existing `measuredAt` semantics for Withings).
 * - For sleep samples the inbound `value` is duration-in-minutes
 *   (caller computes `endDate - startDate` and divides by 60_000); we
 *   reproduce that contract here without re-deriving from the dates so
 *   the helper is decoupled from clock-skew between iOS and the server.
 */
export function mapAppleHealthEntry(
  input: AppleHealthEntryInput,
): AppleHealthEntryOutput | null {
  const mapping = APPLE_HEALTH_TYPE_MAP[input.hkIdentifier];
  if (!mapping) return null;

  const takenAt = new Date(input.endDate);
  if (Number.isNaN(takenAt.getTime())) return null;

  const value = mapping.convertToDbUnit(input.value);

  const out: AppleHealthEntryOutput = {
    type: mapping.measurementType,
    value,
    unit: mapping.dbUnit,
    takenAt,
  };

  if (mapping.sleepStageMap) {
    if (input.sleepStage === undefined) return null;
    const stage = mapping.sleepStageMap[input.sleepStage];
    if (!stage) return null;
    out.sleepStage = stage;
  }

  return out;
}
