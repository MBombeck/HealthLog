import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
} from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";

import {
  orderedUniquePillars,
  SCORE_VERSION,
  type CompositeValue,
  type HealthScoreReport,
  type ScoreBand,
  type ScorePillarId,
  type ScorePillarResult,
  type ScorePillarWeight,
} from "./types";
import { bandForScoreKind, provenance, scoreBand } from "./shared";
import { evaluateScoreBreadth, SCORE_RECOMMENDED_DOMAINS } from "./breadth";
import type { ScoreConfigBoundary } from "./config";
import { mean } from "@/lib/stats/central";

export const SCORE_ALGORITHM_CHANGED_AT = "2026-08-30T00:00:00.000Z";

// The rule itself lives in `./breadth`, where the settings write reads it
// too. Re-exported here because this is where every existing caller looks
// for it.
export { SCORE_RECOMMENDED_DOMAINS };

const BAND_RANK: Record<ScoreBand, number> = {
  green: 2,
  yellow: 1,
  red: 0,
};

export interface CompositeInput {
  pillars: ScorePillarResult[];
  availablePillars: ScorePillarId[];
  asOf: Date;
  /**
   * Whether `availablePillars` is an authored recipe rather than the
   * account's defaults. Resolved by `resolveScoreConfigured` before the
   * pillar list gets here, because the comparison needs the config and
   * the modules and the composite has neither. Required, so a caller
   * cannot stay silent and publish `false` for a configured account.
   */
  configured: boolean;
}

/**
 * How much each counted pillar weighs in the number: the same for every one,
 * because the score is their plain mean (`mean` below, nothing else). The
 * weights are published beside the number so a client can say how the
 * pillars count without knowing the rule; a test pins that the weighted sum
 * of the pillar scores is the number.
 */
export function compositeWeights(
  composition: readonly ScorePillarId[],
): ScorePillarWeight[] {
  if (composition.length === 0) return [];
  const weight = 1 / composition.length;
  return composition.map((id) => ({ id, weight }));
}

export function computeComposite(
  input: CompositeInput,
): Derived<CompositeValue> {
  const available = orderedUniquePillars(input.availablePillars);
  const byId = new Map(input.pillars.map((pillar) => [pillar.id, pillar]));
  const eligible = available
    .map((id) => byId.get(id))
    .filter(
      (pillar): pillar is ScorePillarResult => pillar?.result.status === "ok",
    );
  const composition = eligible.map((pillar) => pillar.id);
  const eligibleDomains = new Set(eligible.map((pillar) => pillar.domain));
  const breadth = evaluateScoreBreadth(composition);
  const availableDomains = new Set(
    input.pillars
      .filter((pillar) => available.includes(pillar.id))
      .map((pillar) => pillar.domain),
  );
  const missing = [...availableDomains].filter(
    (domain) => !eligibleDomains.has(domain),
  );
  const historyDays = eligible.reduce(
    (minimum, pillar) =>
      pillar.result.status === "ok"
        ? Math.min(minimum, pillar.result.coverage.historyDays)
        : minimum,
    Number.POSITIVE_INFINITY,
  );
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: SCORE_RECOMMENDED_DOMAINS,
    presentInputs: eligibleDomains.size,
    historyDays: Number.isFinite(historyDays) ? historyDays : 0,
    missing,
    fullHistoryDays: 28,
  });
  const compositeProvenance = provenance({
    inputs: composition,
    source:
      eligible.length > 0 &&
      eligible.every(
        (pillar) =>
          pillar.result.provenance.source !== "live" &&
          pillar.result.provenance.source !== "none",
      )
        ? "DAY"
        : eligible.length > 0
          ? "live"
          : "none",
    windowDays: Math.max(
      0,
      ...eligible.map((pillar) => pillar.result.provenance.windowDays),
    ),
    asOf: input.asOf,
  });

  // The only refusal left. Not "too narrow" — nothing readable at all,
  // and a mean over nothing is an absent score rather than a low one.
  if (!breadth.ok) {
    return buildInsufficient({
      coverage,
      provenance: compositeProvenance,
      reason: "no_usable_data",
    });
  }

  const values = eligible.map((pillar) => {
    if (pillar.result.status !== "ok") {
      throw new Error("Eligible score pillar lost its narrowed state");
    }
    return pillar.result.value;
  });
  // `breadth.ok` above guarantees an eligible pillar.
  const score = Math.round(mean(values.map((value) => value.score))!);
  // Two bands. `numberBand` follows the number, under the same rule as
  // every other HealthLog score (1.50); the web and newer apps draw it and
  // name a worse pillar beside it (`bandSetter`). `band` keeps its 1.49
  // meaning, the worse of the number's band and the worst counted pillar's,
  // because every shipped app colours the ring from it and explains it with
  // "X set the colour of this score". The stored day and "steady since"
  // compare `band`.
  const numberBand = bandForScoreKind("health", score);
  const bandSetterIndex = values.reduce(
    (worstIndex, value, index) =>
      BAND_RANK[scoreBand(value.score)] <
      BAND_RANK[scoreBand(values[worstIndex].score)]
        ? index
        : worstIndex,
    0,
  );
  const bandSetterValue = values[bandSetterIndex];
  const worstBand = scoreBand(bandSetterValue.score);
  const band =
    BAND_RANK[worstBand] < BAND_RANK[numberBand] ? worstBand : numberBand;
  const deltaValues = values.filter((value) => value.deltaEligible);
  const noiseFloor =
    deltaValues.length === 0
      ? 0
      : Math.ceil(
          Math.sqrt(
            deltaValues.reduce((sum, value) => sum + value.noiseFloor ** 2, 0),
          ) / deltaValues.length,
        );

  return buildOk({
    value: {
      score,
      band,
      numberBand,
      bandSetter:
        BAND_RANK[worstBand] < BAND_RANK[numberBand]
          ? composition[bandSetterIndex]
          : null,
      composition,
      configured: input.configured,
      // Resolved here for the same reason `configured` is: the count is
      // over DOMAINS, and a client counting `composition` would get it
      // wrong every time a cardiometabolic pair is in play.
      scoreBasis: {
        domains: breadth.domains.length,
        recommended: SCORE_RECOMMENDED_DOMAINS,
        tier: breadth.tier,
        physiological: breadth.physiological,
      },
      weights: compositeWeights(composition),
      noiseFloor,
      scoreVersion: SCORE_VERSION,
    },
    coverage,
    confidence,
    provenance: compositeProvenance,
  });
}

