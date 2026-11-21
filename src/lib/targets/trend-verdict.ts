/**
 * Which way a change of a metric counts as progress, for this person (v1.43,
 * ios #116 item 3). The generalisation of `resolveWeightTrend`.
 *
 * Every surface that shows a change (a dashboard arrow, a seven-day delta, a
 * target tile, a chart's first-to-last change) used to carry its own fixed
 * polarity: a rising blood pressure turned orange whatever the person's
 * target was, and the native client kept a third copy of the table. The
 * verdict is resolved here, once, and published on every route that serves a
 * change; clients colour from it and never decide it themselves.
 *
 * The rule:
 *
 *   - a band applies (the person's own target from `/targets`, else a
 *     profile-derived default: the age-based blood pressure target, the
 *     age- and sex-based resting pulse band, the sex-based body fat band):
 *       below the band  → a rise is progress   (`up-good`)
 *       above the band  → a fall is progress   (`up-bad`)
 *       inside the band → holding is progress  (`hold`)
 *   - two exceptions to "below / above":
 *       a low reading of a load measure (blood pressure, resting pulse, body
 *       fat) against a band nobody chose is `hold`, not `up-good`. A
 *       default band's lower edge is a population convention, not a goal:
 *       a well-trained resting pulse of 48 or a systolic of 108 is not
 *       something to climb out of, and painting its fall orange would tell
 *       the person to raise it. Only a target the person set themselves
 *       turns "below" into "a rise is progress".
 *       a one-sided measure (steps, oxygen saturation) above its band is
 *       `hold`, never `up-bad`: more steps than the target, or a saturation
 *       above it, is never a setback.
 *   - no band, or no value to place: the metric's own default direction.
 *
 * Weight keeps its own rule (`weight-trend.ts`): only a target the person set
 * counts, never the height-derived band, because a band nobody chose says
 * nothing about which way they want to move.
 *
 * Pure and client-safe: no DB read, no clock beyond the age the profile
 * helpers compute.
 */
import {
  getEffectiveRange,
  resolveThresholdOverride,
  resolveWeightTargetOverride,
  type ThresholdMetric,
  profileTimezone,
  type UserProfileForRange,
} from "@/lib/analytics/effective-range";
import {
  getTrendSentiment,
  type TrendDirectionSentiment,
  type TrendSentimentDirection,
} from "@/lib/insights/trend-sentiment";
import { binaryReferenceSex } from "@/lib/profile/sex";
import { ageInYears } from "@/lib/tz/date-only";

import { resolveWeightTrend } from "./weight-trend";

export type TrendTargetPosition = "below" | "inside" | "above";
export type TrendVerdictBasis =
  "personal_target" | "profile_default" | "metric_default";

export interface TrendVerdict {
  direction: TrendDirectionSentiment;
  targetPosition: TrendTargetPosition | null;
  basis: TrendVerdictBasis;
}

export type TrendSentiment = TrendSentimentDirection;

/**
 * What a verdict can be asked for: a measurement type, or one of the derived
 * keys a target tile or dashboard card carries (`BLOOD_PRESSURE` is the
 * systolic side of the pair, `BMI` follows weight, `MOOD` / `MOOD_SCORE` the
 * mood mean, `BLOOD_PRESSURE_IN_TARGET` and `MEDICATION_COMPLIANCE` a share).
 */
export type TrendVerdictKey = string;

/**
 * The metric's own direction when no band applies. A rise is progress for the
 * capacity and activity measures, a setback for the load measures, and
 * carries no judgement for everything else (body water, bone mass, breathing
 * rate, skin temperature, intake, …).
 */
const METRIC_DEFAULT_DIRECTION: Readonly<
  Record<string, Exclude<TrendDirectionSentiment, "hold">>
> = {
  ACTIVITY_STEPS: "up-good",
  HEART_RATE_VARIABILITY: "up-good",
  HRV_RMSSD: "up-good",
  VO2_MAX: "up-good",
  OXYGEN_SATURATION: "up-good",
  MUSCLE_MASS: "up-good",
  SLEEP_DURATION: "up-good",
  SIX_MINUTE_WALK_DISTANCE: "up-good",
  GRIP_STRENGTH: "up-good",
  MOOD: "up-good",
  MOOD_SCORE: "up-good",
  BLOOD_PRESSURE_IN_TARGET: "up-good",
  MEDICATION_COMPLIANCE: "up-good",
  RESTING_HEART_RATE: "up-bad",
  PULSE: "up-bad",
  BODY_FAT: "up-bad",
  BLOOD_PRESSURE: "up-bad",
  BLOOD_PRESSURE_SYS: "up-bad",
  BLOOD_PRESSURE_DIA: "up-bad",
  BODY_TEMPERATURE: "up-bad",
  BLOOD_GLUCOSE: "up-bad",
};

