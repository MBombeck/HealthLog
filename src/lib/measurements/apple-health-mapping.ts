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
import type {
  MeasurementType,
  SleepStage,
  RhythmClassification,
} from "@/generated/prisma/client";
import { convertHkValue } from "./hk-units";

/**
 * How a batch of HealthKit samples for the same identifier should be
 * reduced into stored `Measurement` rows. The batch ingest endpoint
 * stores every sample as-is in v1.4.23 — the aggregation hint is
 * advisory metadata for downstream summarisation (analytics, AI
 * Coach evidence chips). Future work can move the reduction earlier
 * in the pipeline once we observe the production sample volume.
 */
export type AppleHealthAggregation =
  "sum" | "mean" | "latest" | "max" | "median";

export interface AppleHealthMapping {
  /** HealthKit identifier (e.g. `HKQuantityTypeIdentifierBodyMass`). */
  hkIdentifier: string;
  /** HealthLog `MeasurementType` enum value. */
  measurementType: MeasurementType;
  /** Apple's HK unit string (e.g. `kg`, `count/min`, `mL/(kg*min)`). */
  hkUnit: string;
  /**
   * issue #944 — why this entry's `hkUnit` can be trusted as fixed.
   *
   * Apple's `export.xml` writes the ACCOUNT's display unit on every
   * quantity `<Record>`, not the unit this table assumes, so
   * `mapAppleHealthEntry()` converts the reading from the record's own
   * unit into `hkUnit` before `convertToDbUnit` runs. That only works for
   * a unit `convertHkValue()` knows a factor for. An entry whose `hkUnit`
   * is NOT convertible (a dimensionless count, a pinned event, a
   * logarithmic dB level, a compound rate) must say here why no record
   * unit can change its reading — the structural guard
   * `src/__tests__/apple-health-unit-audit-guard.test.ts` fails on an
   * entry that offers neither.
   */
  unitFixedReason?: string;
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
  /**
   * v1.10.0 — categorical events (WX-B). For the EVENT-class HealthKit
   * category identifiers (irregular-rhythm / high-HR / low-HR /
   * walking-steadiness / breathing-disturbance), maps the inbound
   * `HKCategoryValue` integer codepoint to the device's verdict /
   * severity (`RhythmClassification`).
   *
   * HealthLog NEVER re-derives this — the value is the result the
   * device's own certified on-device algorithm already produced. When a
   * mapping carries an `eventClassificationMap`, `mapAppleHealthEntry`
   * resolves the codepoint to a `RhythmClassification`, forcing the
   * stored `value` to 1 (one fired event) regardless of the inbound
   * number. A codepoint absent from the map falls back to the entry's
   * `fallbackClassification` so an unseen Apple codepoint is recorded as
   * a (gracefully degraded) event rather than dropped.
   */
  eventClassificationMap?: Record<number, RhythmClassification>;
  /**
   * v1.10.0 — fallback verdict for an EVENT identifier whose inbound
   * codepoint is missing / unknown. Only set alongside
   * `eventClassificationMap`. The high/low-HR + breathing events have a
   * single neutral `FIRED` verdict and a `notApplicable` (0) codepoint;
   * they rely on this fallback rather than enumerating the codepoint.
   */
  fallbackClassification?: RhythmClassification;
}

/**
 * v1.10.0 — categorical events (WX-B).
 *
 * `HKCategoryValueAppleWalkingSteadinessEvent` codepoints → the device's
 * own severity verdict. Apple grades the falls-risk mobility flag as
 * initial/repeat × low/very-low; HealthLog collapses the initial/repeat
 * distinction (it is a re-notification of the same severity) into the two
 * severity bands the awareness timeline surfaces.
 *
 * Source: Apple's `HKCategoryValueAppleWalkingSteadinessEvent` enum.
 */
export const APPLE_HEALTH_WALKING_STEADINESS_EVENT_MAP: Record<
  number,
  RhythmClassification
> = {
  1: "LOW", // initialLow
  2: "LOW", // repeatLow
  3: "VERY_LOW", // initialVeryLow
  4: "VERY_LOW", // repeatVeryLow
};

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
 *
 * ── Project convention: server-side scaling is canonical ─────────────
 *
 * Every HealthKit value travels over the wire as the raw HK reading.
 * Whatever ×100 / unit-bend / clamp the canonical DB shape needs, the
 * server applies it at ingest inside `convertToDbUnit`. Two reasons:
 *
 *   1. The wire contract is the HK contract — iOS clients (and any
 *      future Health Connect / Garmin / Fitbit bridge) emit the
 *      native sensor reading without per-platform pre-massaging.
 *   2. The conversion lives next to the canonical DB unit + the
 *      plausibility-range guard, so a future contributor adding a
 *      new identifier touches one file instead of three.
 *
 * The pre-existing precedents already follow the convention:
 *
 *   - `HKQuantityTypeIdentifierOxygenSaturation` (0..1 → 0..100)
 *   - `HKQuantityTypeIdentifierBodyFatPercentage` (0..1 → 0..100)
 *   - `HKQuantityTypeIdentifierAppleWalkingSteadiness` (0..1 → 0..100)
 *
 * The v1.5.5 gait additions (`walkingAsymmetryPercentage` +
 * `walkingDoubleSupportPercentage`) extend the precedent. Older iOS
 * releases pre-multiplied those two identifiers by ×100 before
 * upload (a footgun the audit team flagged); the iOS client is on
 * track to drop the pre-multiplication so every HK percent flows
 * through the same canonical server-side scaling path. The coord
 * note in `.planning/ios-coord/` documents the one-release shim and
 * the migration window.
 *
 * ── Convention split — percent vs raw SI ───────────────────────────
 *
 * The ×100 scaling applies ONLY to identifiers Apple ships as a
 * 0..1 fraction:
 *
 *   - `oxygenSaturation`
 *   - `bodyFatPercentage`
 *   - `appleWalkingSteadiness`
 *   - `walkingAsymmetryPercentage`
 *   - `walkingDoubleSupportPercentage`
 *
 * Identifiers that already ride raw SI units on the wire pass
 * through `convertToDbUnit` as identity — no scaling, no clamp. The
 * v1.5.5 follow-up additions `walkingStepLength` (metres) and
 * `walkingSpeed` (metres per second) belong to this second bucket
 * and must NOT be scaled. A future contributor adding a new gait
 * metric: check Apple's HK unit; percent → ×100 path, m/m·s/kg/etc
 * → identity path.
 */