function sameComposition(
  left: Derived<CompositeValue>,
  right: Derived<CompositeValue>,
): boolean {
  return (
    left.status === "ok" &&
    right.status === "ok" &&
    left.value.composition.length === right.value.composition.length &&
    left.value.composition.every(
      (pillar, index) => pillar === right.value.composition[index],
    )
  );
}

function comparableDynamicPillars(
  report: Derived<CompositeValue>,
  other: Derived<CompositeValue>,
  pillars: ScorePillarResult[],
  otherPillars: ScorePillarResult[],
): {
  current: number;
  previous: number;
  noiseFloor: number;
} | null {
  if (report.status !== "ok" || other.status !== "ok") return null;
  const otherById = new Map(otherPillars.map((pillar) => [pillar.id, pillar]));
  const pairs = pillars.flatMap((pillar) => {
    const previous = otherById.get(pillar.id);
    if (
      !report.value.composition.includes(pillar.id) ||
      !other.value.composition.includes(pillar.id) ||
      pillar.result.status !== "ok" ||
      previous?.result.status !== "ok" ||
      !pillar.result.value.deltaEligible ||
      !previous.result.value.deltaEligible ||
      pillar.result.value.deltaIdentity !== previous.result.value.deltaIdentity
    ) {
      return [];
    }
    return [
      {
        current: pillar.result.value.score,
        previous: previous.result.value.score,
        noiseFloor: Math.max(
          pillar.result.value.noiseFloor,
          previous.result.value.noiseFloor,
        ),
      },
    ];
  });
  if (pairs.length === 0) return null;
  return {
    current: mean(pairs.map((pair) => pair.current))!,
    previous: mean(pairs.map((pair) => pair.previous))!,
    noiseFloor: Math.ceil(
      Math.sqrt(pairs.reduce((sum, pair) => sum + pair.noiseFloor ** 2, 0)) /
        pairs.length,
    ),
  };
}

