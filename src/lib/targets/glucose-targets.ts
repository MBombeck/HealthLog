/**
 * Diabetes-aware blood-glucose TARGET resolver (v1.18.6).
 *
 * One question: "what glucose band should THIS user be judged against on this
 * context, right now?" The answer depends on a single explicit, user-declared
 * preference — `User.hasDiabetes` — and NEVER on any reading. The flag is set
 * through Settings (`PATCH /api/auth/me/diabetes`); it is never inferred from
 * a value and never asserts a diagnosis.
 *
 *   - Flag OFF (default): the general non-diabetic normal bands — the existing
 *     behaviour, resolved by the shared reference-range resolver
 *     (`getEffectiveRange`, which owns the band display) so a user-override
 *     still wins and nothing about the calm-state UI changes.
 *   - Flag ON: the tighter ADA glycemic GOAL bands for people living with
 *     diabetes — fasting / pre-prandial 80–130 mg/dL, peak post-prandial
 *     < 180 mg/dL (ADA Standards of Care §6, stable 2024–2026). A user
 *     override still wins (a clinician may pin an individualised goal), but
 *     absent an override the diabetic goal band — not the normal band — is the
 *     target.
 *
 * The diabetic goal targets are GOALS, not screening thresholds: a fasting 80
 * is "in goal" for someone managing diabetes, where the non-diabetic 70–99
 * normal band would call the same reading low-normal. This is exactly why we
 * keep the two resolvers distinct rather than widening the general band.
 *
 * Pure given its inputs. The route resolves the flag + overrides and passes
 * them in. mg/dL throughout (HealthLog canonical store unit); display-time
 * conversion to mmol/L is the caller's job (`src/lib/glucose.ts`).
 *
 * Citation: American Diabetes Association, Standards of Care in Diabetes
 * §6 "Glycemic Goals and Hypoglycemia", Diabetes Care 2024 47(Suppl. 1):S111.
 * Pre-prandial plasma glucose goal 80–130 mg/dL; peak post-prandial < 180
 * mg/dL. https://diabetesjournals.org/care/article/47/Supplement_1/S111/153957
 */

import {
  getEffectiveRange,
  type ThresholdMetric,
  type ThresholdOverridesJson,
  type UserProfileForRange,
} from "@/lib/analytics/effective-range";
import type { TrafficRange } from "@/lib/analytics/value-bands";
import {
  thresholdMetricForContext,
  type GlucoseContextBucket,
} from "@/lib/glucose";

/**
 * The buckets a glucose target can be resolved for — the four named contexts
 * plus the untagged bucket (#943), which is judged against the RANDOM band
 * because an untagged reading is a spot reading.
 */
export type GlucoseContextKey = GlucoseContextBucket;

/**
 * ADA glycemic GOAL bands for people living with diabetes (mg/dL).
 *
 * FASTING / pre-prandial: 80–130 (ADA pre-prandial plasma glucose goal).
 * POSTPRANDIAL: floor 80 (avoid hypoglycemia), ceiling 180 (ADA peak
 *   post-prandial goal `< 180`; the inclusive 180 is the band edge).
 * RANDOM: a random spot reading is not a defined ADA goal context; the
 *   post-prandial goal is the most clinically defensible comparator (a random
 *   reading is most often post-meal). Use the same 80–180 band.
 * BEDTIME: ADA publishes no separate bedtime goal for adults; the ISPAD
 *   pediatric bedtime band (90–150) is the closest comparator and the slightly
 *   higher floor guards against nocturnal hypoglycemia. Kept identical to the
 *   non-diabetic bedtime band on purpose — the diabetic delta lives in the
 *   fasting/post-prandial goals, where ADA is explicit.
 * UNSPECIFIED: a reading whose source recorded no meal-time context. Same band
 *   as RANDOM, and for the same reason — an untagged reading is a spot
 *   reading, and the post-prandial goal is the defensible comparator.
 */
const DIABETIC_GOAL_BANDS: Record<
  GlucoseContextKey,
  { min: number; max: number }
> = {
  FASTING: { min: 80, max: 130 },
  POSTPRANDIAL: { min: 80, max: 180 },
  RANDOM: { min: 80, max: 180 },
  BEDTIME: { min: 90, max: 150 },
  UNSPECIFIED: { min: 80, max: 180 },
};

/** Source label surfaced on the resolved range for the targets surface. */
export type GlucoseTargetSource = "ADA goal (diabetes)" | "default" | "custom";

export interface ResolvedGlucoseTarget {
  /** The green band the reading is judged against (mg/dL). */
  range: TrafficRange | null;
  /** True when a user threshold override is in play (override always wins). */
  isOverride: boolean;
  /**
   * Which band family produced the range: the diabetic ADA goal, the general
   * default, or a user custom override. Drives the targets-card source label.
   */
  source: GlucoseTargetSource;
}

/**
 * Build the diabetic-goal `TrafficRange`. The orange wings mirror the general
 * resolver's glucose convention (floor − 10 below, a modest ceiling above) so
 * a reading just outside goal reads "elevated", not "high".
 */
function diabeticGoalRange(ctx: GlucoseContextKey): TrafficRange {
  const band = DIABETIC_GOAL_BANDS[ctx];
  return {
    greenMin: band.min,
    greenMax: band.max,
    orangeMin: band.min - 10,
    // Above the goal ceiling stays "elevated" up to a modest margin before
    // the red "high" band; matches the general resolver's wing width posture.
    orangeMax: band.max + 30,
  };
}

/**
 * Resolve the glucose target band for one context.
 *
 * `hasDiabetes` is the user's explicit, declared preference. When `true` AND
 * the user has NOT overridden the metric, the ADA diabetic goal band wins.
 * Otherwise we defer entirely to the shared reference-range resolver so the
 * general non-diabetic band (and any user override) behaves exactly as before.
 *
 * The flag is NEVER derived from a reading and asserts no diagnosis — it only
 * selects the band the user is measured against.
 */
export function resolveGlucoseTarget(input: {
  context: GlucoseContextKey;
  hasDiabetes: boolean;
  profile: UserProfileForRange;
  overrides: ThresholdOverridesJson | null | undefined;
}): ResolvedGlucoseTarget {
  const { context, hasDiabetes, profile, overrides } = input;
  const metric = thresholdMetricForContext(context) as ThresholdMetric;
  const eff = getEffectiveRange(metric, profile, overrides);

  // A user override always wins — a clinician-pinned individualised goal must
  // not be silently replaced by the population ADA goal band.
  if (eff.isOverride) {
    return { range: eff.range, isOverride: true, source: "custom" };
  }

  if (hasDiabetes) {
    return {
      range: diabeticGoalRange(context),
      isOverride: false,
      source: "ADA goal (diabetes)",
    };
  }

  return { range: eff.range, isOverride: false, source: "default" };
}

/** The ADA diabetic goal bands, exported for tests + documentation. */
export { DIABETIC_GOAL_BANDS };