/**
 * issue #944 — the written reasons a mapping entry may cite for keeping a
 * fixed `hkUnit`. Each one answers the same question: what could Apple
 * possibly write in this record's `unit` attribute that would change the
 * reading? Shared constants rather than free text so the audit reads as
 * one decision per class instead of forty near-duplicates.
 */
const UNIT_FIXED_DIMENSIONLESS_COUNT =
  "Dimensionless tally: Apple emits `count` in every locale and HKUnit has no sibling spelling for it, so no record unit can rescale the reading.";
const UNIT_FIXED_PER_MINUTE =
  "Per-minute rate: Apple emits `count/min` in every locale and the Health app offers no alternative display unit, so there is nothing to convert from.";
const UNIT_FIXED_PERCENT_FRACTION =
  "Apple writes the percent unit but the VALUE rides as a 0..1 fraction; the x100 in `convertToDbUnit` already covers both spellings, so branching on the record unit would double-scale it.";
const UNIT_FIXED_EVENT_PIN =
  "Categorical event: `convertToDbUnit` pins the stored value to 1 fired event regardless of the reading, so no unit attribute can move it.";
const UNIT_FIXED_AUDIO_SPL =
  "Sound-pressure level: Apple emits `dBASPL` only, and a decibel is logarithmic — a sibling unit would need its own formula, never a factor.";
const UNIT_FIXED_COMPOSITE_VO2 =
  "Compound rate Apple emits verbatim as `mL/(kg*min)`; the Health app exposes no other spelling and the compound has no sibling unit to convert from.";
