/**
 * The aggregated feature set as a model reads it: every quantity whose unit
 * depends on a preference converted into the reader's units, and labelled.
 *
 * `extractFeatures` computes in canonical units (kilograms, centimetres,
 * metres, mg/dL) because the classifications, the correlations and the
 * cached feature set are shared by every surface. The briefing and the
 * Coach then serialised that canonical set straight into their prompts, so a
 * reader on pounds or mmol/L got a narrative in kilograms or mg/dL. This is
 * the one step between the two: it runs after all canonical arithmetic and
 * before the snapshot is hashed, serialised and checked for grounding, so
 * the hash moves with a unit switch and the grounding check compares the
 * model's numbers against the same figures the model was shown.
 *
 * Absolute values take the full transform, differences and slopes the
 * factor alone. A metric reader on mg/dL gets every number back unchanged,
 * with a unit label added.
 */
import {
  roundToDisplay,
  vitalDisplayDecimals,
} from "@/lib/measurements/vital-precision";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getQuantityTransform,
  getReadingTransform,
  type DisplayTransform,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import { buildWeightTargetFeature } from "@/lib/targets/weight-trend";

import type {
  AggregatedFeatures,
  BucketedSeries,
  RawFeatures,
} from "./features";
import type { SignalOfDay } from "./signals-of-day";

type Num = number | null;

function abs(value: Num, transform: DisplayTransform): Num {
  return typeof value === "number"
    ? applyDisplayTransform(value, transform)
    : value;
}

function delta(value: Num, transform: DisplayTransform): Num {
  return typeof value === "number"
    ? applyDisplayTransformDelta(value, transform)
    : value;
}

/** The measurement type each signal of the day is read from. */
const SIGNAL_TYPE: Partial<Record<SignalOfDay["metric"], string>> = {
  weight: "WEIGHT",
  glucose: "BLOOD_GLUCOSE",
};

/** One signal of the day in the reader's units. */
export function signalInReaderUnits(
  signal: SignalOfDay,
  units: UnitPreferences,
): SignalOfDay {
  const type = SIGNAL_TYPE[signal.metric];
  if (!type) return signal;
  const t = getReadingTransform(type, units);
  // A signal is a statement the model repeats to the reader, so its figures
  // carry the precision the reading is shown at. The metric branch of a
  // transform is the identity and does not round, which handed the model
  // "+0.37 kg" to restate.
  const decimals = vitalDisplayDecimals(type, t.decimals);
  const round = (value: Num): Num =>
    typeof value === "number" ? roundToDisplay(value, decimals) : value;
  return {
    ...signal,
    unit: t.displayUnit,
    latest: roundToDisplay(applyDisplayTransform(signal.latest, t), decimals),
    avg7: round(abs(signal.avg7, t)),
    avg30: round(abs(signal.avg30, t)),
    deltaVs7: round(delta(signal.deltaVs7, t)),
    deltaVs30: round(delta(signal.deltaVs30, t)),
    spread30: round(delta(signal.spread30, t)),
    recentAnomaly: signal.recentAnomaly
      ? {
          ...signal.recentAnomaly,
          value: roundToDisplay(
            applyDisplayTransform(signal.recentAnomaly.value, t),
            decimals,
          ),
        }
      : null,
  };
}

/** The weight aggregate in the reader's units, its target included. */
export function weightFeatureInReaderUnits(
  weight: NonNullable<AggregatedFeatures["weight"]>,
  units: UnitPreferences,
): NonNullable<AggregatedFeatures["weight"]> & { unit: string } {
  const t = getReadingTransform("WEIGHT", units);
  // The target is rebuilt from the canonical band and the canonical trend
  // reference, so its position is judged exactly as before and only the
  // band it quotes changes unit.
  const target = weight.target
    ? (buildWeightTargetFeature(
        { min: weight.target.min, max: weight.target.max },
        { avg7: weight.avg7, latest: weight.latest },
        units.system,
      ) ?? undefined)
    : undefined;
  return {
    ...weight,
    unit: t.displayUnit,
    latest: applyDisplayTransform(weight.latest, t),
    avg7: abs(weight.avg7, t),
    avg30: abs(weight.avg30, t),
    avg90: abs(weight.avg90, t),
    allTimeAvg: abs(weight.allTimeAvg, t),
    allTimeMin: abs(weight.allTimeMin, t),
    allTimeMax: abs(weight.allTimeMax, t),
    slope30: delta(weight.slope30, t),
    ...(target ? { target } : {}),
  };
}

