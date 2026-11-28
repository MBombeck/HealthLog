/**
 * Which way a weight change counts as progress, judged against the person's
 * own stored target rather than against gravity.
 *
 * The trend arrow, the 7-day delta and the comparison caption on the weight
 * tile used to be hard-wired `up-bad`: a falling number read green whatever
 * the person was aiming for. Someone below their target who was gaining, which
 * is exactly what they set out to do, saw every step coloured as a setback.
 *
 * The rule here is the whole answer, with no setting of its own:
 *
 *   - below the target band  → gaining is progress   (`up-good`)
 *   - above the target band  → losing is progress    (`up-bad`)
 *   - inside the target band → holding steady is     (`hold`)
 *   - no stored target       → the historical reading (`up-bad`)
 *
 * The target is the one the person entered on `/targets`, stored as
 * `User.thresholdsJson.WEIGHT` and narrowed by `resolveWeightTargetOverride`.
 * The height-derived WHO band is deliberately NOT a target here: nobody chose
 * it, and a band nobody chose is not a statement about which way they want to
 * move.
 *
 * Resolved on the server and published on the dashboard snapshot
 * (`tiles.weightTrend`) so the web tile and the native client colour the same
 * reading the same way. The web page's snapshot-disabled fallback calls this
 * same function; nothing else re-derives it.
 *
 * Pure and client-safe: no DB read, no clock.
 */
import type { TrendDirectionSentiment } from "@/lib/insights/trend-sentiment";
import {
  applyDisplayTransform,
  DEFAULT_UNIT_PREFERENCE,
  getDisplayTransform,
  type UnitPreference,
} from "@/lib/measurements/display-transform";
import { withUnit } from "@/lib/format/unit-join";

/** Where a weight sits against the person's own target band. */
export type WeightTargetPosition = "below" | "inside" | "above";

export interface WeightTrendJudgement {
  /** The sentiment direction the tile's arrow, delta and caption colour by. */
  direction: Extract<TrendDirectionSentiment, "up-good" | "up-bad" | "hold">;
  /**
   * Where the reference weight sits against the stored target. Null when no
   * target is stored or there is no reading yet — the two cases where the
   * historical `up-bad` reading applies.
   */
  targetPosition: WeightTargetPosition | null;
}

/**
 * Place a weight against the target band. The band edges count as inside: a
 * person sitting exactly on the number they typed has arrived.
 */
export function weightTargetPosition(
  target: { min: number; max: number } | null,
  weightKg: number | null,
): WeightTargetPosition | null {
  if (!target || weightKg === null || !Number.isFinite(weightKg)) return null;
  if (weightKg < target.min) return "below";
  if (weightKg > target.max) return "above";
  return "inside";
}

/**
 * The weight the position is read from: the 7-day average when there is one,
 * else the latest reading. A single morning reading near a band edge would
 * otherwise flip the arrow colour back and forth from one day to the next,
 * while the average moves at the pace the tile's own trend does.
 */
export function weightTrendReferenceKg(
  summary: { avg7: number | null; latest: number | null } | null | undefined,
): number | null {
  if (!summary) return null;
  return summary.avg7 ?? summary.latest ?? null;
}

export function resolveWeightTrend(
  target: { min: number; max: number } | null,
  referenceKg: number | null,
): WeightTrendJudgement {
  const targetPosition = weightTargetPosition(target, referenceKg);
  switch (targetPosition) {
    case "below":
      return { direction: "up-good", targetPosition };
    case "above":
      return { direction: "up-bad", targetPosition };
    case "inside":
      return { direction: "hold", targetPosition };
    default:
      return { direction: "up-bad", targetPosition: null };
  }
}

/**
 * The same judgement in the shape a narrative model reads: the band, where
 * the person is against it, and a plain sentence saying which way is
 * progress. Rides `features.weight.target` (briefing, overview analysis,
 * Coach) and the weight status snapshot, so an AI note never calls a gain a
 * regression when the person is below the target they set.
 *
 * Null without a stored target or a reading: then no direction is claimed at
 * all, which is the honest default for a model (the tile keeps its historical
 * colour, the prose makes no promise about which way is better).
 */
export interface WeightTargetFeature {
  /** The band's lower edge, in `unit`. */
  min: number;
  /** The band's upper edge, in `unit`. */
  max: number;
  /** The reader's mass unit; the band and the reading sentence are in it. */
  unit: string;
  position: WeightTargetPosition;
  progress: "gaining" | "losing" | "holding steady";
  reading: string;
}

const PROGRESS_BY_POSITION: Record<
  WeightTargetPosition,
  WeightTargetFeature["progress"]
> = {
  below: "gaining",
  above: "losing",
  inside: "holding steady",
};

export function buildWeightTargetFeature(
  target: { min: number; max: number } | null,
  summary: { avg7: number | null; latest: number | null } | null | undefined,
  /**
   * The reader's metric/imperial choice. The position is judged on the
   * canonical kilograms either way; only the band the text quotes converts.
   */
  system: UnitPreference = DEFAULT_UNIT_PREFERENCE,
): WeightTargetFeature | null {
  const position = weightTargetPosition(
    target,
    weightTrendReferenceKg(summary),
  );
  if (!target || !position) return null;
  const transform = getDisplayTransform("WEIGHT", system);
  const min = applyDisplayTransform(target.min, transform);
  const max = applyDisplayTransform(target.max, transform);
  const band = withUnit(`${min}–${max}`, transform.displayUnit);
  const reading =
    position === "below"
      ? `The person set their own weight target at ${band} and is currently below it, so gaining weight is progress and losing weight moves away from the goal. Judge weight changes against this target; never describe a gain as a setback or a regression.`
      : position === "above"
        ? `The person set their own weight target at ${band} and is currently above it, so losing weight is progress and gaining moves away from the goal.`
        : `The person set their own weight target at ${band} and is currently inside it, so holding steady is progress; a small move either way within the band is not a setback.`;
  return {
    min,
    max,
    unit: transform.displayUnit,
    position,
    progress: PROGRESS_BY_POSITION[position],
    reading,
  };
}
