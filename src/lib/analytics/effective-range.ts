/**
 * Effective-range resolver — the single entry point for "what's the target
 * range for THIS user on THIS metric, right now?"
 *
 * Layering:
 *   1. Evidence-based default computed from the user profile (age/height/
 *      gender/gender-neutral) via the existing analytics helpers.
 *   2. Optional user override stored in User.thresholdsJson.
 *   3. For blood glucose the range also depends on the measurement context
 *      (fasting / postprandial / random / bedtime).
 *
 * Every consumer — /targets page, insight status prompts, doctor-report PDF,
 * chart value-bands — should call `getEffectiveRange()` instead of the raw
 * default computers directly. That way a user-override affects every surface
 * consistently.
 */

import { getBpTargets } from "./bp-targets";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "./pulse-targets";
import {
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
  type TrafficRange,
} from "./value-bands";

export type ThresholdMetric =
  | "WEIGHT"
  | "BLOOD_PRESSURE_SYS"
  | "BLOOD_PRESSURE_DIA"
  | "PULSE"
  | "BODY_FAT"
  | "SLEEP_DURATION"
  | "ACTIVITY_STEPS"
  | "BLOOD_GLUCOSE_FASTING"
  | "BLOOD_GLUCOSE_POSTPRANDIAL"
  | "BLOOD_GLUCOSE_RANDOM"
  | "BLOOD_GLUCOSE_BEDTIME"
  | "TOTAL_BODY_WATER"
  | "BONE_MASS"
  | "OXYGEN_SATURATION";

export interface ThresholdOverride {
  min: number;
  max: number;
  /** Set true when the value was entered by the user (not the computed default). */
  isOverride?: boolean;
}

/**
 * Shape persisted in User.thresholdsJson. Any metric missing = use default.
 */
export type ThresholdOverridesJson = Partial<
  Record<ThresholdMetric, { min: number; max: number }>
>;

export interface UserProfileForRange {
  heightCm: number | null;
  dateOfBirth: Date | string | null;
  gender: string | null;
}

/**
 * Per-metric guardrails used both for validation (Zod) and for "is this
 * unhealthy to override" warnings in the UI. Min/max here are the outer
 * physiological bounds, not defaults.
 */
export const METRIC_BOUNDS: Record<
  ThresholdMetric,
  { min: number; max: number; unit: string }
> = {
  WEIGHT: { min: 30, max: 300, unit: "kg" },
  BLOOD_PRESSURE_SYS: { min: 80, max: 220, unit: "mmHg" },
  BLOOD_PRESSURE_DIA: { min: 40, max: 140, unit: "mmHg" },
  PULSE: { min: 30, max: 220, unit: "bpm" },
  BODY_FAT: { min: 3, max: 60, unit: "%" },
  SLEEP_DURATION: { min: 3, max: 14, unit: "h" },
  ACTIVITY_STEPS: { min: 0, max: 50_000, unit: "steps" },
  BLOOD_GLUCOSE_FASTING: { min: 40, max: 400, unit: "mg/dL" },
  BLOOD_GLUCOSE_POSTPRANDIAL: { min: 40, max: 500, unit: "mg/dL" },
  BLOOD_GLUCOSE_RANDOM: { min: 40, max: 500, unit: "mg/dL" },
  BLOOD_GLUCOSE_BEDTIME: { min: 40, max: 400, unit: "mg/dL" },
  // Body composition (Withings type 77 / 88, stored canonically in kg).
  // Bounds match VALUE_RANGES in src/lib/validations/measurement.ts.
  TOTAL_BODY_WATER: { min: 5, max: 100, unit: "kg" },
  BONE_MASS: { min: 0.5, max: 8, unit: "kg" },
  // Pulse oximetry (Withings ScanWatch reports type 54). Plausibility floor
  // 50% to allow truly critical readings to be logged; saturation cannot
  // exceed 100% by physical definition.
  OXYGEN_SATURATION: { min: 50, max: 100, unit: "%" },
};