/** The `/targets` threshold a key is judged against, when it has one. */
const THRESHOLD_FOR_KEY: Readonly<Record<string, ThresholdMetric>> = {
  BLOOD_PRESSURE: "BLOOD_PRESSURE_SYS",
  BLOOD_PRESSURE_SYS: "BLOOD_PRESSURE_SYS",
  BLOOD_PRESSURE_DIA: "BLOOD_PRESSURE_DIA",
  // The resting pulse card and the dashboard pulse tile share one target.
  PULSE: "PULSE",
  RESTING_HEART_RATE: "PULSE",
  BODY_FAT: "BODY_FAT",
  SLEEP_DURATION: "SLEEP_DURATION",
  ACTIVITY_STEPS: "ACTIVITY_STEPS",
  TOTAL_BODY_WATER: "TOTAL_BODY_WATER",
  BONE_MASS: "BONE_MASS",
  OXYGEN_SATURATION: "OXYGEN_SATURATION",
};

/**
 * Stored values the threshold is not written in. Sleep is stored in minutes
 * and targeted in hours; every other threshold shares the stored unit.
 */
const TO_THRESHOLD_UNIT: Readonly<Record<string, (value: number) => number>> = {
  SLEEP_DURATION: (minutes) => minutes / 60,
};

export interface TrendVerdictContext {
  /** The profile of the RECORD on screen, not of the viewer. */
  profile: UserProfileForRange;
  /** `User.thresholdsJson` of the same record, unparsed. */
  thresholdsJson: unknown;
  /**
   * The value placed against the band, in the stored (canonical) unit of the
   * key: usually the seven-day average, else the latest reading. Null when
   * there is nothing to place, which leaves the metric's default.
   */
  referenceValue: number | null;
}

/**
 * Whether the profile carries what the default band of this metric is
 * personalised from. Without it the band is the same for everyone, which is a
 * metric default and not a statement about this person.
 */
function hasProfileDefault(
  metric: ThresholdMetric,
  profile: UserProfileForRange,
): boolean {
  switch (metric) {
    case "BLOOD_PRESSURE_SYS":
    case "BLOOD_PRESSURE_DIA":
      return profile.dateOfBirth != null;
    case "PULSE": {
      const age = ageInYears(profile.dateOfBirth, profileTimezone(profile));
      return age != null && age >= 20;
    }
    case "BODY_FAT":
      return binaryReferenceSex(profile.gender) !== null;
    default:
      return false;
  }
}

/**
 * The band a person's values are judged against: their own target, else the
 * profile default when the profile carries what it is personalised from.
 * Null when neither applies. Shared with the chart reference lines, so the
 * line drawn and the verdict coloured come from the same band.
 */
export function resolvePersonalBand(
  metric: ThresholdMetric,
  profile: UserProfileForRange,
  thresholdsJson: unknown,
): {
  band: { min: number; max: number };
  basis: Exclude<TrendVerdictBasis, "metric_default">;
} | null {
  const own = resolveThresholdOverride(thresholdsJson, metric);
  if (own) return { band: own, basis: "personal_target" };
  if (!hasProfileDefault(metric, profile)) return null;
  const range = getEffectiveRange(metric, profile, null).range;
  return range
    ? {
        band: { min: range.greenMin, max: range.greenMax },
        basis: "profile_default",
      }
    : null;
}

function metricDefault(key: string): TrendVerdict {
  return {
    direction: METRIC_DEFAULT_DIRECTION[key] ?? "neutral",
    targetPosition: null,
    basis: "metric_default",
  };
}

/** Place a value against a band; the edges count as inside. */
export function placeAgainstBand(
  band: { min: number; max: number },
  value: number,
): TrendTargetPosition {
  if (value < band.min) return "below";
  if (value > band.max) return "above";
  return "inside";
}

/**
 * Load measures whose default band's lower edge is no goal (see the module
 * comment): below a profile-default band they hold rather than climb.
 */
const LOW_IS_NOT_A_SETBACK: ReadonlySet<ThresholdMetric> = new Set([
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
]);

