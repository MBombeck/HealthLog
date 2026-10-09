import { annotate } from "@/lib/logging/context";
import {
  getReadingTransform,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import { sourceCluster } from "../clusters";
import {
  bucketWeekly,
  buildDailyValueRows,
  dailyPoints,
  timelineInUnit,
} from "../snapshot-series";
import type { RegisterBlock } from "../series-condense";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScopeSource,
} from "../types";

type ValueMetric = Exclude<
  CoachProvenanceMetric,
  "general" | "bp" | "weight" | "pulse" | "mood" | "compliance" | "glucose"
>;

interface ValueBlock {
  metric: ValueMetric;
  source: CoachScopeSource;
  snapshotKey: string;
  type: string | readonly string[];
  /**
   * For a block whose types are different statistics of one thing (HRV:
   * SDNN and RMSSD). With rows of one measure the block is built as before;
   * with rows of several, the block carries one timeline per measure under
   * `byMeasure`, named by measure, instead of one daily series averaging the
   * two together (#1110: since iOS 27 one watch writes both). Same section
   * key, so every reader that asks for the section still finds it.
   */
  measures?: readonly { type: string; label: string }[];
}

const VALUE_BLOCKS: readonly ValueBlock[] = [
  {
    metric: "hrv",
    source: "hrv",
    snapshotKey: "heartRateVariability",
    type: ["HEART_RATE_VARIABILITY", "HRV_RMSSD"],
    measures: [
      { type: "HEART_RATE_VARIABILITY", label: "SDNN" },
      { type: "HRV_RMSSD", label: "RMSSD" },
    ],
  },
  {
    metric: "resting_hr",
    source: "resting_hr",
    snapshotKey: "restingHeartRate",
    type: "RESTING_HEART_RATE",
  },
  {
    metric: "walking_hr",
    source: "walking_hr",
    snapshotKey: "walkingHeartRateAverage",
    type: "WALKING_HEART_RATE_AVERAGE",
  },
  {
    metric: "respiratory_rate",
    source: "respiratory_rate",
    snapshotKey: "respiratoryRate",
    type: "RESPIRATORY_RATE",
  },
  {
    metric: "spo2",
    source: "spo2",
    snapshotKey: "oxygenSaturation",
    type: "OXYGEN_SATURATION",
  },
  {
    metric: "pulse_wave_velocity",
    source: "pulse_wave_velocity",
    snapshotKey: "pulseWaveVelocity",
    type: "PULSE_WAVE_VELOCITY",
  },
  {
    metric: "vascular_age",
    source: "vascular_age",
    snapshotKey: "vascularAge",
    type: "VASCULAR_AGE",
  },
  {
    metric: "body_fat",
    source: "body_fat",
    snapshotKey: "bodyFat",
    type: "BODY_FAT",
  },
  {
    metric: "fat_mass",
    source: "fat_mass",
    snapshotKey: "fatMass",
    type: "FAT_MASS",
  },
  {
    metric: "fat_free_mass",
    source: "fat_free_mass",
    snapshotKey: "fatFreeMass",
    type: "FAT_FREE_MASS",
  },
  {
    metric: "muscle_mass",
    source: "muscle_mass",
    snapshotKey: "muscleMass",
    type: "MUSCLE_MASS",
  },
  {
    metric: "lean_body_mass",
    source: "lean_body_mass",
    snapshotKey: "leanBodyMass",
    type: "LEAN_BODY_MASS",
  },
  {
    metric: "bone_mass",
    source: "bone_mass",
    snapshotKey: "boneMass",
    type: "BONE_MASS",
  },
  {
    metric: "total_body_water",
    source: "total_body_water",
    snapshotKey: "totalBodyWater",
    type: "TOTAL_BODY_WATER",
  },
  {
    metric: "bmi",
    source: "bmi",
    snapshotKey: "bodyMassIndex",
    type: "BODY_MASS_INDEX",
  },
  {
    metric: "visceral_fat",
    source: "visceral_fat",
    snapshotKey: "visceralFat",
    type: "VISCERAL_FAT",
  },
  {
    metric: "steps",
    source: "steps",
    snapshotKey: "steps",
    type: "ACTIVITY_STEPS",
  },
  {
    metric: "active_energy",
    source: "active_energy",
    snapshotKey: "activeEnergy",
    type: "ACTIVE_ENERGY_BURNED",
  },
  {
    metric: "flights",
    source: "flights",
    snapshotKey: "flightsClimbed",
    type: "FLIGHTS_CLIMBED",
  },
  {
    metric: "distance",
    source: "distance",
    snapshotKey: "walkingRunningDistance",
    type: "WALKING_RUNNING_DISTANCE",
  },
  {
    metric: "vo2_max",
    source: "vo2_max",
    snapshotKey: "vo2Max",
    type: "VO2_MAX",
  },
  {
    metric: "walking_steadiness",
    source: "walking_steadiness",
    snapshotKey: "walkingSteadiness",
    type: "WALKING_STEADINESS",
  },
  {
    metric: "walking_asymmetry",
    source: "walking_asymmetry",
    snapshotKey: "walkingAsymmetry",
    type: "WALKING_ASYMMETRY",
  },
  {
    metric: "walking_double_support",
    source: "walking_double_support",
    snapshotKey: "walkingDoubleSupport",
    type: "WALKING_DOUBLE_SUPPORT",
  },
  {
    metric: "walking_step_length",
    source: "walking_step_length",
    snapshotKey: "walkingStepLength",
    type: "WALKING_STEP_LENGTH",
  },
  {
    metric: "walking_speed",
    source: "walking_speed",
    snapshotKey: "walkingSpeed",
    type: "WALKING_SPEED",
  },
  {
    metric: "audio_env",
    source: "audio_env",
    snapshotKey: "audioExposureEnvironment",
    type: "AUDIO_EXPOSURE_ENV",
  },
  {
    metric: "audio_headphone",
    source: "audio_headphone",
    snapshotKey: "audioExposureHeadphone",
    type: "AUDIO_EXPOSURE_HEADPHONE",
  },
  {
    metric: "audio_event",
    source: "audio_event",
    snapshotKey: "audioExposureEvent",
    type: "AUDIO_EXPOSURE_EVENT",
  },
  {
    metric: "daylight",
    source: "daylight",
    snapshotKey: "timeInDaylight",
    type: "TIME_IN_DAYLIGHT",
  },
  {
    metric: "skin_temp",
    source: "skin_temp",
    snapshotKey: "skinTemperature",
    type: "SKIN_TEMPERATURE",
  },
  {
    metric: "body_temp",
    source: "body_temp",
    snapshotKey: "bodyTemperature",
    type: "BODY_TEMPERATURE",
  },
];