function bucketedInReaderUnits(
  series: BucketedSeries,
  units: UnitPreferences,
): BucketedSeries & { unit: string } {
  const t = getReadingTransform(series.type, units);
  return {
    ...series,
    unit: t.displayUnit,
    buckets: series.buckets.map((bucket) => ({
      ...bucket,
      mean: applyDisplayTransform(bucket.mean, t),
    })),
  };
}

/**
 * The whole feature set in the reader's units. Pure: returns a new object
 * and leaves the (possibly cached and shared) input untouched.
 */
export function featuresInReaderUnits<
  T extends AggregatedFeatures | RawFeatures,
>(features: T, units: UnitPreferences): T {
  const out: AggregatedFeatures & Partial<RawFeatures> = { ...features };

  if (features.weight) {
    out.weight = weightFeatureInReaderUnits(features.weight, units);
  }

  if (features.gripStrength) {
    const t = getReadingTransform("GRIP_STRENGTH", units);
    out.gripStrength = {
      ...features.gripStrength,
      latest: abs(features.gripStrength.latest, t),
      avg30: abs(features.gripStrength.avg30, t),
      slope30: delta(features.gripStrength.slope30, t),
      unit: t.displayUnit,
    } as AggregatedFeatures["gripStrength"];
  }

  if (features.waist) {
    const t = getReadingTransform("WAIST_CIRCUMFERENCE", units);
    out.waist = {
      ...features.waist,
      latest: abs(features.waist.latest, t),
      avg30: abs(features.waist.avg30, t),
      slope30: delta(features.waist.slope30, t),
      unit: t.displayUnit,
    } as AggregatedFeatures["waist"];
  }

  if (features.glucose) {
    const t = getReadingTransform("BLOOD_GLUCOSE", units);
    out.glucose = {
      ...features.glucose,
      avg7: abs(features.glucose.avg7, t),
      avg30: abs(features.glucose.avg30, t),
      avg90: abs(features.glucose.avg90, t),
      latest: abs(features.glucose.latest, t),
      slope30: delta(features.glucose.slope30, t),
      unit: t.displayUnit,
    } as AggregatedFeatures["glucose"];
  }

  const weightHistory = features.historicalComparison?.weight;
  if (features.historicalComparison && weightHistory) {
    const t = getReadingTransform("WEIGHT", units);
    out.historicalComparison = {
      ...features.historicalComparison,
      weight: {
        current7dAvg: abs(weightHistory.current7dAvg, t),
        previous30dAvg: abs(weightHistory.previous30dAvg, t),
        change: delta(weightHistory.change, t),
        unit: t.displayUnit,
      } as NonNullable<AggregatedFeatures["historicalComparison"]>["weight"],
    };
  }

  if (features.signalsOfDay) {
    out.signalsOfDay = features.signalsOfDay.map((signal) =>
      signalInReaderUnits(signal, units),
    );
  }

  if (features.workouts) {
    const t = getQuantityTransform("distance", units.system);
    // The block is computed in kilometres; the transform takes metres. The
    // keys lose their "Km" so a mile figure never sits under a kilometre
    // name.
    const distance = (value: Num) =>
      abs(typeof value === "number" ? value * 1000 : value, t);
    const { last7, last30, latest } = features.workouts;
    const period = ({ totalDistanceKm, ...rest }: typeof last7) => ({
      ...rest,
      totalDistance: distance(totalDistanceKm),
    });
    out.workouts = {
      last7: period(last7),
      last30: period(last30),
      latest: latest
        ? (({ distanceKm, ...rest }) => ({
            ...rest,
            distance: distance(distanceKm),
          }))(latest)
        : latest,
      distanceUnit: t.displayUnit,
    } as unknown as AggregatedFeatures["workouts"];
  }

  if ("bucketedMeasurements" in features) {
    out.bucketedMeasurements = features.bucketedMeasurements.map((series) =>
      bucketedInReaderUnits(series, units),
    );
  }

  return out as T;
}