/** Measures where more is never worse: above the band they hold. */
const ONE_SIDED_UPWARD: ReadonlySet<ThresholdMetric> = new Set([
  "ACTIVITY_STEPS",
  "OXYGEN_SATURATION",
]);

function directionFor(
  metric: ThresholdMetric,
  position: TrendTargetPosition,
  basis: Exclude<TrendVerdictBasis, "metric_default">,
): TrendDirectionSentiment {
  if (
    position === "below" &&
    basis === "profile_default" &&
    LOW_IS_NOT_A_SETBACK.has(metric)
  ) {
    return "hold";
  }
  if (position === "above" && ONE_SIDED_UPWARD.has(metric)) return "hold";
  return DIRECTION_BY_POSITION[position];
}

const DIRECTION_BY_POSITION: Record<
  TrendTargetPosition,
  TrendDirectionSentiment
> = {
  below: "up-good",
  above: "up-bad",
  inside: "hold",
};

export function resolveTrendVerdict(
  key: TrendVerdictKey,
  ctx: TrendVerdictContext,
): TrendVerdict {
  const reference =
    ctx.referenceValue !== null && Number.isFinite(ctx.referenceValue)
      ? ctx.referenceValue
      : null;

  // Weight, and BMI which moves exactly when weight does: only the person's
  // own target counts (see the module comment). For `BMI` the reference is
  // the WEIGHT it is derived from, in kg, since the target is a weight.
  if (key === "WEIGHT" || key === "BMI") {
    const target = resolveWeightTargetOverride(ctx.thresholdsJson);
    const judgement = resolveWeightTrend(target, reference);
    return {
      direction: judgement.direction,
      targetPosition: judgement.targetPosition,
      basis:
        judgement.targetPosition !== null
          ? "personal_target"
          : "metric_default",
    };
  }

  const metric = THRESHOLD_FOR_KEY[key];
  if (!metric || reference === null) return metricDefault(key);

  const personal = resolvePersonalBand(metric, ctx.profile, ctx.thresholdsJson);
  if (!personal) return metricDefault(key);

  const toUnit = TO_THRESHOLD_UNIT[key];
  const position = placeAgainstBand(
    personal.band,
    toUnit ? toUnit(reference) : reference,
  );
  return {
    direction: directionFor(metric, position, personal.basis),
    targetPosition: position,
    basis: personal.basis,
  };
}

/**
 * A delivered change judged by a verdict, with the noise floor the arrows
 * have always used (`getTrendSentiment`). No verdict reads neutral.
 */
export function trendSentimentOf(
  change: number | null | undefined,
  verdict: TrendVerdict | null,
): TrendSentiment {
  return getTrendSentiment(change, verdict?.direction ?? "neutral");
}

/**
 * The same judgement for a change that is only known by its direction (the
 * `trend` of a dashboard card or a target tile). A flat or unknown trend is
 * no change: inside a band that is the one case where it is news.
 */
export function trendSentimentOfTrend(
  trend: "up" | "down" | "flat" | "stable" | "unknown" | null | undefined,
  verdict: TrendVerdict | null,
): TrendSentiment {
  if (trend === "up") return trendSentimentOf(1, verdict);
  if (trend === "down") return trendSentimentOf(-1, verdict);
  if (trend === "flat" || trend === "stable")
    return trendSentimentOf(0, verdict);
  return "neutral";
}

/** Keys that carry a verdict without a measurement summary of their own. */
export const SUMMARYLESS_VERDICT_KEYS = [
  "MOOD",
  "BLOOD_PRESSURE_IN_TARGET",
] as const;

/**
 * One verdict per summarised type, each placed with the value its tile shows
 * as the reference (the seven-day average, else the latest reading), plus the
 * summaryless keys at their metric default. The dashboard snapshot publishes
 * this as `tiles.directions`.
 */
export function resolveSummaryVerdicts(
  summaries: Readonly<
    Record<string, { avg7: number | null; latest: number | null } | undefined>
  >,
  ctx: Omit<TrendVerdictContext, "referenceValue">,
): Record<string, TrendVerdict> {
  const out: Record<string, TrendVerdict> = {};
  for (const [type, summary] of Object.entries(summaries)) {
    if (!summary) continue;
    out[type] = resolveTrendVerdict(type, {
      ...ctx,
      referenceValue: summary.avg7 ?? summary.latest ?? null,
    });
  }
  for (const key of SUMMARYLESS_VERDICT_KEYS) {
    out[key] ??= resolveTrendVerdict(key, { ...ctx, referenceValue: null });
  }
  return out;
}