/**
 * Blood-glucose defaults follow the ADA Standards of Care (2024) combined
 * with DGIM/DDG S3 guidelines. Values are in mg/dL — the canonical storage
 * unit. Display conversion to mmol/L happens at render time.
 */
const GLUCOSE_DEFAULTS: Record<
  "FASTING" | "POSTPRANDIAL" | "RANDOM" | "BEDTIME",
  { min: number; max: number }
> = {
  FASTING: { min: 70, max: 99 },
  POSTPRANDIAL: { min: 70, max: 140 },
  RANDOM: { min: 70, max: 140 },
  BEDTIME: { min: 90, max: 150 },
};

function normalizedGender(value: string | null): "MALE" | "FEMALE" | null {
  if (value === "MALE" || value === "FEMALE") return value;
  return null;
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function defaultRange(
  metric: ThresholdMetric,
  profile: UserProfileForRange,
): TrafficRange | null {
  const age = getAgeFromDateOfBirth(profile.dateOfBirth ?? null);
  const gender = normalizedGender(profile.gender ?? null);
  const dateOfBirth = toDate(profile.dateOfBirth);

  switch (metric) {
    case "WEIGHT":
      return profile.heightCm
        ? buildWeightRangeFromHeight(profile.heightCm)
        : null;
    case "BLOOD_PRESSURE_SYS": {
      if (!dateOfBirth) return null;
      const t = getBpTargets(dateOfBirth);
      if (!t) return null;
      return {
        greenMin: t.sysLow,
        greenMax: t.sysHigh,
        orangeMin: t.sysLow - 10,
        orangeMax: t.sysHigh + 20,
      };
    }
    case "BLOOD_PRESSURE_DIA": {
      if (!dateOfBirth) return null;
      const t = getBpTargets(dateOfBirth);
      if (!t) return null;
      return {
        greenMin: t.diaLow,
        greenMax: t.diaHigh,
        orangeMin: t.diaLow - 10,
        orangeMax: t.diaHigh + 10,
      };
    }
    case "PULSE": {
      const p = getPersonalizedPulseTarget(age, gender);
      return {
        greenMin: p.greenMin,
        greenMax: p.greenMax,
        orangeMin: p.orangeMin,
        orangeMax: p.orangeMax,
      };
    }
    case "BODY_FAT": {
      const r = getBodyFatTargetRange(gender);
      return {
        greenMin: r.min,
        greenMax: r.max,
        orangeMin: Math.max(0, r.min - 3),
        orangeMax: r.max + 5,
      };
    }
    case "SLEEP_DURATION":
      // AASM: 7–9h for adults; warning yellow either side.
      return { greenMin: 7, greenMax: 9, orangeMin: 6, orangeMax: 10 };
    case "ACTIVITY_STEPS":
      // ≥8000 steps/day per Saint-Maurice et al., JAMA 2020 (mortality
      // plateau 8000–12000 steps). WHO 2020 PA guidelines publish minutes
      // per week (150–300 min moderate / 75–150 min vigorous) — *not* a
      // step quota. No upper bound in reality, orange over 25k caps edge
      // detection.
      return { greenMin: 8000, greenMax: 15000, orangeMin: 5000, orangeMax: 25000 };
    case "BLOOD_GLUCOSE_FASTING":
      return glucoseRange(GLUCOSE_DEFAULTS.FASTING, 125); // pre-diabetes upper bound
    case "BLOOD_GLUCOSE_POSTPRANDIAL":
      return glucoseRange(GLUCOSE_DEFAULTS.POSTPRANDIAL, 199); // impaired glucose tolerance upper
    case "BLOOD_GLUCOSE_RANDOM":
      return glucoseRange(GLUCOSE_DEFAULTS.RANDOM, 199);
    case "BLOOD_GLUCOSE_BEDTIME":
      return glucoseRange(
        GLUCOSE_DEFAULTS.BEDTIME,
        GLUCOSE_DEFAULTS.BEDTIME.max + 30,
      );
    case "TOTAL_BODY_WATER":
      // Adult total body water typically ~50% of body weight in kg
      // (Watson formula / ICRP Reference Man: ~42 L male, ~30 L female).
      // Without per-user weight context the gender-neutral band is wide
      // by design; users tighten via threshold override.
      return { greenMin: 28, greenMax: 50, orangeMin: 22, orangeMax: 55 };
    case "BONE_MASS":
      // Bioimpedance-estimated bone mass from a Withings-class scale —
      // NOT DEXA-comparable (BIA-derived values typically run 5–7% below
      // DEXA bone-mineral-content). Adult BIA-typical 2.0–4.0 kg (women
      // slightly lower than men). Wide orange band before surfacing as a
      // concern given BIA's intrinsic noise.
      return { greenMin: 2.0, greenMax: 4.0, orangeMin: 1.5, orangeMax: 5.0 };
    case "OXYGEN_SATURATION":
      // Conservative band aligned with consumer pulse-oximeter consensus
      // (≥95% normal at rest); slightly tighter than the BTS Emergency
      // Oxygen Guideline 2017 explicit treatment target of 94–98%, looser
      // than the WHO ≥90% acute-care floor. Lower-only concern: ≤92% is
      // the NICE NG115 escalation threshold ("call provider"); ≤88%
      // (BMJ panel / FDA pulse-oximeter labelling) is the ER threshold.
      // Saturation is bounded above by 100% physically, so we collapse
      // the upper orange wing onto greenMax — severity logic only fires
      // for hypoxemia.
      // COPD / chronic-respiratory-failure / high-altitude users
      // typically run 88–92% and should personalise via the
      // threshold-override UI (saved in User.thresholdsJson).
      return { greenMin: 95, greenMax: 100, orangeMin: 92, orangeMax: 100 };
  }
}

function glucoseRange(
  d: { min: number; max: number },
  orangeMax: number,
): TrafficRange {
  return {
    greenMin: d.min,
    greenMax: d.max,
    orangeMin: d.min - 10,
    orangeMax,
  };
}

export interface EffectiveRange {
  /** Resolved range — override if set, else computed default. */
  range: TrafficRange | null;
  /** True when the user has overridden this metric. */
  isOverride: boolean;
  /** The unmodified computed default (useful for diff display). */
  default: TrafficRange | null;
  /** Metric-specific physiological bounds for validation hints. */
  bounds: { min: number; max: number; unit: string };
}

/**
 * Resolve the effective range for a single metric for a user.
 *
 * `overrides` is the parsed User.thresholdsJson value (may be null).
 */
export function getEffectiveRange(
  metric: ThresholdMetric,
  profile: UserProfileForRange,
  overrides: ThresholdOverridesJson | null | undefined,
): EffectiveRange {
  const fallback = defaultRange(metric, profile);
  const override = overrides?.[metric];
  const bounds = METRIC_BOUNDS[metric];

  if (!override) {
    return { range: fallback, isOverride: false, default: fallback, bounds };
  }

  // User override replaces the green band. Orange wings stretch 15% below/above,
  // clamped to the metric's physiological bounds — without the clamp, an
  // override like SpO2 {95,100} would emit orangeMax = 100.75 (impossible
  // saturation) and BODY_FAT {2,80} would emit orangeMin = -9.7.
  const span = Math.max(1, override.max - override.min);
  const orangeWidth = span * 0.15;

  return {
    range: {
      greenMin: override.min,
      greenMax: override.max,
      orangeMin: Math.max(bounds.min, override.min - orangeWidth),
      orangeMax: Math.min(bounds.max, override.max + orangeWidth),
    },
    isOverride: true,
    default: fallback,
    bounds,
  };
}

/**
 * Convenience: resolve every supported metric at once. Useful for /targets
 * and the insight generator.
 */
export function getAllEffectiveRanges(
  profile: UserProfileForRange,
  overrides: ThresholdOverridesJson | null | undefined,
): Record<ThresholdMetric, EffectiveRange> {
  const metrics = Object.keys(METRIC_BOUNDS) as ThresholdMetric[];
  return Object.fromEntries(
    metrics.map((m) => [m, getEffectiveRange(m, profile, overrides)]),
  ) as Record<ThresholdMetric, EffectiveRange>;
}
