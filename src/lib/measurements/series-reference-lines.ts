/**
 * Horizontal reference lines for a measurement chart (v1.43, ios #116 item 4).
 *
 * The native client drew fixed threshold lines (blood pressure 140/60, pulse
 * 100/60, glucose 70/180 mg/dL, fever 37.5, SpO2 95) that knew neither the
 * series' unit nor the person's targets, and removed them. The server knows
 * both, so it resolves the lines here and `GET /api/measurements/series`
 * serves them in the unit of its own points.
 *
 * Two sources, one rule: a personal line (the person's own target from
 * `/targets`, else the profile default the target cards use: the age-based
 * blood pressure band, the age- and sex-based resting pulse band, the
 * sex-based body fat band) replaces the clinical line for the same edge.
 * The clinical lines are the ones a guideline names:
 *
 *   - blood pressure 140 / 90 mmHg, the ESH 2023 hypertension threshold;
 *   - glucose 70 and 180 mg/dL, the CGM time-in-range band (ATTD consensus,
 *     Battelino et al. 2019), converted for an mmol/L account;
 *   - SpO2 lower edge 92 %, the red-flag floor in `clinical-floors.ts`.
 *
 * Without either, the list is empty: nothing to draw is an answer, not an
 * error.
 */
import type {
  ThresholdMetric,
  UserProfileForRange,
} from "@/lib/analytics/effective-range";
import { TIME_IN_RANGE_MGDL } from "@/lib/analytics/glucose-metrics";
import { SPO2_RED_FLAG_PCT } from "@/lib/clinical-floors";
import { convertGlucose, type GlucoseUnit } from "@/lib/glucose";
import { REFERENCE_RANGES } from "@/lib/reference-ranges";
import { resolvePersonalBand } from "@/lib/targets/trend-verdict";

export type SeriesKind =
  | "weight"
  | "bloodPressure"
  | "pulse"
  | "bodyFat"
  | "glucose"
  | "sleep"
  | "steps"
  | "totalBodyWater"
  | "boneMass"
  | "oxygenSaturation"
  | "restingHeartRate"
  | "heartRateVariability"
  | "vo2Max"
  | "ketones"
  | "glucoseKetoneIndex";

export interface SeriesReferenceLine {
  value: number;
  kind: "lower" | "upper";
  source: "personal" | "clinical";
  /** `secondary` is the diastolic line of a blood pressure chart. */
  appliesTo: "value" | "secondary";
  labelKey: string;
  label: string;
}

export interface SeriesReferenceContext {
  /** The profile of the record on screen. */
  profile: UserProfileForRange;
  thresholdsJson: unknown;
  glucoseUnit: GlucoseUnit;
  /** Server translator in the account's language. */
  t: (key: string) => string;
}

/** The ESH 2023 hypertension threshold, systolic from the shipped bands. */
const ESH_HYPERTENSION_SYS =
  REFERENCE_RANGES.BLOOD_PRESSURE.bands.find((b) => b.label === "Hypertension")
    ?.low ?? 140;
/** Its diastolic counterpart (ESH 2023 grade 1 starts at 140 / 90). */
const ESH_HYPERTENSION_DIA = 90;

/** Which `/targets` threshold a kind's personal lines come from. */
const PERSONAL_METRIC: Partial<Record<SeriesKind, ThresholdMetric>> = {
  weight: "WEIGHT",
  bodyFat: "BODY_FAT",
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  totalBodyWater: "TOTAL_BODY_WATER",
  boneMass: "BONE_MASS",
  oxygenSaturation: "OXYGEN_SATURATION",
  // A resting band on the resting chart only: raw heart rate includes every
  // workout, where the resting band says nothing.
  restingHeartRate: "PULSE",
};

function personalBand(
  metric: ThresholdMetric,
  ctx: SeriesReferenceContext,
): { min: number; max: number } | null {
  return (
    resolvePersonalBand(metric, ctx.profile, ctx.thresholdsJson)?.band ?? null
  );
}

function line(
  ctx: SeriesReferenceContext,
  value: number,
  kind: "lower" | "upper",
  source: "personal" | "clinical",
  appliesTo: "value" | "secondary",
): SeriesReferenceLine {
  const labelKey =
    source === "personal"
      ? kind === "upper"
        ? "series.reference.targetUpper"
        : "series.reference.targetLower"
      : kind === "upper"
        ? "series.reference.clinicalUpper"
        : "series.reference.clinicalLower";
  return { value, kind, source, appliesTo, labelKey, label: ctx.t(labelKey) };
}

/** Both edges of a personal band. */
function bandLines(
  ctx: SeriesReferenceContext,
  band: { min: number; max: number },
  appliesTo: "value" | "secondary",
): SeriesReferenceLine[] {
  return [
    line(ctx, band.min, "lower", "personal", appliesTo),
    line(ctx, band.max, "upper", "personal", appliesTo),
  ];
}

export function resolveSeriesReferenceLines(
  kind: SeriesKind,
  ctx: SeriesReferenceContext,
): SeriesReferenceLine[] {
  switch (kind) {
    case "bloodPressure": {
      const sys = personalBand("BLOOD_PRESSURE_SYS", ctx);
      const dia = personalBand("BLOOD_PRESSURE_DIA", ctx);
      return [
        ...(sys
          ? bandLines(ctx, sys, "value")
          : [line(ctx, ESH_HYPERTENSION_SYS, "upper", "clinical", "value")]),
        ...(dia
          ? bandLines(ctx, dia, "secondary")
          : [
              line(ctx, ESH_HYPERTENSION_DIA, "upper", "clinical", "secondary"),
            ]),
      ];
    }
    case "glucose":
      // The series mixes every meal context, so no single context's target
      // is the person's line here; the time-in-range band is.
      return [
        line(
          ctx,
          convertGlucose(TIME_IN_RANGE_MGDL.low, ctx.glucoseUnit),
          "lower",
          "clinical",
          "value",
        ),
        line(
          ctx,
          convertGlucose(TIME_IN_RANGE_MGDL.high, ctx.glucoseUnit),
          "upper",
          "clinical",
          "value",
        ),
      ];
    case "oxygenSaturation": {
      const own = personalBand("OXYGEN_SATURATION", ctx);
      if (own) return bandLines(ctx, own, "value");
      return [line(ctx, SPO2_RED_FLAG_PCT, "lower", "clinical", "value")];
    }
    default: {
      const metric = PERSONAL_METRIC[kind];
      if (!metric) return [];
      const band = personalBand(metric, ctx);
      return band ? bandLines(ctx, band, "value") : [];
    }
  }
}