/**
 * Whether the person's own recipe changed BETWEEN the two windows being
 * compared.
 *
 * The exact shape of the global algorithm boundary one function below,
 * for the same reason and with the same arithmetic: a dated change, and
 * a comparison that straddles the date. What makes the per-user version
 * necessary at all is that the two windows are computed in ONE request
 * under whatever recipe is in force right now. Both sides therefore
 * carry the new composition, `sameComposition` agrees, and the
 * subtraction looks legitimate. Nothing inside the two composites can
 * see the change; only the recipe's own `changedAt` can.
 *
 * The date is the whole signal, and the boundary's `version` is
 * deliberately NOT consulted here. An earlier draft also required
 * `version >= 1`, which reads like defence in depth and is not: the
 * resolver hands back a version below 1 only on the path that also
 * hands back a null date, so no input could ever reach that arm and no
 * test could make it fail. A condition nothing can trip is decoration
 * on a guard. The version earns its keep elsewhere — it identifies the
 * recipe on the stored row and in the notice key — but the question
 * "did the recipe move inside this window" has one honest answer and it
 * is a date.
 *
 * No date means nothing to compare, and that does not suppress:
 * refusing every delta forever over an unreadable timestamp would trade
 * one silent lie for a permanent silence. Both cases — an account that
 * never chose, and a stored date this build cannot read — parse to NaN,
 * and every comparison against NaN is false, so the refusal falls out
 * of the arithmetic. Two early returns stood here and neither could
 * change an answer, which makes them a comment wearing an `if`.
 */
export function crossesConfigBoundary(
  boundary: ScoreConfigBoundary,
  previousAt: Date,
  asOf: Date,
): boolean {
  const changedAt = Date.parse(boundary.changedAt ?? "");
  return asOf.getTime() >= changedAt && previousAt.getTime() < changedAt;
}

/**
 * `config` is required and has no default on purpose. Every caller has
 * to state which recipe the two windows were computed under, and the
 * account that authored none says so with
 * {@link UNCONFIGURED_SCORE_BOUNDARY}. A defaulted boundary would let a
 * future caller thread nothing and get the pre-v1.35.0 behaviour back —
 * a false drop narrated at a person who had just used the settings page.
 */
export function attachScoreDelta(
  current: Derived<CompositeValue>,
  previous: Derived<CompositeValue>,
  previousPrevious: Derived<CompositeValue>,
  asOf: Date,
  config: ScoreConfigBoundary,
  currentPillars: ScorePillarResult[] = [],
  previousPillars: ScorePillarResult[] = [],
): Pick<HealthScoreReport, "delta" | "deltaReason"> {
  if (current.status !== "ok") {
    return { delta: null, deltaReason: "no_current_score" };
  }
  if (previous.status !== "ok") {
    return { delta: null, deltaReason: "no_previous_window" };
  }

  const previousAt = new Date(previous.provenance.computedAt);
  const boundary = new Date(SCORE_ALGORITHM_CHANGED_AT);
  if (
    current.value.scoreVersion !== previous.value.scoreVersion ||
    (asOf >= boundary && previousAt < boundary)
  ) {
    return { delta: null, deltaReason: "algorithm_changed" };
  }
  // Ahead of the composition check deliberately. When both fire, the
  // person changed what counts and that is the truer sentence; "the
  // included pillars changed" would describe the consequence and leave
  // out the act.
  if (crossesConfigBoundary(config, previousAt, asOf)) {
    return { delta: null, deltaReason: "config_changed" };
  }
  if (!sameComposition(current, previous)) {
    return { delta: null, deltaReason: "composition_changed" };
  }
  if (
    previousPrevious.status !== "ok" ||
    !sameComposition(previous, previousPrevious)
  ) {
    return { delta: null, deltaReason: "first_eligibility_window" };
  }

  const comparable =
    currentPillars.length > 0 || previousPillars.length > 0
      ? comparableDynamicPillars(
          current,
          previous,
          currentPillars,
          previousPillars,
        )
      : null;
  if (
    (currentPillars.length > 0 || previousPillars.length > 0) &&
    !comparable
  ) {
    return { delta: null, deltaReason: "composition_changed" };
  }
  const delta = Math.round(
    (comparable?.current ?? current.value.score) -
      (comparable?.previous ?? previous.value.score),
  );
  if (Math.abs(delta) < (comparable?.noiseFloor ?? current.value.noiseFloor)) {
    return { delta: null, deltaReason: "below_noise_floor" };
  }
  return { delta, deltaReason: null };
}