/** The sources a value-series block is built for. */
export const VALUE_SERIES_SOURCES: ReadonlySet<CoachScopeSource> = new Set(
  VALUE_BLOCKS.map((block) => block.source),
);

const TYPE_TO_REFERENCE_METRIC: Readonly<Record<string, ReferenceMetric>> = {
  RESTING_HEART_RATE: "RESTING_HEART_RATE",
  OXYGEN_SATURATION: "OXYGEN_SATURATION",
  RESPIRATORY_RATE: "RESPIRATORY_RATE",
  PULSE_WAVE_VELOCITY: "PULSE_WAVE_VELOCITY",
  BODY_TEMPERATURE: "BODY_TEMPERATURE",
  BODY_MASS_INDEX: "BMI",
  VISCERAL_FAT: "VISCERAL_FAT",
  ACTIVITY_STEPS: "STEPS",
};

interface ValueSeriesBlocksContext {
  sources: ReadonlySet<CoachScopeSource>;
  measurementRows: ReadonlyArray<{
    type: string;
    value: number;
    measuredAt: Date;
  }>;
  additiveCutoff: (source: CoachScopeSource) => Date;
  recentCutoff: Date;
  userTz: string;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  counts: NonNullable<CoachProvenance["counts"]>;
  registerBlock: RegisterBlock;
  groundingValues: Map<ReferenceMetric, number>;
  /** The reader's units; every block is stated and labelled in them. */
  units: UnitPreferences;
}

/** Unit tokens that are not a unit a reader could be quoted. */
const UNLABELLED_UNITS: ReadonlySet<string> = new Set(["", "unknown", "score"]);

