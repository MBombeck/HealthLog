/**
 * v1.25 — the SIGNAL REGISTRY backbone.
 *
 * One declarative table that describes a health signal ACROSS every surface
 * it touches (DB measurement type, detail page, correlation engine, Coach
 * snapshot, MCP read tool, FHIR coding). Today a single signal is described
 * 8–16 times in independent tables keyed by slightly different vocabularies,
 * and nothing fails the build when they disagree. This registry promotes the
 * proto-registry in `metric-status-registry.ts` to the canonical definition
 * and lets the per-surface tables DERIVE from it (see `./adapters/*`) instead
 * of being hand-maintained beside it.
 *
 * Coexistence, not replacement: the DB enum stays the source of truth for
 * persistence. The registry sits ABOVE it. Surfaces are flipped one at a time
 * to read from the registry; the registry-invariant test pins every derived
 * table byte-for-byte to the values the hand-written tables carry today, so a
 * flip is a no-op diff and future drift fails CI.
 *
 * Adding a NEW signal (the clinical-signals wave): append ONE
 * `SignalDefinition` object below, add its i18n keys, and — for a
 * `measurement`/`score` — one Prisma enum member + migration. The derived
 * tables (FHIR, correlation, …) light up with no further per-surface edits.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type {
  MetricArchetype,
  MetricDirection,
  MetricNormalRange,
} from "@/lib/insights/metric-status-registry";
import type { FhirObservationCategory } from "@/lib/fhir/loinc-map";
import { FEVER_BAND_C } from "@/lib/clinical-floors";

/**
 * Discriminator: a device/manual reading, a lab biomarker, a computed score, or
 * an environmental exposure. `environment` (v1.25 W-ENV) is NOT backed by a
 * `MeasurementType` — its daily value lives in `EnvironmentContext` and feeds
 * the correlation engine through the env channel series builder, not the
 * measurement-keyed `BUCKETED_TYPES`. It registers here so the env signals get
 * a stable key + display metadata in the one cross-surface table.
 */
/** Reuse the assessment registry's direction vocabulary verbatim. */
export type SignalDirection = MetricDirection;

/** Coarse population placement band; the user's own baseline still leads. */
export type SignalBand = MetricNormalRange;

/**
 * FHIR R4 coding facet. Field names align with `loinc-map.ts`'s `LoincMapping`
 * (`unit` is the UCUM string, also used as the `code`) so the FHIR adapter is a
 * straight projection with no renaming.
 */
export interface SignalFhirCoding {
  /** LOINC code, or null when no stable LOINC applies (local text fallback). */
  loinc: string | null;
  display: string;
  /** UCUM unit string (also used as the FHIR `code`). */
  unit: string;
  category: FhirObservationCategory;
}

/** Chart-overlay facet. Typed loosely (string overlayKey) to keep the backbone free of the dashboard-layout runtime dep. */
export interface SignalChart {
  overlayKey: string;
  color?: string;
  yAxisUnit?: string;
  /** Display rescale (e.g. m/s → km/h); applied at the chart edge only. */
  valueScale?: number;
}

/**
 * Per-surface eligibility — declarative flags, not branches scattered across
 * files. `coachSnapshot.scope` is the Coach scope-source token (typed as a
 * string here so the backbone does not depend on the coach module; the coach
 * flip will tighten it to `CoachScopeSource`).
 */
export interface SignalSurfaces {
  /** Mount the generic HealthKit/biomarker detail template. */
  detailPage: boolean;
  /** Feed the FDR correlation channels (⇒ `BUCKETED_TYPES`). */
  correlationEligible: boolean;
  /** Coach snapshot inclusion + its scope token, or `false` to opt out. */
  coachSnapshot: false | { scope: string };
  /** Exposed to the MCP `get_metric_series` / search inventory. */
  mcp: boolean;
}

interface SignalCommon {
  /** Stable signal key — the ONE vocabulary every surface speaks. */
  key: string;
  /** i18n key prefix resolving `.title`/`.description`/`.chartTitle`/`.emptyState.*`. Optional until the clinical-signals wave fills it per signal. */
  i18nPrefix?: string;
  /** Stable English display name (the model localises its own prose). */
  displayName: string;
  /** Canonical storage unit (matches the DB column semantics). */
  unit: string;
  direction: SignalDirection;
  archetype: MetricArchetype;
  normalRange?: SignalBand;
  /** Single-reading fever band line (°C) for temperature signals. */
  feverBandC?: number;
  /** Richer clinical bands defer to a `reference-ranges.ts` entry by key. */
  referenceMetric?: string;
  /** Cross-source dedup ladder key; omit ⇒ not cross-source-deduped. */
  sourcePriorityKey?: string;
  chart?: SignalChart;
  surfaces: SignalSurfaces;
  fhir?: SignalFhirCoding;
}

/** How a `measurement`/`score` signal is sourced from the DB enum. */
export interface MeasurementSignalSource {
  measurementType: MeasurementType;
  /** Fallback measurement type (e.g. an SDNN→RMSSD HRV proxy). */
  fallbackMeasurementType?: MeasurementType;
}

/** How a `biomarker` signal is sourced from the labs catalog. */
export interface BiomarkerSignalSource {
  biomarkerKey: string;
}

/**
 * How an `environment` signal is sourced (v1.25 W-ENV). The value is a daily
 * `EnvironmentContext` column, surfaced to the correlation engine under
 * `environmentChannelKey` (the `ENV_*` channel key from
 * `@/lib/environment/fields`). No `MeasurementType` — env data is never a
 * Measurement row.
 */
export interface EnvironmentSignalSource {
  environmentChannelKey: string;
}

/**
 * The canonical cross-surface signal definition, discriminated on `kind`.
 * `measurement` and `score` both resolve to a `MeasurementType`; `biomarker`
 * resolves to a labs-catalog key.
 */