const UNIT_FIXED_SLEEP_CATEGORY =
  "Sleep samples carry a symbolic category value, not a quantity: the importer derives the duration in minutes from the sample's own dates, so the record's unit attribute (empty in Apple's archive) says nothing about the reading.";

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
    unitFixedReason: UNIT_FIXED_PERCENT_FRACTION,
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
  // Waist circumference — HealthKit ships this as a length quantity in the SI
  // base unit (metres), the same wire convention the other length identifiers
  // follow (`DistanceWalkingRunning`, `WalkingStepLength`). It is the first
  // length metric whose canonical DB unit (cm) differs from the metre wire
  // unit, so it scales ×100 server-side — the length sibling of the percent
  // metrics' ×100 path. WHO risk bands are evaluated in cm at display
  // (men > 94 / women > 80; see `norms.ts`).
  HKQuantityTypeIdentifierWaistCircumference: {
    hkIdentifier: "HKQuantityTypeIdentifierWaistCircumference",
    measurementType: "WAIST_CIRCUMFERENCE",
    hkUnit: "m",
    dbUnit: "cm",
    // Apple ships length in metres; HealthLog stores waist in cm.
    convertToDbUnit: (v) => v * 100,
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
    unitFixedReason: UNIT_FIXED_PER_MINUTE,
    dbUnit: "bpm",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  HKQuantityTypeIdentifierRestingHeartRate: {
    hkIdentifier: "HKQuantityTypeIdentifierRestingHeartRate",
    measurementType: "RESTING_HEART_RATE",
    hkUnit: "count/min",
    unitFixedReason: UNIT_FIXED_PER_MINUTE,
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
    unitFixedReason: UNIT_FIXED_DIMENSIONLESS_COUNT,
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
    unitFixedReason: UNIT_FIXED_DIMENSIONLESS_COUNT,
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
    unitFixedReason: UNIT_FIXED_COMPOSITE_VO2,
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
    unitFixedReason: UNIT_FIXED_PERCENT_FRACTION,
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
    unitFixedReason: UNIT_FIXED_SLEEP_CATEGORY,
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
    unitFixedReason: UNIT_FIXED_AUDIO_SPL,
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
    unitFixedReason: UNIT_FIXED_AUDIO_SPL,
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

  // ── v1.4.30 R-F T1.4 + T1.5 Tier-1 additions ────────────────
  // Walking steadiness — iOS 15+ Mobility daily rollup. Apple ships
  // a 0..1 fraction; HealthLog stores 0..100 percent (same convention
  // as oxygen saturation + body fat).
  HKQuantityTypeIdentifierAppleWalkingSteadiness: {
    hkIdentifier: "HKQuantityTypeIdentifierAppleWalkingSteadiness",
    measurementType: "WALKING_STEADINESS",
    hkUnit: "%",
    unitFixedReason: UNIT_FIXED_PERCENT_FRACTION,
    dbUnit: "%",
    // Apple ships 0..1 fraction; HealthLog stores 0..100.
    convertToDbUnit: (v) => v * 100,
    aggregation: "latest",
  },
  // Environmental audio-exposure event — iOS 13+ category-type that
  // fires when the rolling 7-day average crosses the WHO 80-dBA loud-
  // listening threshold. Stored as a 1.0 count per fired event; the
  // `notes` field carries the source token ("env" vs "headphone").
  HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent: {
    hkIdentifier: "HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent",
    measurementType: "AUDIO_EXPOSURE_EVENT",
    hkUnit: "count",
    unitFixedReason: UNIT_FIXED_EVENT_PIN,
    dbUnit: "count",
    convertToDbUnit: () => 1,
    aggregation: "sum",
  },
  // Headphone audio-exposure event — same shape as the environmental
  // sibling; both share the AUDIO_EXPOSURE_EVENT MeasurementType so
  // chart-card consumers can pick them up uniformly.
  HKCategoryTypeIdentifierHeadphoneAudioExposureEvent: {
    hkIdentifier: "HKCategoryTypeIdentifierHeadphoneAudioExposureEvent",
    measurementType: "AUDIO_EXPOSURE_EVENT",
    hkUnit: "count",
    unitFixedReason: UNIT_FIXED_EVENT_PIN,
    dbUnit: "count",
    convertToDbUnit: () => 1,
    aggregation: "sum",
  },

  // ── v1.10.0 — categorical events (WX-B) ──────────────────────
  // Device-flagged EVENT classes. Each is a discrete on-device
  // notification, NOT a continuous reading. HealthLog ingests ONLY the
  // classification RESULT the device's own certified algorithm produced
  // — it never sees a raw ECG waveform, never re-classifies, never emits
  // a diagnosis. The stored `value` is always 1 (one fired event); the
  // device verdict / severity lands in `rhythmClassification`.
  //
  // Irregular-rhythm notification — Apple Watch's FDA-cleared / CE-marked
  // irregular-rhythm-notification feature (and ScanWatch's certified AFib
  // screening, which the iOS bridge maps onto this same identifier). The
  // sample firing IS the device's "possible irregular rhythm" verdict;
  // there is no finer HK gradation, so it resolves to `IRREGULAR`.
  HKCategoryTypeIdentifierIrregularHeartRhythmEvent: {
    hkIdentifier: "HKCategoryTypeIdentifierIrregularHeartRhythmEvent",
    measurementType: "IRREGULAR_RHYTHM_NOTIFICATION",
    hkUnit: "event",
    unitFixedReason: UNIT_FIXED_EVENT_PIN,
    dbUnit: "event",
    convertToDbUnit: () => 1,
    aggregation: "sum",
    isPrivacySensitive: true,
    eventClassificationMap: { 0: "IRREGULAR" },
    fallbackClassification: "IRREGULAR",
  },
  // High-HR event — sustained high heart rate above the user-configured
  // threshold while apparently inactive. Single neutral `FIRED` verdict.
  HKCategoryTypeIdentifierHighHeartRateEvent: {
    hkIdentifier: "HKCategoryTypeIdentifierHighHeartRateEvent",
    measurementType: "HIGH_HEART_RATE_EVENT",
    hkUnit: "event",
    unitFixedReason: UNIT_FIXED_EVENT_PIN,
    dbUnit: "event",
    convertToDbUnit: () => 1,
    aggregation: "sum",
    isPrivacySensitive: true,
    fallbackClassification: "FIRED",
  },
  // Low-HR event — sustained low heart rate below the user-configured
  // threshold. Single neutral `FIRED` verdict.
  HKCategoryTypeIdentifierLowHeartRateEvent: {
    hkIdentifier: "HKCategoryTypeIdentifierLowHeartRateEvent",
    measurementType: "LOW_HEART_RATE_EVENT",
    hkUnit: "event",
    unitFixedReason: UNIT_FIXED_EVENT_PIN,
    dbUnit: "event",
    convertToDbUnit: () => 1,
    aggregation: "sum",
    isPrivacySensitive: true,
    fallbackClassification: "FIRED",
  },
  // Walking-steadiness event — the falls-risk mobility flag. Apple grades
  // it low / very-low (initial + repeat); the severity rides in
  // `rhythmClassification` via `APPLE_HEALTH_WALKING_STEADINESS_EVENT_MAP`.
  HKCategoryTypeIdentifierAppleWalkingSteadinessEvent: {
    hkIdentifier: "HKCategoryTypeIdentifierAppleWalkingSteadinessEvent",
    measurementType: "WALKING_STEADINESS_EVENT",
    hkUnit: "event",
    unitFixedReason: UNIT_FIXED_EVENT_PIN,
    dbUnit: "event",
    convertToDbUnit: () => 1,
    aggregation: "sum",
    isPrivacySensitive: true,
    eventClassificationMap: APPLE_HEALTH_WALKING_STEADINESS_EVENT_MAP,
    fallbackClassification: "LOW",
  },
  // Breathing-disturbance / sleep-apnea event — the device flagged an
  // elevated breathing-disturbance signal during sleep. Screening signal
  // only; single neutral `FIRED` verdict.
  HKCategoryTypeIdentifierSleepApneaEvent: {
    hkIdentifier: "HKCategoryTypeIdentifierSleepApneaEvent",
    measurementType: "BREATHING_DISTURBANCE_EVENT",
    hkUnit: "event",
    unitFixedReason: UNIT_FIXED_EVENT_PIN,
    dbUnit: "event",
    convertToDbUnit: () => 1,
    aggregation: "sum",
    isPrivacySensitive: true,
    fallbackClassification: "FIRED",
  },

  // ── v1.5.5 iOS-coord — six previously-deferred identifiers ───
  // Background: each entry below sat in `HK_QUANTITY_TYPE_DEFERRED`.
  // `mapAppleHealthEntry()` returned null; the batch route emitted
  // 200 with a per-entry `skipped:"unmappable_identifier"`; the iOS
  // app read 200 as success and advanced its sync anchor. Result:
  // every sample carrying one of these identifiers was lost
  // forever, no retry path. Wired through end-to-end now.

  // Respiratory rate — count-per-minute breaths. Watch + iPhone
  // sample this during sleep + workouts. Mean aggregation matches
  // Apple's own Health-app display (resting RR averaged over the
  // sleep window).
  HKQuantityTypeIdentifierRespiratoryRate: {
    hkIdentifier: "HKQuantityTypeIdentifierRespiratoryRate",
    measurementType: "RESPIRATORY_RATE",
    hkUnit: "count/min",
    unitFixedReason: UNIT_FIXED_PER_MINUTE,
    dbUnit: "breaths/min",
    convertToDbUnit: (v) => v,
    aggregation: "mean",
  },
  // BMI — iOS computes it from weight + height before upload. We
  // still want a first-class metric for trend display so the iOS
  // chart can read a single series instead of recomputing per
  // datapoint. Unit-less ratio on the wire; canonical label is
  // `kg/m²` to match clinical convention.
  HKQuantityTypeIdentifierBodyMassIndex: {
    hkIdentifier: "HKQuantityTypeIdentifierBodyMassIndex",
    measurementType: "BODY_MASS_INDEX",
    hkUnit: "count",
    unitFixedReason: UNIT_FIXED_DIMENSIONLESS_COUNT,
    dbUnit: "kg/m²",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  // Lean body mass — body-composition counterpart to FAT_MASS.
  // Apple ships this in kg; canonical DB unit is kg too.
  HKQuantityTypeIdentifierLeanBodyMass: {
    hkIdentifier: "HKQuantityTypeIdentifierLeanBodyMass",
    measurementType: "LEAN_BODY_MASS",
    hkUnit: "kg",
    dbUnit: "kg",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  // Walking heart-rate average — distinct from RESTING_HEART_RATE
  // (sleep-window minimum) and spot PULSE. Daily rollup.
  HKQuantityTypeIdentifierWalkingHeartRateAverage: {
    hkIdentifier: "HKQuantityTypeIdentifierWalkingHeartRateAverage",
    measurementType: "WALKING_HEART_RATE_AVERAGE",
    hkUnit: "count/min",
    unitFixedReason: UNIT_FIXED_PER_MINUTE,
    dbUnit: "bpm",
    convertToDbUnit: (v) => v,
    aggregation: "mean",
  },
  // Walking asymmetry — Apple ships as a 0..1 fraction; HealthLog
  // stores 0..100 (same convention as walking steadiness, body fat,
  // oxygen saturation). See the "server-side scaling is canonical"
  // block above for the rationale. The iOS client's previous
  // pre-upload ×100 multiplication is the documented migration item.
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage: {
    hkIdentifier: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
    measurementType: "WALKING_ASYMMETRY",
    hkUnit: "%",
    unitFixedReason: UNIT_FIXED_PERCENT_FRACTION,
    dbUnit: "%",
    convertToDbUnit: (v) => v * 100,
    aggregation: "latest",
  },
  // Walking double-support percentage — gait companion metric.
  // Same ×100 server-side scaling convention.
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: {
    hkIdentifier: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
    measurementType: "WALKING_DOUBLE_SUPPORT",
    hkUnit: "%",
    unitFixedReason: UNIT_FIXED_PERCENT_FRACTION,
    dbUnit: "%",
    convertToDbUnit: (v) => v * 100,
    aggregation: "latest",
  },

  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ───────────
  // Walking step length — Apple ships raw metres; canonical DB
  // unit is metres too. NO scaling — the ×100 convention applies
  // ONLY to the percent gait metrics above. See the convention
  // block at the top of this file for the split.
  HKQuantityTypeIdentifierWalkingStepLength: {
    hkIdentifier: "HKQuantityTypeIdentifierWalkingStepLength",
    measurementType: "WALKING_STEP_LENGTH",
    hkUnit: "m",
    dbUnit: "m",
    convertToDbUnit: (v) => v,
    aggregation: "mean",
  },
  // Walking speed — Apple ships raw metres-per-second; canonical
  // DB unit is m/s too. NO scaling — see the convention block.
  HKQuantityTypeIdentifierWalkingSpeed: {
    hkIdentifier: "HKQuantityTypeIdentifierWalkingSpeed",
    measurementType: "WALKING_SPEED",
    hkUnit: "m/s",
    dbUnit: "m/s",
    convertToDbUnit: (v) => v,
    aggregation: "mean",
  },

  // ── v1.10.0 — additive HealthKit signals (WX-A) ─────────────
  // Seven previously-deferred quantity identifiers wired end-to-end.
  // Each one ships raw on the wire (no 0..1 fraction), so every entry
  // takes the identity `convertToDbUnit` path — the ×100 percent
  // scaling the gait-percent metrics use does not apply here.

  // Cardio recovery — the heart-rate drop one minute after peak
  // exercise. iOS 16+. A larger drop is the fitter signal; we store
  // the raw bpm delta. One sample per qualifying workout.
  HKQuantityTypeIdentifierHeartRateRecoveryOneMinute: {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
    measurementType: "CARDIO_RECOVERY",
    hkUnit: "count/min",
    unitFixedReason: UNIT_FIXED_PER_MINUTE,
    dbUnit: "bpm",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  // Sleeping wrist temperature — iOS 16+ overnight reading. Apple's
  // Health app frames it as a deviation from a personal baseline; we
  // store the absolute °C reading and let the user's own series carry
  // the baseline. One sample per night.
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: {
    hkIdentifier: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
    measurementType: "WRIST_TEMPERATURE",
    hkUnit: "degC",
    dbUnit: "celsius",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
    isPrivacySensitive: true,
  },
  // Fall count — hard-fall detections. Cumulative daily tally; the
  // drain treats it like the other cumulative HK counts.
  HKQuantityTypeIdentifierNumberOfTimesFallen: {
    hkIdentifier: "HKQuantityTypeIdentifierNumberOfTimesFallen",
    measurementType: "FALL_COUNT",
    hkUnit: "count",
    unitFixedReason: UNIT_FIXED_DIMENSIONLESS_COUNT,
    dbUnit: "count",
    convertToDbUnit: (v) => v,
    aggregation: "sum",
  },
  // Six-minute-walk-test distance — Apple's estimated 6MWT distance in
  // metres. Mobility + cardiopulmonary endurance signal. Near-daily
  // rollup; latest reading leads.
  HKQuantityTypeIdentifierSixMinuteWalkTestDistance: {
    hkIdentifier: "HKQuantityTypeIdentifierSixMinuteWalkTestDistance",
    measurementType: "SIX_MINUTE_WALK_DISTANCE",
    hkUnit: "m",
    dbUnit: "m",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
  },
  // Stair ascent speed — raw metres-per-second measured while climbing.
  HKQuantityTypeIdentifierStairAscentSpeed: {
    hkIdentifier: "HKQuantityTypeIdentifierStairAscentSpeed",
    measurementType: "STAIR_ASCENT_SPEED",
    hkUnit: "m/s",
    dbUnit: "m/s",
    convertToDbUnit: (v) => v,
    aggregation: "mean",
  },
  // Stair descent speed — gait companion to ascent speed.
  HKQuantityTypeIdentifierStairDescentSpeed: {
    hkIdentifier: "HKQuantityTypeIdentifierStairDescentSpeed",
    measurementType: "STAIR_DESCENT_SPEED",
    hkUnit: "m/s",
    dbUnit: "m/s",
    convertToDbUnit: (v) => v,
    aggregation: "mean",
  },
  // Breathing disturbances — iOS 18+ per-night sleep-breathing index
  // Apple classifies as NotElevated / Elevated. Stored as the raw
  // unitless count; one sample per night.
  HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances: {
    hkIdentifier: "HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances",
    measurementType: "BREATHING_DISTURBANCES",
    hkUnit: "count",
    unitFixedReason: UNIT_FIXED_DIMENSIONLESS_COUNT,
    dbUnit: "count",
    convertToDbUnit: (v) => v,
    aggregation: "latest",
    isPrivacySensitive: true,
  },
};

/**
 * v1.4.29 — MeasurementTypes whose `aggregate=daily|weekly|monthly`
 * grain on `GET /api/measurements` must reduce with `SUM`, not `AVG`.
 *
 * These are the cumulative-quantity HealthKit types where every row
 * is a partial-day increment (steps for one minute, kilocalories for
 * one workout, metres for one walk). Averaging across the day
 * silently understates the daily total by the per-bucket sample
 * count. Spot metrics (BP, weight, pulse, mood, BG, body fat, sleep)
 * stay on `AVG`.
 *
 * Used by `src/app/api/measurements/route.ts` when picking the SQL
 * aggregator. Mirrors the canonical list documented in
 * `.planning/research/v15-r-a-step-aggregation.md` §6.
 */
export const CUMULATIVE_HK_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>([
    "ACTIVITY_STEPS",
    "ACTIVE_ENERGY_BURNED",
    "FLIGHTS_CLIMBED",
    "WALKING_RUNNING_DISTANCE",
    "TIME_IN_DAYLIGHT",
    // v1.10.0 — hard-fall detections accumulate across the day; the
    // daily total is the meaningful reduction (SUM), matching the other
    // cumulative HK counts.
    "FALL_COUNT",
  ]);

/**
 * v1.7.0 — high-frequency *spot* HealthKit metrics that arrive at
 * sampling granularity (tens-to-hundreds of rows per day) but whose
 * correct daily reduction is the MEAN, not the SUM. Summing a day's
 * walking-speed or respiratory-rate samples is meaningless; the
 * per-day mean is the right consolidation.
 *
 * The nightly daily-mean drain (`drainDailyMean`) walks this set per
 * user × type × completed day, UPSERTs one `stats:<HK>:<day>` row at
 * local-noon carrying the day's mean, and SOFT-deletes the per-sample
 * rows (tombstone, audit-trail preserving — the legacy-step choice).
 *
 * Disjoint from `CUMULATIVE_HK_TYPES` by construction — a type in both
 * would be reduced by SUM and MEAN at once and corrupt the value. The
 * disjointness is asserted in `apple-health-mapping.test.ts`.
 *
 * PULSE is deliberately EXCLUDED even though it is high-frequency:
 * correlation + scatter analytics read raw PULSE rows, so draining it
 * to a daily grain would change those inputs. PULSE keeps raw storage;
 * its DISPLAY stays daily-aggregated via the read-path AVG (PULSE is
 * not in `CUMULATIVE_HK_TYPES`, so the daily read averages it).
 *
 * Like the cumulative drain, the daily-mean drain scopes to
 * `source = 'APPLE_HEALTH'` only — manual + Withings spot rows for the
 * same type stay untouched.
 */
export const HIGH_FREQUENCY_MEAN_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>([
    "RESPIRATORY_RATE",
    "AUDIO_EXPOSURE_ENV",
    "AUDIO_EXPOSURE_HEADPHONE",
    "WALKING_SPEED",
    "WALKING_STEP_LENGTH",
    // v1.8.5 — the gait/mobility metrics Apple Health emits at sampling
    // granularity (asymmetry/double-support per walk, walking heart-rate
    // average per walk, steadiness as a near-daily rollup). They previously
    // mapped to `latest` and belonged to no consolidation set, so every
    // sample piled up raw. MEAN is the correct daily reduction and matches
    // the Health-app display; all four stay disjoint from
    // `CUMULATIVE_HK_TYPES`.
    "WALKING_ASYMMETRY",
    "WALKING_DOUBLE_SUPPORT",
    "WALKING_STEADINESS",
    "WALKING_HEART_RATE_AVERAGE",
    // v1.10.0 — stair gait speeds arrive per-climb at sampling
    // granularity; the per-day MEAN is the right consolidation (same
    // posture as WALKING_SPEED / WALKING_STEP_LENGTH). Disjoint from
    // CUMULATIVE_HK_TYPES by construction.
    "STAIR_ASCENT_SPEED",
    "STAIR_DESCENT_SPEED",
  ]);

/**
 * v1.4.30 — externalId shape for daily-aggregated cumulative
 * HealthKit rows. iOS emits one row per day per cumulative type via
 * `HKStatisticsCollectionQuery` per R-A Option A; the externalId
 * UPSERTs the matching server row idempotently across re-syncs.
 *
 * Format: `stats:<HKQuantityTypeIdentifier>:<YYYY-MM-DD>`.
 *
 * Cumulative HK types only — the spot-sample path keeps using
 * `HKSample.uuid` as `externalId`. The shape is intentionally
 * stable across the cutover: iOS clients still posting per-sample
 * rows round-trip through the existing `(userId, type, source,
 * externalId)` unique index; iOS clients on the daily-stats path
 * collide on the deterministic `"stats:..."` key for idempotent
 * UPSERTs.
 *
 * Locked contract — see
 * `.planning/v15-ios-handoff/08-locked-contracts.md` §13 and
 * `.planning/v15-ios-handoff/06-ios-responsibilities.md` Domain 1
 * "Cumulative metrics: daily aggregation on iOS".
 *
 * The helper accepts the date string as-is: iOS generates it from
 * the user's IANA timezone via `DateFormatter` with the
 * `yyyy-MM-dd` pattern; the server trusts that format rather than
 * re-validating per ingest because the iOS handoff doc locks the
 * shape and the receiving Zod schema already caps `externalId` at
 * 120 characters.
 */
export function dailyStatsExternalId(
  hkIdentifier: string,
  dateYYYYMMDD: string,
): string {
  return `stats:${hkIdentifier}:${dateYYYYMMDD}`;
}

/**
 * v1.30.7 (iOS #34) — go-forward aggregated heart-rate wire contract.
 * Supersedes the v1.19.0 HOURLY shape (which no client ever adopted) —
 * see `.planning/research/2026-07-18-hr-aggregation-contract.md`.
 *
 * iOS uploads ONE PULSE row per 10-MINUTE heart-rate bucket instead of
 * one row per raw HealthKit sample (~500–16k rows/user/day → ~144). The
 * bucket's `value` is the 10-min AVERAGE bpm (`discreteAverage`), with
 * `valueMin`/`valueMax` the bucket spread (`discreteMin`/`discreteMax`);
 * the row reuses the existing `stats:` overwrite path so a re-post while
 * the bucket fills (the running mean/min/max shift) OVERWRITES rather than
 * duplicating — identical mechanics to the per-day `stats:<HK>:<day>`
 * cumulative rows, but at 10-min granularity for the spot HR metric.
 *
 * 10 minutes is chosen because it maps 1:1 onto the intraday-pulse tier
 * (`BUCKET_MINUTES = 10`): one uploaded bucket = one plotted point + its
 * min/max envelope, and `discreteAverage` over the bucket's samples is
 * exactly the 10-min mean the raw path would compute — so tension
 * detection and the curve are preserved, while the hourly shape would
 * have collapsed the curve to ~24 points/day.
 *
 * Format: `stats:HKQuantityTypeIdentifierHeartRate:<bucket-start>` where
 * `<bucket-start>` is the ISO-8601 instant of the 10-min boundary in UTC
 * with a literal `Z`, minutes ∈ {00,10,20,30,40,50}, seconds/millis zero
 * — e.g. `stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14:30:00.000Z`.
 *
 * The boundary is in UTC (not the user's local slot) so the externalId is
 * timezone-stable: a user travelling across zones never re-keys the same
 * wall-clock window to a new bucket. The `measuredAt` the client sends
 * (`endDate`) still carries the offset for display.
 *
 * The guard is written identifier-GENERIC over `AGGREGATED_BUCKET_HK_IDENTIFIERS`
 * (HR-only today). respiratoryRate / SpO2 stay per-sample for now but can
 * join the same 10-min family later by widening the allowlist — same
 * grammar, same overwrite semantics, no renegotiation.
 */
const AGGREGATED_BUCKET_HK_IDENTIFIERS = new Set<string>([
  "HKQuantityTypeIdentifierHeartRate",
]);

/** Floor a Date down to its 10-minute UTC bucket start. */
function floorToTenMinuteUtc(at: Date): Date {
  const floored = new Date(at);
  floored.setUTCMinutes(Math.floor(floored.getUTCMinutes() / 10) * 10, 0, 0);
  return floored;
}

export function heartRateBucketExternalId(bucketStart: Date): string {
  const floor = floorToTenMinuteUtc(bucketStart);
  return `stats:HKQuantityTypeIdentifierHeartRate:${floor.toISOString()}`;
}

/**
 * The exact ISO 10-minute suffix shape an aggregated bucket externalId must
 * carry: full ISO-8601 UTC instant, minutes ∈ {00,10,20,30,40,50},
 * seconds/millis zero, trailing `Z`. Anchored so a partial / malformed
 * suffix is rejected. Distinct from the retention fold's OWN hourly shape
 * (`stats:<HK>:<YYYY-MM-DD>T<HH>`, local hour, no `Z`) — the two suffix
 * grammars are disjoint, which lets the intraday reader tell an uploaded
 * 10-min bucket from a server-folded hourly mean by shape alone.
 */
const AGGREGATED_BUCKET_SUFFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:[0-5]0:00\.000Z$/;

/** The `stats:<HK>:` prefix for each allowlisted aggregated-bucket identifier. */
function aggregatedBucketPrefix(hkIdentifier: string): string {
  return `stats:${hkIdentifier}:`;
}

/**
 * v1.30.7 (iOS #34) — well-formedness guard for an aggregated 10-min bucket
 * externalId. Returns `true` ONLY for a `stats:` externalId that targets an
 * allowlisted identifier AND carries a 10-min ISO-Z suffix that parses to a
 * real instant. Used by the batch route to reject a malformed bucket
 * (`skipped:"malformed_hr_bucket_id"`) rather than persisting an
 * un-overwriteable, un-foldable garbage row.
 *
 * Non-allowlisted `stats:` externalIds (the per-day cumulative rows) are NOT
 * this function's concern — it returns `false` so the caller leaves them on
 * the untouched path.
 */
export function isAggregatedBucketExternalId(
  externalId: string | null | undefined,
): boolean {
  if (typeof externalId !== "string") return false;
  for (const hkIdentifier of AGGREGATED_BUCKET_HK_IDENTIFIERS) {
    const prefix = aggregatedBucketPrefix(hkIdentifier);
    if (!externalId.startsWith(prefix)) continue;
    const suffix = externalId.slice(prefix.length);
    if (!AGGREGATED_BUCKET_SUFFIX_RE.test(suffix)) return false;
    const parsed = new Date(suffix);
    if (Number.isNaN(parsed.getTime())) return false;
    // Reject a non-canonical instant that PARSES via V8's silent rollover
    // (`T24:00`, `2026-04-31`, a non-leap `02-29`) — it would key a row under
    // a literal string the canonical client (`heartRateBucketExternalId`, which
    // mints via `toISOString()`) never emits, so the two would never collapse
    // on the overwrite key. Round-trip equality pins the suffix to the one
    // canonical form.
    return parsed.toISOString() === suffix;
  }
  return false;
}

/**
 * v1.30.7 (iOS #34) — does this externalId CLAIM to be an aggregated bucket
 * (right `stats:<allowlisted-HK>:` prefix) regardless of suffix validity?
 * The route uses this for a malformed-vs-valid split: a row that targets a
 * bucket prefix but fails `isAggregatedBucketExternalId` is a malformed
 * bucket (reject), not an unrelated `stats:` row (pass through untouched).
 */
export function targetsAggregatedBucket(
  externalId: string | null | undefined,
): boolean {
  if (typeof externalId !== "string") return false;
  for (const hkIdentifier of AGGREGATED_BUCKET_HK_IDENTIFIERS) {
    if (externalId.startsWith(aggregatedBucketPrefix(hkIdentifier)))
      return true;
  }
  return false;
}

/**
 * v1.30.7 (iOS #34) — the canonical UTC bucket-start instant of a well-formed
 * aggregated 10-min bucket externalId, or `null` when the id is not one. The
 * intraday reader uses this to place an uploaded bucket into its local 10-min
 * slot from the id's authoritative UTC start (the row's `measuredAt` carries
 * the display offset, not the canonical bucket boundary).
 */
export function parseAggregatedBucketStart(
  externalId: string | null | undefined,
): Date | null {
  if (typeof externalId !== "string") return null;
  for (const hkIdentifier of AGGREGATED_BUCKET_HK_IDENTIFIERS) {
    const prefix = aggregatedBucketPrefix(hkIdentifier);
    if (!externalId.startsWith(prefix)) continue;
    const suffix = externalId.slice(prefix.length);
    if (!AGGREGATED_BUCKET_SUFFIX_RE.test(suffix)) return null;
    const parsed = new Date(suffix);
    if (Number.isNaN(parsed.getTime())) return null;
    // Canonical-form gate (mirrors `isAggregatedBucketExternalId`): a rolled-over
    // instant would place the bucket on the wrong local day.
    return parsed.toISOString() === suffix ? parsed : null;
  }
  return null;
}

/**
 * v1.4.30 — reverse lookup from a HealthLog `MeasurementType` to the
 * canonical HealthKit identifier for that type. Used by the drain
 * script when minting a `dailyStatsExternalId` from a row whose
 * `hkIdentifier` is not carried on the table (the per-sample ingest
 * stores only the resolved `MeasurementType`).
 *
 * Returns `null` when the type has no HealthKit counterpart (Withings-
 * only metrics). Callers in the cumulative-drain path can assume the
 * lookup succeeds because `CUMULATIVE_HK_TYPES` is a subset of the
 * HK-mapped types.
 */
export function hkIdentifierForType(type: MeasurementType): string | null {
  for (const mapping of Object.values(APPLE_HEALTH_TYPE_MAP)) {
    if (mapping.measurementType === type) return mapping.hkIdentifier;
  }
  return null;
}

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
  // Body composition / vitals
  // v1.5.5 — `BodyMassIndex`, `LeanBodyMass`, `RespiratoryRate`,
  // `WalkingHeartRateAverage`, `WalkingAsymmetryPercentage`,
  // `WalkingDoubleSupportPercentage` moved into the mapping table.
  // The remaining identifiers below stay deferred until a sibling
  // MeasurementType lands.
  "HKQuantityTypeIdentifierHeight", // already on User.heightCm
  // v1.10.0 — `HeartRateRecoveryOneMinute` + `AppleSleepingWristTemperature`
  // moved into the mapping table (CARDIO_RECOVERY + WRIST_TEMPERATURE).
  "HKQuantityTypeIdentifierBasalEnergyBurned",
  "HKQuantityTypeIdentifierAppleExerciseTime", // implied by Workout rows
  "HKQuantityTypeIdentifierAppleStandTime", // implied by Workout rows
  "HKCategoryTypeIdentifierAppleStandHour", // implied by Workout rows
  // Running / walking form — v1.5+
  // v1.5.5 — `WalkingStepLength` + `WalkingSpeed` moved into the
  // mapping table (raw SI on the wire — metres and m/s respectively).
  // v1.10.0 — `StairAscentSpeed`, `StairDescentSpeed`, and
  // `SixMinuteWalkTestDistance` moved into the mapping table
  // (STAIR_ASCENT_SPEED / STAIR_DESCENT_SPEED / SIX_MINUTE_WALK_DISTANCE).
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
  // v1.10.0 — both signals now mapped, so neither stays deferred:
  // `AppleSleepingBreathingDisturbances` (the per-night quantity) →
  // BREATHING_DISTURBANCES, and `HKCategoryTypeIdentifierSleepApneaEvent`
  // (the fired screening event) → BREATHING_DISTURBANCE_EVENT.
  // Nutrition — the Measurement path stays PERMANENTLY closed to
  // Dietary types. Energy / macros (and sodium): indefinite hold, the
  // anti-goal against diet-app territory stands. Water + caffeine (and
  // the 24 micro Dietary vitamin/mineral identifiers, which were never
  // listed here because no sample ever mapped) ride the dedicated
  // day-total endpoint `POST /api/nutrients/batch` (closed catalog in
  // `src/lib/nutrients/catalog.ts`) — never Measurements, so the two
  // entries below stay deferred and a stray sample-grain post keeps
  // skipping as unmappable.
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
  // Pregnancy bleeding — stays deferred (pregnancy-mode is a later
  // release). v1.15.0 promoted the cycle-tracking reproductive types
  // (MenstrualFlow / IntermenstrualBleeding / CervicalMucusQuality /
  // OvulationTestResult and the symptom + test-result + contraceptive
  // identifiers) OUT of this deferred list — they route into CYCLE
  // day-logs via the importer's cycle accumulator (see
  // `src/lib/cycle/healthkit-mapping.ts`), NOT into Measurement, so they
  // must NOT appear here or the importer would skip them before the cycle
  // branch runs.
  "HKCategoryTypeIdentifierBleedingAfterPregnancy",
  "HKCategoryTypeIdentifierBleedingDuringPregnancy",
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
  // Mobility (iOS 15+) — `AppleWalkingSteadiness` moved into the
  // mapping table in v1.4.30 (R-F T1.5). In v1.10.0 both remaining
  // signals moved in too, so neither stays deferred: `NumberOfTimesFallen`
  // → FALL_COUNT (the continuous count), and
  // `AppleWalkingSteadinessEvent` → WALKING_STEADINESS_EVENT (the fired
  // severity event).
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
  // refreshed surfaces). v1.10.0 — `LowHeartRateEvent`,
  // `HighHeartRateEvent` + `IrregularHeartRhythmEvent` moved into the
  // mapping table as the LOW/HIGH_HEART_RATE_EVENT +
  // IRREGULAR_RHYTHM_NOTIFICATION categorical events.
  // `LowCardioFitnessEvent` stays deferred (no awareness surface yet).
  "HKCategoryTypeIdentifierLowCardioFitnessEvent",
  // Audio-exposure events (iOS 13+) — Environmental + Headphone
  // moved into the mapping table in v1.4.30 (R-F T1.4) as
  // AUDIO_EXPOSURE_EVENT. The general "sound reduction" flag stays
  // deferred until we surface event chips in the Insights audio
  // sub-page.
  "HKCategoryTypeIdentifierEnvironmentalSoundReduction",
  // Behavioural / habit category-types — not in HealthLog scope yet.
  "HKCategoryTypeIdentifierHandwashingEvent",
  "HKCategoryTypeIdentifierToothbrushingEvent",
  // Reproductive / fertility — v1.15.0 promoted Contraceptive,
  // PregnancyTestResult, ProgesteroneTestResult and SexualActivity OUT of
  // this list (they route into CYCLE day-logs via the cycle accumulator).
  // Pregnancy + Lactation STATUS stay deferred: the v1.15.0 CycleProfile
  // has no pregnant/lactating column (pregnancy-mode is a later release),
  // so there is no destination yet — promoting them would only grow the
  // importer's skip tally. The four awareness types are server-DERIVED
  // from the cycle engine, never ingested.
  "HKCategoryTypeIdentifierLactation",
  "HKCategoryTypeIdentifierPregnancy",
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
  /**
   * Apple's unit string for this reading. issue #944 — the mapper converts
   * the value from this unit into the table's `hkUnit` when the two differ
   * and a factor is known (`km` -> `m`, `lb` -> `kg`, `degF` -> `degC`, …);
   * an unknown or unplaceable unit leaves the reading untouched.
   */
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
  /**
   * v1.10.0 — categorical events (WX-B). The integer `HKCategoryValue`
   * codepoint for an EVENT-class category sample (irregular-rhythm,
   * high/low-HR, walking-steadiness, breathing-disturbance). The device
   * already classified the signal; this is the codepoint of that
   * verdict, looked up via the mapping's `eventClassificationMap`.
   * Ignored for every non-event identifier. Falls back to the wire
   * `sleepStage` field when omitted so an iOS build that reuses the
   * existing category-value slot still round-trips.
   */
  categoryValue?: number;
  /**
   * v1.19.2 (iOS #34 extension) — per-bucket spread for an aggregated
   * heart-rate row. The hour's MIN / MAX bpm in Apple's native unit
   * (pre-conversion), companions to `value` (the hour's AVERAGE). The
   * mapper applies the SAME `convertToDbUnit` it applies to `value`.
   * Ignored for every non-quantity / non-HR-bucket entry; the caller
   * persists them only on the hourly HR bucket row.
   */
  valueMin?: number;
  valueMax?: number;
}

/** Output of `mapAppleHealthEntry()`. */
export interface AppleHealthEntryOutput {
  type: MeasurementType;
  value: number;
  unit: string;
  takenAt: Date;
  /**
   * v1.19.2 (iOS #34 extension) — converted per-bucket MIN / MAX, set
   * only when the input carried them (the hourly HR bucket). NULL/absent
   * for every other row.
   */
  valueMin?: number;
  valueMax?: number;
  /** Set only for sleep entries. */
  sleepStage?: SleepStage;
  /**
   * v1.10.0 — set only for the categorical EVENT classes. The device's
   * own verdict / severity for the fired event. NULL/undefined for every
   * continuous measurement.
   */
  rhythmClassification?: RhythmClassification;
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

  // issue #944 — `convertToDbUnit` is written against the table's fixed
  // `hkUnit`, but Apple's `export.xml` stamps each `<Record>` with the
  // ACCOUNT's own display unit: a metric archive reports walking distance
  // in `km`, an imperial one in `mi`, body mass in `lb`, energy in `kJ`.
  // Normalise the reading into `hkUnit` first; a unit we cannot place
  // leaves the value untouched (see `convertHkValue`).
  const toHkUnit = (raw: number): number =>
    convertHkValue(raw, input.unit, mapping.hkUnit) ?? raw;

  const value = mapping.convertToDbUnit(toHkUnit(input.value));

  const out: AppleHealthEntryOutput = {
    type: mapping.measurementType,
    value,
    unit: mapping.dbUnit,
    takenAt,
  };

  // v1.19.2 (iOS #34 extension) — carry the per-bucket MIN / MAX through
  // the SAME unit conversion as `value` when the caller supplied them (the
  // hourly HR bucket). A finite check guards a malformed payload; the
  // caller only persists these on the HR-bucket row.
  if (typeof input.valueMin === "number" && Number.isFinite(input.valueMin)) {
    out.valueMin = mapping.convertToDbUnit(toHkUnit(input.valueMin));
  }
  if (typeof input.valueMax === "number" && Number.isFinite(input.valueMax)) {
    out.valueMax = mapping.convertToDbUnit(toHkUnit(input.valueMax));
  }

  if (mapping.sleepStageMap) {
    if (input.sleepStage === undefined) return null;
    const stage = mapping.sleepStageMap[input.sleepStage];
    if (!stage) return null;
    out.sleepStage = stage;
  }

  // v1.10.0 — categorical events (WX-B). Resolve the device's verdict
  // from the inbound codepoint. The `value` is already pinned to 1 by the
  // mapping's `convertToDbUnit: () => 1`. We accept the codepoint from
  // `categoryValue`, falling back to the legacy `sleepStage` category slot
  // so an iOS build reusing that wire field still resolves. An unknown
  // codepoint degrades to the mapping's `fallbackClassification` rather
  // than dropping the event — the device fired it, so it happened.
  if (mapping.fallbackClassification) {
    const codepoint = input.categoryValue ?? input.sleepStage;
    const fromMap =
      codepoint !== undefined && mapping.eventClassificationMap
        ? mapping.eventClassificationMap[codepoint]
        : undefined;
    out.rhythmClassification = fromMap ?? mapping.fallbackClassification;
  }

  return out;
}