export function buildValueSeriesBlocks(
  ctx: Readonly<ValueSeriesBlocksContext>,
): void {
  for (const block of VALUE_BLOCKS) {
    if (!ctx.sources.has(block.source)) continue;

    const wanted = Array.isArray(block.type) ? new Set(block.type) : null;
    const blockCutoff = ctx.additiveCutoff(block.source);
    const inWindow = ctx.measurementRows.filter(
      (row) =>
        (wanted ? wanted.has(row.type) : row.type === block.type) &&
        row.measuredAt >= blockCutoff,
    );

    if (inWindow.length === 0) {
      const cluster = sourceCluster(block.source);
      if (cluster) {
        annotate({
          action: { name: "coach.cluster.empty_skipped" },
          meta: { cluster, source: block.source },
        });
      }
      continue;
    }

    const present = block.measures?.filter((measure) =>
      inWindow.some((row) => row.type === measure.type),
    );
    if (present && present.length > 1) {
      writeMeasuresSection(ctx, block, present, inWindow);
    } else {
      writeValueSection(
        ctx,
        block,
        typeof block.type === "string" ? block.type : block.type[0]!,
        inWindow,
      );
    }
    ctx.metrics.add(block.metric);
    ctx.counts[block.metric] = inWindow.length;
  }
}

type ValueRows = ValueSeriesBlocksContext["measurementRows"];

function toPoints(rows: ValueRows) {
  return rows.map((row) => ({ measuredAt: row.measuredAt, value: row.value }));
}

function valueTimeline(
  ctx: Readonly<ValueSeriesBlocksContext>,
  rows: ReturnType<typeof toPoints>,
  transform: ReturnType<typeof getReadingTransform>,
) {
  return timelineInUnit(
    {
      recent: buildDailyValueRows(rows, ctx.recentCutoff, ctx.userTz),
      weekly: bucketWeekly(
        rows.filter((row) => row.measuredAt < ctx.recentCutoff),
        ctx.userTz,
      ),
    },
    transform,
  );
}

/**
 * Several measures of one metric, each its own timeline under `byMeasure`,
 * and each its own series should the budget pass condense the block.
 */
function writeMeasuresSection(
  ctx: Readonly<ValueSeriesBlocksContext>,
  block: ValueBlock,
  measures: readonly { type: string; label: string }[],
  inWindow: ValueRows,
): void {
  // The measures of one block share a unit (HRV: milliseconds).
  const transform = getReadingTransform(measures[0]!.type, ctx.units);
  const byMeasure: Record<string, unknown> = {};
  const pointsByMeasure = new Map<string, ReturnType<typeof toPoints>>();
  for (const measure of measures) {
    const rows = toPoints(inWindow.filter((row) => row.type === measure.type));
    pointsByMeasure.set(measure.label, rows);
    byMeasure[measure.label] = valueTimeline(ctx, rows, transform);
  }
  ctx.snapshot[block.snapshotKey] = {
    ...(UNLABELLED_UNITS.has(transform.displayUnit)
      ? {}
      : { unit: transform.displayUnit }),
    byMeasure,
  };
  ctx.registerBlock(block.snapshotKey, block.source, () =>
    Object.fromEntries(
      [...pointsByMeasure].map(([label, rows]) => [
        label,
        dailyPoints(rows, ctx.userTz, undefined, transform),
      ]),
    ),
  );
}

function writeValueSection(
  ctx: Readonly<ValueSeriesBlocksContext>,
  block: ValueBlock,
  unitType: string,
  sourceRows: ValueRows,
): void {
  const rows = toPoints(sourceRows);
  const recentRows = buildDailyValueRows(rows, ctx.recentCutoff, ctx.userTz);
  // Aggregated on the canonical value (the grounding below reads that),
  // stated in the reader's unit.
  const transform = getReadingTransform(unitType, ctx.units);
  ctx.snapshot[block.snapshotKey] = {
    ...(UNLABELLED_UNITS.has(transform.displayUnit)
      ? {}
      : { unit: transform.displayUnit }),
    timeline: timelineInUnit(
      {
        recent: recentRows,
        weekly: bucketWeekly(
          rows.filter((row) => row.measuredAt < ctx.recentCutoff),
          ctx.userTz,
        ),
      },
      transform,
    ),
  };
  ctx.registerBlock(block.snapshotKey, block.source, () => ({
    value: dailyPoints(rows, ctx.userTz, undefined, transform),
  }));

  const referenceMetric =
    typeof block.type === "string"
      ? TYPE_TO_REFERENCE_METRIC[block.type]
      : undefined;
  if (referenceMetric && recentRows.length > 0) {
    const values = recentRows.slice(-14);
    const mean =
      values.reduce((sum, row) => sum + row.value, 0) / values.length;
    ctx.groundingValues.set(referenceMetric, mean);
  }
}