export type SignalDefinition =
  | (SignalCommon & { kind: "measurement"; source: MeasurementSignalSource })
  | (SignalCommon & { kind: "score"; source: MeasurementSignalSource })
  | (SignalCommon & { kind: "biomarker"; source: BiomarkerSignalSource })
  | (SignalCommon & { kind: "environment"; source: EnvironmentSignalSource });

/** Convenience: build a Coach-snapshot facet from a scope token. */
function coachScope(scope: string): { scope: string } {
  return { scope };
}

/**
 * The registry. Keyed by stable signal key. Generic HealthKit signals key by
 * their `metric-status-registry` id (STEPS, RESTING_HEART_RATE, …); the six
 * specialised signals (WEIGHT/BMI/PULSE/BODY_FAT/BP_SYS/BP_DIA) key by their
 * `MeasurementType` and carry `detailPage:false` so the generic template never
 * double-renders them — they still appear in the cross-surface indices (FHIR,
 * correlation, Coach, MCP).
 *
 * Every value here is the value the hand-written per-surface table carries
 * today; the registry-invariant test pins them byte-for-byte.
 */
export const SIGNALS: Record<string, SignalDefinition> = {
  // ── physiological-vital ──────────────────────────────────────────────
  RESTING_HEART_RATE: {
    key: "RESTING_HEART_RATE",
    kind: "measurement",
    source: { measurementType: "RESTING_HEART_RATE" },
    sourcePriorityKey: "restingHeartRate",
    i18nPrefix: "insights.restingHr",
    displayName: "Resting heart rate",
    unit: "bpm",
    direction: "lower-better",
    archetype: "physiological-vital",
    normalRange: { low: 50, high: 100 },
    referenceMetric: "RESTING_HEART_RATE",
    chart: {
      overlayKey: "restingHr",
      color: "var(--destructive)",
      yAxisUnit: "bpm",
    },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("resting_hr"),
      mcp: true,
    },
    fhir: {
      loinc: "40443-4",
      display: "Heart rate --resting",
      unit: "/min",
      category: "vital-signs",
    },
  },
  HEART_RATE_VARIABILITY: {
    key: "HEART_RATE_VARIABILITY",
    kind: "measurement",
    source: { measurementType: "HEART_RATE_VARIABILITY" },
    sourcePriorityKey: "hrv",
    displayName: "Heart-rate variability (SDNN)",
    unit: "ms",
    direction: "higher-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("hrv"),
      mcp: true,
    },
    fhir: {
      loinc: "80404-7",
      display: "R-R interval.standard deviation (Heart rate variability)",
      unit: "ms",
      category: "vital-signs",
    },
  },
  OXYGEN_SATURATION: {
    key: "OXYGEN_SATURATION",
    kind: "measurement",
    source: { measurementType: "OXYGEN_SATURATION" },
    sourcePriorityKey: "spo2",
    displayName: "Blood oxygen (SpO₂)",
    unit: "%",
    direction: "higher-better",
    archetype: "physiological-vital",
    normalRange: { low: 95, high: 100 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("spo2"),
      mcp: true,
    },
    fhir: {
      loinc: "59408-5",
      display: "Oxygen saturation in Arterial blood by Pulse oximetry",
      unit: "%",
      category: "vital-signs",
    },
  },
  RESPIRATORY_RATE: {
    key: "RESPIRATORY_RATE",
    kind: "measurement",
    source: { measurementType: "RESPIRATORY_RATE" },
    sourcePriorityKey: "respiratoryRate",
    displayName: "Respiratory rate",
    unit: "breaths/min",
    direction: "target-band",
    archetype: "physiological-vital",
    normalRange: { low: 12, high: 20 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("respiratory_rate"),
      mcp: true,
    },
    fhir: {
      loinc: "9279-1",
      display: "Respiratory rate",
      unit: "/min",
      category: "vital-signs",
    },
  },
  BODY_TEMPERATURE: {
    key: "BODY_TEMPERATURE",
    kind: "measurement",
    source: { measurementType: "BODY_TEMPERATURE" },
    sourcePriorityKey: "bodyTemperature",
    displayName: "Body temperature",
    unit: "°C",
    direction: "target-band",
    archetype: "physiological-vital",
    normalRange: { low: 36.1, high: 37.2 },
    feverBandC: FEVER_BAND_C,
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("body_temp"),
      mcp: true,
    },
    fhir: {
      loinc: "8310-5",
      display: "Body temperature",
      unit: "Cel",
      category: "vital-signs",
    },
  },
  SKIN_TEMPERATURE: {
    key: "SKIN_TEMPERATURE",
    kind: "measurement",
    source: { measurementType: "SKIN_TEMPERATURE" },
    sourcePriorityKey: "skinTemperature",
    displayName: "Wrist skin temperature",
    unit: "°C",
    direction: "target-band",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("skin_temp"),
      mcp: true,
    },
  },
  BLOOD_GLUCOSE: {
    key: "BLOOD_GLUCOSE",
    kind: "measurement",
    source: { measurementType: "BLOOD_GLUCOSE" },
    displayName: "Blood glucose",
    unit: "mg/dL",
    direction: "target-band",
    archetype: "physiological-vital",
    normalRange: { low: 70, high: 140 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("glucose"),
      mcp: true,
    },
  },
  WALKING_HEART_RATE_AVERAGE: {
    key: "WALKING_HEART_RATE_AVERAGE",
    kind: "measurement",
    source: { measurementType: "WALKING_HEART_RATE_AVERAGE" },
    displayName: "Walking heart rate",
    unit: "bpm",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("walking_hr"),
      mcp: true,
    },
  },
  PULSE_WAVE_VELOCITY: {
    key: "PULSE_WAVE_VELOCITY",
    kind: "measurement",
    source: { measurementType: "PULSE_WAVE_VELOCITY" },
    displayName: "Pulse-wave velocity",
    unit: "m/s",
    direction: "lower-better",
    archetype: "physiological-vital",
    normalRange: { low: 0, high: 10 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("pulse_wave_velocity"),
      mcp: true,
    },
  },
  VASCULAR_AGE: {
    key: "VASCULAR_AGE",
    kind: "measurement",
    source: { measurementType: "VASCULAR_AGE" },
    displayName: "Vascular age",
    unit: "years",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("vascular_age"),
      mcp: true,
    },
  },
  CARDIO_RECOVERY: {
    key: "CARDIO_RECOVERY",
    kind: "measurement",
    source: { measurementType: "CARDIO_RECOVERY" },
    displayName: "Cardio recovery",
    unit: "bpm",
    direction: "higher-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
      display: "Cardio recovery (1-minute heart-rate recovery)",
      unit: "/min",
      category: "vital-signs",
    },
  },
  WRIST_TEMPERATURE: {
    key: "WRIST_TEMPERATURE",
    kind: "measurement",
    source: { measurementType: "WRIST_TEMPERATURE" },
    displayName: "Wrist temperature",
    unit: "°C",
    direction: "target-band",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
      display: "Sleeping wrist temperature",
      unit: "Cel",
      category: "vital-signs",
    },
  },
  ANS_CHARGE: {
    key: "ANS_CHARGE",
    kind: "measurement",
    source: { measurementType: "ANS_CHARGE" },
    displayName: "ANS charge",
    unit: "score",
    direction: "higher-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  AVERAGE_HEART_RATE: {
    key: "AVERAGE_HEART_RATE",
    kind: "measurement",
    source: { measurementType: "AVERAGE_HEART_RATE" },
    displayName: "Average heart rate",
    unit: "bpm",
    direction: "target-band",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  MAX_HEART_RATE: {
    key: "MAX_HEART_RATE",
    kind: "measurement",
    source: { measurementType: "MAX_HEART_RATE" },
    displayName: "Max heart rate",
    unit: "bpm",
    direction: "target-band",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  // ── activity-fitness ─────────────────────────────────────────────────
  STEPS: {
    key: "STEPS",
    kind: "measurement",
    source: { measurementType: "ACTIVITY_STEPS" },
    sourcePriorityKey: "steps",
    displayName: "Steps",
    unit: "steps/day",
    direction: "higher-better",
    archetype: "activity-fitness",
    normalRange: { low: 8000, high: 15000 },
    surfaces: {
      detailPage: true,
      correlationEligible: true,
      coachSnapshot: coachScope("steps"),
      mcp: true,
    },
    fhir: {
      loinc: "41950-7",
      display: "Number of steps in 24 hour Measured",
      unit: "{steps}",
      category: "activity",
    },
  },
  ACTIVE_ENERGY: {
    key: "ACTIVE_ENERGY",
    kind: "measurement",
    source: { measurementType: "ACTIVE_ENERGY_BURNED" },
    sourcePriorityKey: "activeEnergy",
    displayName: "Active energy",
    unit: "kcal/day",
    direction: "higher-better",
    archetype: "activity-fitness",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("active_energy"),
      mcp: true,
    },
    fhir: {
      loinc: "41981-2",
      display: "Calories burned",
      unit: "kcal",
      category: "activity",
    },
  },
  FLIGHTS_CLIMBED: {
    key: "FLIGHTS_CLIMBED",
    kind: "measurement",
    source: { measurementType: "FLIGHTS_CLIMBED" },
    sourcePriorityKey: "flightsClimbed",
    displayName: "Flights climbed",
    unit: "flights/day",
    direction: "higher-better",
    archetype: "activity-fitness",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("flights"),
      mcp: true,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierFlightsClimbed",
      display: "Flights climbed",
      unit: "{flights}",
      category: "activity",
    },
  },
  WALKING_RUNNING_DISTANCE: {
    key: "WALKING_RUNNING_DISTANCE",
    kind: "measurement",
    source: { measurementType: "WALKING_RUNNING_DISTANCE" },
    sourcePriorityKey: "walkingRunningDistance",
    displayName: "Walking + running distance",
    unit: "m/day",
    direction: "higher-better",
    archetype: "activity-fitness",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("distance"),
      mcp: true,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierDistanceWalkingRunning",
      display: "Distance walking/running",
      unit: "m",
      category: "activity",
    },
  },
  TIME_IN_DAYLIGHT: {
    key: "TIME_IN_DAYLIGHT",
    kind: "measurement",
    source: { measurementType: "TIME_IN_DAYLIGHT" },
    displayName: "Time in daylight",
    unit: "min/day",
    direction: "higher-better",
    archetype: "activity-fitness",
    normalRange: { low: 30, high: 120 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("daylight"),
      mcp: true,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierTimeInDaylight",
      display: "Time in daylight",
      unit: "min",
      category: "activity",
    },
  },
  VO2_MAX: {
    key: "VO2_MAX",
    kind: "measurement",
    source: { measurementType: "VO2_MAX" },
    sourcePriorityKey: "vo2Max",
    displayName: "VO₂ max (cardio fitness)",
    unit: "mL/(kg·min)",
    direction: "higher-better",
    archetype: "activity-fitness",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("vo2_max"),
      mcp: true,
    },
    fhir: {
      // 96402-2, used before, does not exist in LOINC. The watch estimate is
      // not a measured exercise-test VO2 peak (94122-9), so the HealthKit
      // identifier rides the custom system.
      loinc: "HKQuantityTypeIdentifierVO2Max",
      display: "VO2 max (estimated)",
      unit: "mL/min/kg",
      category: "vital-signs",
    },
  },
  DAY_STRAIN: {
    key: "DAY_STRAIN",
    kind: "measurement",
    source: { measurementType: "DAY_STRAIN" },
    displayName: "Day strain",
    unit: "score",
    direction: "target-band",
    archetype: "activity-fitness",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  WORKOUT_STRAIN: {
    key: "WORKOUT_STRAIN",
    kind: "measurement",
    source: { measurementType: "WORKOUT_STRAIN" },
    displayName: "Workout strain",
    unit: "score",
    direction: "target-band",
    archetype: "activity-fitness",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  CARDIO_LOAD: {
    key: "CARDIO_LOAD",
    kind: "measurement",
    source: { measurementType: "CARDIO_LOAD" },
    displayName: "Cardio load",
    unit: "score",
    direction: "target-band",
    archetype: "activity-fitness",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  ENERGY_EXPENDITURE_KJ: {
    key: "ENERGY_EXPENDITURE_KJ",
    kind: "measurement",
    source: { measurementType: "ENERGY_EXPENDITURE_KJ" },
    displayName: "Energy expenditure",
    unit: "kJ",
    direction: "higher-better",
    archetype: "activity-fitness",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  // ── body-composition ─────────────────────────────────────────────────
  TOTAL_BODY_WATER: {
    key: "TOTAL_BODY_WATER",
    kind: "measurement",
    source: { measurementType: "TOTAL_BODY_WATER" },
    displayName: "Total body water",
    unit: "kg",
    direction: "target-band",
    archetype: "body-composition",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("total_body_water"),
      mcp: true,
    },
    fhir: {
      // 73704-9, used before, is a nasogastric fluid output.
      loinc: "101683-1",
      display: "Body water mass",
      unit: "kg",
      category: "vital-signs",
    },
  },
  BONE_MASS: {
    key: "BONE_MASS",
    kind: "measurement",
    source: { measurementType: "BONE_MASS" },
    displayName: "Bone mass",
    unit: "kg",
    direction: "target-band",
    archetype: "body-composition",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("bone_mass"),
      mcp: true,
    },
    fhir: {
      // 73708-0, used before, is "Body fat [Mass] Calculated".
      loinc: "101685-6",
      display: "Body bone mass",
      unit: "kg",
      category: "vital-signs",
    },
  },
  FAT_FREE_MASS: {
    key: "FAT_FREE_MASS",
    kind: "measurement",
    source: { measurementType: "FAT_FREE_MASS" },
    displayName: "Fat-free mass",
    unit: "kg",
    direction: "target-band",
    archetype: "body-composition",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("fat_free_mass"),
      mcp: true,
    },
    fhir: {
      loinc: null,
      display: "Fat-free mass",
      unit: "kg",
      category: "vital-signs",
    },
  },
  FAT_MASS: {
    key: "FAT_MASS",
    kind: "measurement",
    source: { measurementType: "FAT_MASS" },
    displayName: "Fat mass",
    unit: "kg",
    direction: "lower-better",
    archetype: "body-composition",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("fat_mass"),
      mcp: true,
    },
    fhir: {
      loinc: null,
      display: "Fat mass",
      unit: "kg",
      category: "vital-signs",
    },
  },
  MUSCLE_MASS: {
    key: "MUSCLE_MASS",
    kind: "measurement",
    source: { measurementType: "MUSCLE_MASS" },
    displayName: "Muscle mass",
    unit: "kg",
    direction: "higher-better",
    archetype: "body-composition",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("muscle_mass"),
      mcp: true,
    },
    fhir: {
      loinc: null,
      display: "Muscle mass",
      unit: "kg",
      category: "vital-signs",
    },
  },
  LEAN_BODY_MASS: {
    key: "LEAN_BODY_MASS",
    kind: "measurement",
    source: { measurementType: "LEAN_BODY_MASS" },
    displayName: "Lean body mass",
    unit: "kg",
    direction: "target-band",
    archetype: "body-composition",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("lean_body_mass"),
      mcp: true,
    },
    fhir: {
      loinc: null,
      display: "Lean body mass",
      unit: "kg",
      category: "vital-signs",
    },
  },
  VISCERAL_FAT: {
    key: "VISCERAL_FAT",
    kind: "measurement",
    source: { measurementType: "VISCERAL_FAT" },
    displayName: "Visceral fat rating",
    unit: "rating",
    direction: "lower-better",
    archetype: "body-composition",
    normalRange: { low: 1, high: 12 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("visceral_fat"),
      mcp: true,
    },
    fhir: {
      loinc: null,
      display: "Visceral fat",
      unit: "1",
      category: "vital-signs",
    },
  },
  // ── mobility-gait ────────────────────────────────────────────────────
  WALKING_STEADINESS: {
    key: "WALKING_STEADINESS",
    kind: "measurement",
    source: { measurementType: "WALKING_STEADINESS" },
    displayName: "Walking steadiness",
    unit: "%",
    direction: "higher-better",
    archetype: "mobility-gait",
    normalRange: { low: 50, high: 100 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("walking_steadiness"),
      mcp: true,
    },
  },
  WALKING_ASYMMETRY: {
    key: "WALKING_ASYMMETRY",
    kind: "measurement",
    source: { measurementType: "WALKING_ASYMMETRY" },
    displayName: "Walking asymmetry",
    unit: "%",
    direction: "lower-better",
    archetype: "mobility-gait",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("walking_asymmetry"),
      mcp: true,
    },
    fhir: {
      // 91557-1, used before, does not exist in LOINC.
      loinc: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
      display: "Walking asymmetry percentage",
      unit: "%",
      category: "vital-signs",
    },
  },
  WALKING_DOUBLE_SUPPORT: {
    key: "WALKING_DOUBLE_SUPPORT",
    kind: "measurement",
    source: { measurementType: "WALKING_DOUBLE_SUPPORT" },
    displayName: "Double-support time",
    unit: "%",
    direction: "lower-better",
    archetype: "mobility-gait",
    normalRange: { low: 20, high: 40 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("walking_double_support"),
      mcp: true,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
      display: "Walking double support percentage",
      unit: "%",
      category: "vital-signs",
    },
  },
  WALKING_STEP_LENGTH: {
    key: "WALKING_STEP_LENGTH",
    kind: "measurement",
    source: { measurementType: "WALKING_STEP_LENGTH" },
    displayName: "Step length",
    unit: "m",
    direction: "higher-better",
    archetype: "mobility-gait",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("walking_step_length"),
      mcp: true,
    },
    fhir: {
      // 41955-6, used before, is "Distance walked in 1 week"; LOINC has no
      // step-length term, so the HealthKit identifier rides the custom system.
      loinc: "HKQuantityTypeIdentifierWalkingStepLength",
      display: "Walking step length",
      unit: "m",
      category: "vital-signs",
    },
  },
  WALKING_SPEED: {
    key: "WALKING_SPEED",
    kind: "measurement",
    source: { measurementType: "WALKING_SPEED" },
    displayName: "Walking speed",
    unit: "m/s",
    direction: "higher-better",
    archetype: "mobility-gait",
    normalRange: { low: 1.2, high: 1.4 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("walking_speed"),
      mcp: true,
    },
    fhir: {
      // 41957-2, used before, is a 24-hour mean walking speed; the value
      // here is a HealthKit walking-speed reading.
      loinc: "HKQuantityTypeIdentifierWalkingSpeed",
      display: "Walking speed",
      unit: "m/s",
      category: "vital-signs",
    },
  },
  FALL_COUNT: {
    key: "FALL_COUNT",
    kind: "measurement",
    source: { measurementType: "FALL_COUNT" },
    displayName: "Falls",
    unit: "falls/day",
    direction: "lower-better",
    archetype: "mobility-gait",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierNumberOfTimesFallen",
      display: "Number of times fallen",
      unit: "{falls}",
      category: "activity",
    },
  },
  SIX_MINUTE_WALK_DISTANCE: {
    key: "SIX_MINUTE_WALK_DISTANCE",
    kind: "measurement",
    source: { measurementType: "SIX_MINUTE_WALK_DISTANCE" },
    displayName: "Six-minute walk distance",
    unit: "m",
    direction: "higher-better",
    archetype: "mobility-gait",
    normalRange: { low: 400, high: 700 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierSixMinuteWalkTestDistance",
      display: "Six-minute walk test distance",
      unit: "m",
      category: "activity",
    },
  },
  STAIR_ASCENT_SPEED: {
    key: "STAIR_ASCENT_SPEED",
    kind: "measurement",
    source: { measurementType: "STAIR_ASCENT_SPEED" },
    displayName: "Stair ascent speed",
    unit: "m/s",
    direction: "higher-better",
    archetype: "mobility-gait",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierStairAscentSpeed",
      display: "Stair ascent speed",
      unit: "m/s",
      category: "vital-signs",
    },
  },
  STAIR_DESCENT_SPEED: {
    key: "STAIR_DESCENT_SPEED",
    kind: "measurement",
    source: { measurementType: "STAIR_DESCENT_SPEED" },
    displayName: "Stair descent speed",
    unit: "m/s",
    direction: "higher-better",
    archetype: "mobility-gait",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierStairDescentSpeed",
      display: "Stair descent speed",
      unit: "m/s",
      category: "vital-signs",
    },
  },
  // ── environmental-exposure ───────────────────────────────────────────
  AUDIO_EXPOSURE_ENV: {
    key: "AUDIO_EXPOSURE_ENV",
    kind: "measurement",
    source: { measurementType: "AUDIO_EXPOSURE_ENV" },
    displayName: "Environmental sound exposure",
    unit: "dBA",
    direction: "lower-better",
    archetype: "environmental-exposure",
    normalRange: { low: 0, high: 80 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("audio_env"),
      mcp: true,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
      display: "Environmental audio exposure",
      unit: "dB[A]",
      category: "vital-signs",
    },
  },
  AUDIO_EXPOSURE_HEADPHONE: {
    key: "AUDIO_EXPOSURE_HEADPHONE",
    kind: "measurement",
    source: { measurementType: "AUDIO_EXPOSURE_HEADPHONE" },
    displayName: "Headphone audio exposure",
    unit: "dBA",
    direction: "lower-better",
    archetype: "environmental-exposure",
    normalRange: { low: 0, high: 80 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("audio_headphone"),
      mcp: true,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierHeadphoneAudioExposure",
      display: "Headphone audio exposure",
      unit: "dB[A]",
      category: "vital-signs",
    },
  },
  AUDIO_EXPOSURE_EVENT: {
    key: "AUDIO_EXPOSURE_EVENT",
    kind: "measurement",
    source: { measurementType: "AUDIO_EXPOSURE_EVENT" },
    displayName: "Loud-exposure events",
    unit: "events",
    direction: "lower-better",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: coachScope("audio_event"),
      mcp: true,
    },
  },
  // ── sleep (dedicated template) ───────────────────────────────────────
  SLEEP_DURATION: {
    key: "SLEEP_DURATION",
    kind: "measurement",
    source: { measurementType: "SLEEP_DURATION" },
    sourcePriorityKey: "sleep",
    displayName: "Sleep duration",
    unit: "min",
    direction: "target-band",
    archetype: "sleep",
    normalRange: { low: 420, high: 540 },
    surfaces: {
      detailPage: true,
      correlationEligible: true,
      coachSnapshot: coachScope("sleep"),
      mcp: true,
    },
    fhir: {
      loinc: "93832-4",
      display: "Sleep duration",
      unit: "h",
      category: "activity",
    },
  },
  BREATHING_DISTURBANCES: {
    key: "BREATHING_DISTURBANCES",
    kind: "measurement",
    source: { measurementType: "BREATHING_DISTURBANCES" },
    displayName: "Sleep breathing disturbances",
    unit: "count",
    direction: "lower-better",
    archetype: "sleep",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      loinc: "HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances",
      display: "Sleeping breathing disturbances",
      unit: "{count}",
      category: "vital-signs",
    },
  },
  SLEEP_SCORE: {
    key: "SLEEP_SCORE",
    kind: "measurement",
    source: { measurementType: "SLEEP_SCORE" },
    displayName: "Sleep score",
    unit: "score",
    direction: "higher-better",
    archetype: "sleep",
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  // ── specialised metrics (bespoke status files; detailPage:false) ──────
  // These keep their dedicated scopes + status generators; they register
  // only so the cross-surface indices (FHIR, correlation, Coach, MCP) see
  // them without routing them through the generic detail template.
  WEIGHT: {
    key: "WEIGHT",
    kind: "measurement",
    source: { measurementType: "WEIGHT" },
    sourcePriorityKey: "weight",
    displayName: "Weight",
    unit: "kg",
    direction: "target-band",
    archetype: "body-composition",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: coachScope("weight"),
      mcp: true,
    },
    fhir: {
      loinc: "29463-7",
      display: "Body weight",
      unit: "kg",
      category: "vital-signs",
    },
  },
  BODY_MASS_INDEX: {
    key: "BODY_MASS_INDEX",
    kind: "measurement",
    source: { measurementType: "BODY_MASS_INDEX" },
    displayName: "Body mass index",
    unit: "kg/m²",
    direction: "target-band",
    archetype: "body-composition",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: coachScope("bmi"),
      mcp: true,
    },
    fhir: {
      loinc: "39156-5",
      display: "Body mass index (BMI) [Ratio]",
      unit: "kg/m2",
      category: "vital-signs",
    },
  },
  PULSE: {
    key: "PULSE",
    kind: "measurement",
    source: { measurementType: "PULSE" },
    sourcePriorityKey: "pulse",
    displayName: "Pulse",
    unit: "bpm",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: coachScope("pulse"),
      mcp: true,
    },
    fhir: {
      loinc: "8867-4",
      display: "Heart rate",
      unit: "/min",
      category: "vital-signs",
    },
  },
  BODY_FAT: {
    key: "BODY_FAT",
    kind: "measurement",
    source: { measurementType: "BODY_FAT" },
    sourcePriorityKey: "bodyFat",
    displayName: "Body fat",
    unit: "%",
    direction: "lower-better",
    archetype: "body-composition",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: coachScope("body_fat"),
      mcp: true,
    },
    fhir: {
      loinc: "41982-0",
      display: "Percentage of body fat Measured",
      unit: "%",
      category: "vital-signs",
    },
  },
  BLOOD_PRESSURE_SYS: {
    key: "BLOOD_PRESSURE_SYS",
    kind: "measurement",
    source: { measurementType: "BLOOD_PRESSURE_SYS" },
    sourcePriorityKey: "bloodPressure",
    displayName: "Blood pressure (systolic)",
    unit: "mmHg",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: coachScope("bp"),
      mcp: true,
    },
  },
  BLOOD_PRESSURE_DIA: {
    key: "BLOOD_PRESSURE_DIA",
    kind: "measurement",
    source: { measurementType: "BLOOD_PRESSURE_DIA" },
    sourcePriorityKey: "bloodPressure",
    displayName: "Blood pressure (diastolic)",
    unit: "mmHg",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: coachScope("bp"),
      mcp: true,
    },
  },
  // ── v1.25 clinical-signals wave — validated mental-health screeners ──────
  // PHQ-9 / GAD-7 totals. Opt-in, beside mood tracking. Deliberately kept OFF
  // the Coach snapshot + MCP surfaces (`coachSnapshot:false` ⇒ `mcp:false`):
  // mental-health item content is excluded from AI by construction, and the
  // score trend stays a quiet local signal. FHIR rides the `survey` category
  // with the instrument total-score LOINC.
  PHQ9_SCORE: {
    key: "PHQ9_SCORE",
    kind: "score",
    source: { measurementType: "PHQ9_SCORE" },
    displayName: "PHQ-9 depression screen (total)",
    unit: "score",
    direction: "lower-better",
    archetype: "physiological-vital",
    normalRange: { low: 0, high: 4 },
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      loinc: "44261-6",
      display:
        "Patient Health Questionnaire 9 item (PHQ-9) total score [Reported]",
      unit: "{score}",
      category: "survey",
    },
  },
  GAD7_SCORE: {
    key: "GAD7_SCORE",
    kind: "score",
    source: { measurementType: "GAD7_SCORE" },
    displayName: "GAD-7 anxiety screen (total)",
    unit: "score",
    direction: "lower-better",
    archetype: "physiological-vital",
    normalRange: { low: 0, high: 4 },
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      loinc: "70274-6",
      display:
        "Generalized anxiety disorder 7 item (GAD-7) total score [Reported.PHQ]",
      unit: "{score}",
      category: "survey",
    },
  },
  // ── v1.27.9 — WHO-5 well-being + Sleep Condition Indicator totals ───────
  // Same privacy posture as PHQ-9 / GAD-7 (off Coach snapshot + MCP; item
  // content never rides a Measurement row). Direction inverts: HIGHER is
  // better for both. No verified total-score LOINC exists for either, so both
  // carry the `loinc: null` text-only survey concept the physical signals
  // already use — an uncoded finding a clinician can read, never an invented
  // code. Without a `fhir` facet the FHIR adapter drops a signal entirely,
  // which is how a total the PDF and the share view show went missing from
  // every FHIR output.
  WHO5_SCORE: {
    key: "WHO5_SCORE",
    kind: "score",
    source: { measurementType: "WHO5_SCORE" },
    displayName: "WHO-5 well-being index (0–100)",
    unit: "score",
    direction: "higher-better",
    archetype: "physiological-vital",
    // "Below 50" is the WHO-suggested cut-off; achievable totals are
    // multiples of 4, so ≥ 52 is the good side.
    normalRange: { low: 52, high: 100 },
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      // No verified total-score LOINC — local text concept, `{score}` UCUM.
      loinc: null,
      display: "WHO-5 well-being index total score",
      unit: "{score}",
      category: "survey",
    },
  },
  SCI_SCORE: {
    key: "SCI_SCORE",
    kind: "score",
    source: { measurementType: "SCI_SCORE" },
    displayName: "Sleep Condition Indicator (total)",
    unit: "score",
    direction: "higher-better",
    archetype: "physiological-vital",
    // > 16 identified "no insomnia disorder" in Espie et al. 2014.
    normalRange: { low: 17, high: 32 },
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
    fhir: {
      // No verified total-score LOINC — local text concept, `{score}` UCUM.
      loinc: null,
      display: "Sleep Condition Indicator total score",
      unit: "{score}",
      category: "survey",
    },
  },
  // ── v1.25 clinical-signals wave — physical / clinical measurements ──────
  GRIP_STRENGTH: {
    key: "GRIP_STRENGTH",
    kind: "measurement",
    source: { measurementType: "GRIP_STRENGTH" },
    displayName: "Grip strength",
    unit: "kg",
    direction: "higher-better",
    archetype: "activity-fitness",
    // Coarse population floor; the EWGSOP2 cut-off is sex-specific (men < 27,
    // women < 16 kg) and resolved at the display edge by the sex-aware band
    // resolver (`norms.ts` GRIP_STRENGTH table) the detail-page assessment
    // threads through `lookupNormalRange`.
    normalRange: { low: 16, high: 60 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      // Off the Coach snapshot, but reachable over MCP: the `mcp` facet is
      // independent of `coachSnapshot`. The MCP rich reads expose it through
      // the rollup-backed baseline / compare / change-point reads.
      coachSnapshot: false,
      mcp: true,
    },
    fhir: {
      // NEEDS-VERIFY: no hand-grip-strength LOINC confirmed this pass —
      // emits a local text concept until a stable LOINC is checked on loinc.org.
      loinc: null,
      display: "Hand grip strength",
      unit: "kg",
      category: "vital-signs",
    },
  },
  PAIN_NRS: {
    key: "PAIN_NRS",
    kind: "measurement",
    source: { measurementType: "PAIN_NRS" },
    displayName: "Pain (0–10 NRS)",
    unit: "score",
    direction: "lower-better",
    archetype: "physiological-vital",
    normalRange: { low: 0, high: 3 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      // Off the Coach snapshot, reachable over MCP (independent facets).
      coachSnapshot: false,
      mcp: true,
    },
    fhir: {
      loinc: "72514-3",
      display: "Pain severity - 0-10 verbal numeric rating [Score] - Reported",
      unit: "{score}",
      category: "survey",
    },
  },
  WAIST_CIRCUMFERENCE: {
    key: "WAIST_CIRCUMFERENCE",
    kind: "measurement",
    source: { measurementType: "WAIST_CIRCUMFERENCE" },
    sourcePriorityKey: "waist",
    displayName: "Waist circumference",
    unit: "cm",
    direction: "lower-better",
    archetype: "body-composition",
    // WHO European-origin increased-risk threshold (men > 94); the sex-aware
    // resolver (`norms.ts` WAIST_CIRCUMFERENCE table: men 94 / women 80)
    // sharpens it at the display edge via `lookupNormalRange`.
    normalRange: { low: 0, high: 94 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      // Off the Coach snapshot, reachable over MCP (independent facets).
      coachSnapshot: false,
      mcp: true,
    },
    fhir: {
      loinc: "8280-0",
      display: "Waist circumference at umbilicus by Tape measure",
      unit: "cm",
      category: "vital-signs",
    },
  },
  WAIST_TO_HEIGHT: {
    key: "WAIST_TO_HEIGHT",
    kind: "measurement",
    source: { measurementType: "WAIST_TO_HEIGHT" },
    displayName: "Waist-to-height ratio",
    unit: "ratio",
    direction: "lower-better",
    archetype: "body-composition",
    // NICE: keep waist under half your height — WHtR ≥ 0.5 flags increased
    // risk, so the last in-range value sits just below the 0.5 threshold
    // (`high: 0.49`) and a 0.50 reading classifies as increased, not normal.
    normalRange: { low: 0, high: 0.49 },
    surfaces: {
      detailPage: true,
      correlationEligible: false,
      // Off the Coach snapshot, reachable over MCP (independent facets).
      coachSnapshot: false,
      mcp: true,
    },
    fhir: {
      // NEEDS-VERIFY: WHtR LOINC not confirmed this pass — local text concept.
      loinc: null,
      display: "Waist to height ratio",
      unit: "1",
      category: "vital-signs",
    },
  },
  // ── v1.25 clinical-signals wave — longevity lab panel (kind:"biomarker") ─
  // Registered through the registry to prove the labs path under one definition
  // shape. The lab FHIR/UCUM coding lives in `fhir/lab-loinc.ts`; the
  // biomarker-detail rail renders these via the labs catalog. Off Coach/MCP
  // here (the labs surface has its own `get_labs` MCP tool).
  APOB: {
    key: "APOB",
    kind: "biomarker",
    source: { biomarkerKey: "apob" },
    displayName: "Apolipoprotein B",
    unit: "mg/dL",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  LPA: {
    key: "LPA",
    kind: "biomarker",
    source: { biomarkerKey: "lp-a" },
    displayName: "Lipoprotein(a)",
    unit: "nmol/L",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  HS_CRP: {
    key: "HS_CRP",
    kind: "biomarker",
    source: { biomarkerKey: "hs-crp" },
    displayName: "hs-CRP",
    unit: "mg/L",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  HBA1C: {
    key: "HBA1C",
    kind: "biomarker",
    source: { biomarkerKey: "hba1c" },
    displayName: "HbA1c",
    unit: "%",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  FASTING_GLUCOSE: {
    key: "FASTING_GLUCOSE",
    kind: "biomarker",
    source: { biomarkerKey: "fasting-glucose" },
    displayName: "Fasting glucose",
    unit: "mg/dL",
    direction: "target-band",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  FASTING_INSULIN: {
    key: "FASTING_INSULIN",
    kind: "biomarker",
    source: { biomarkerKey: "fasting-insulin" },
    displayName: "Fasting insulin",
    unit: "µIU/mL",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  EGFR: {
    key: "EGFR",
    kind: "biomarker",
    source: { biomarkerKey: "egfr" },
    displayName: "eGFR (CKD-EPI 2021)",
    unit: "mL/min/1.73m²",
    direction: "higher-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  GGT: {
    key: "GGT",
    kind: "biomarker",
    source: { biomarkerKey: "ggt" },
    displayName: "GGT",
    unit: "U/L",
    direction: "lower-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  FERRITIN: {
    key: "FERRITIN",
    kind: "biomarker",
    source: { biomarkerKey: "ferritin" },
    displayName: "Ferritin",
    unit: "ng/mL",
    direction: "target-band",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  OMEGA3_INDEX: {
    key: "OMEGA3_INDEX",
    kind: "biomarker",
    source: { biomarkerKey: "omega-3-index" },
    displayName: "Omega-3 index",
    unit: "%",
    direction: "higher-better",
    archetype: "physiological-vital",
    surfaces: {
      detailPage: false,
      correlationEligible: false,
      coachSnapshot: false,
      mcp: false,
    },
  },
  // ── v1.25 (W-ENV) environmental-context module — exposure signals ─────────
  // Daily weather/daylight, fetched server-side from Open-Meteo for the user's
  // coarse home (or a travel override) and stored in `EnvironmentContext`. NOT
  // `MeasurementType`-backed: `correlationEligible:true` declares intent, but
  // the wiring runs through the env channel series builder, not the
  // measurement-keyed `BUCKETED_TYPES` (the correlation adapter skips
  // `kind:"environment"`). Off the Coach snapshot + MCP surfaces in v1
  // (`coachSnapshot:false ⇒ mcp:false`); no FHIR facet (env observations are
  // not Measurement rows, so they never enter `MEASUREMENT_LOINC`). Direction is
  // `target-band` — a neutral exposure, not a "better/worse" vital.
  ENV_TEMP_MEAN: {
    key: "ENV_TEMP_MEAN",
    kind: "environment",
    source: { environmentChannelKey: "ENV_TEMP_MEAN" },
    i18nPrefix: "environment.fields.tempMean",
    displayName: "Daily temperature",
    unit: "°C",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  },
  ENV_TEMP_MIN: {
    key: "ENV_TEMP_MIN",
    kind: "environment",
    source: { environmentChannelKey: "ENV_TEMP_MIN" },
    i18nPrefix: "environment.fields.tempMin",
    displayName: "Overnight low temperature",
    unit: "°C",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  },
  ENV_SUNSHINE: {
    key: "ENV_SUNSHINE",
    kind: "environment",
    source: { environmentChannelKey: "ENV_SUNSHINE" },
    i18nPrefix: "environment.fields.sunshine",
    displayName: "Sunshine duration",
    unit: "h",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  },
  ENV_DAYLIGHT: {
    key: "ENV_DAYLIGHT",
    kind: "environment",
    source: { environmentChannelKey: "ENV_DAYLIGHT" },
    i18nPrefix: "environment.fields.daylight",
    displayName: "Daylight length",
    unit: "h",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  },
  ENV_PRECIP: {
    key: "ENV_PRECIP",
    kind: "environment",
    source: { environmentChannelKey: "ENV_PRECIP" },
    i18nPrefix: "environment.fields.precip",
    displayName: "Precipitation",
    unit: "mm",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  },
  ENV_PRESSURE_MEAN: {
    key: "ENV_PRESSURE_MEAN",
    kind: "environment",
    source: { environmentChannelKey: "ENV_PRESSURE_MEAN" },
    i18nPrefix: "environment.fields.pressureMean",
    displayName: "Barometric pressure",
    unit: "hPa",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  },
  ENV_PRESSURE_DELTA: {
    key: "ENV_PRESSURE_DELTA",
    kind: "environment",
    source: { environmentChannelKey: "ENV_PRESSURE_DELTA" },
    i18nPrefix: "environment.fields.pressureDelta",
    displayName: "Pressure swing",
    unit: "hPa",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  }, // ── v1.42 (#615) air-quality exposure channels ───────────────────────────
  // Three correlation channels out of the air-quality feed: fine particles,
  // the ozone 8-hour high, and the day's highest pollen count. UV, NO2 and
  // dust are display and Coach context only. Same surface flags as the weather
  // channels above; the channel series builder carries the wiring.
  ENV_PM25: {
    key: "ENV_PM25",
    kind: "environment",
    source: { environmentChannelKey: "ENV_PM25" },
    i18nPrefix: "environment.fields.pm25",
    displayName: "Fine particles (PM2.5)",
    unit: "µg/m³",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  },
  ENV_OZONE_8H: {
    key: "ENV_OZONE_8H",
    kind: "environment",
    source: { environmentChannelKey: "ENV_OZONE_8H" },
    i18nPrefix: "environment.fields.ozone8h",
    displayName: "Ozone (8-hour high)",
    unit: "µg/m³",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  },
  ENV_POLLEN_MAX: {
    key: "ENV_POLLEN_MAX",
    kind: "environment",
    source: { environmentChannelKey: "ENV_POLLEN_MAX" },
    i18nPrefix: "environment.fields.pollenMax",
    displayName: "Pollen (highest)",
    unit: "grains/m³",
    direction: "target-band",
    archetype: "environmental-exposure",
    surfaces: {
      detailPage: false,
      correlationEligible: true,
      coachSnapshot: false,
      mcp: false,
    },
  },
};

/** Type guard: narrow an arbitrary string to a registered signal key. */
export function isSignalKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(SIGNALS, key);
}

/** Resolve a signal by its key, or null when unregistered. */
export function getSignal(key: string): SignalDefinition | null {
  return isSignalKey(key) ? SIGNALS[key] : null;
}

/** Every registered signal, in declaration order. */
export function allSignals(): SignalDefinition[] {
  return Object.values(SIGNALS);
}

/** Reverse index: DB `MeasurementType` → the signal it backs (built once). */
const MEASUREMENT_TYPE_TO_SIGNAL = new Map<MeasurementType, SignalDefinition>(
  allSignals()
    .filter(
      (s): s is Extract<SignalDefinition, { kind: "measurement" | "score" }> =>
        s.kind === "measurement" || s.kind === "score",
    )
    .map((s) => [s.source.measurementType, s]),
);

/** Resolve the signal a `MeasurementType` backs, or null when unregistered. */
export function signalForMeasurementType(
  type: MeasurementType,
): SignalDefinition | null {
  return MEASUREMENT_TYPE_TO_SIGNAL.get(type) ?? null;
}
