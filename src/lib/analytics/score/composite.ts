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
import { shiftDateKey } from "@/lib/tz/format";

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

/**
 * A day the score's history holds, as the delta reads it: the
 * `HealthScoreRecord` row of that local day, the number shown on it.
 */
export interface StoredScoreDay {
  dayKey: string;
  composite: number;
  scoreVersion: number;
  composition: readonly string[];
  /** Null on a row written before the recipe version was recorded. */
  configVersion: number | null;
  computedAt: Date;
}

/** How far back the comparison day sits: a week. */
const SCORE_DELTA_LOOKBACK_DAYS = 7;
/**
 * The comparison window's width. The newest stored day in it is the one
 * compared against, so a week with a day or two unopened still has one.
 */
const SCORE_DELTA_WINDOW_DAYS = 7;

/**
 * The newest stored day in the week that ends {@link
 * SCORE_DELTA_LOOKBACK_DAYS} before `dayKey`, or null when that week holds
 * none.
 */
function comparisonDay(
  days: readonly StoredScoreDay[],
  dayKey: string,
): StoredScoreDay | null {
  const to = shiftDateKey(dayKey, -SCORE_DELTA_LOOKBACK_DAYS);
  const from = shiftDateKey(
    dayKey,
    -(SCORE_DELTA_LOOKBACK_DAYS + SCORE_DELTA_WINDOW_DAYS - 1),
  );
  let best: StoredScoreDay | null = null;
  for (const day of days) {
    if (day.dayKey < from || day.dayKey > to) continue;
    if (!best || day.dayKey > best.dayKey) best = day;
  }
  return best;
}

/** How many days before today the delta's two stored days can reach back. */
export const SCORE_DELTA_READ_DAYS =
  2 * (SCORE_DELTA_LOOKBACK_DAYS + SCORE_DELTA_WINDOW_DAYS - 1);

function sameComposition(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((pillar, index) => pillar === right[index])
  );
}

/**
 * Whether the person's own recipe changed BETWEEN the two days being
 * compared, read from the recipe's own date.
 *
 * The exact shape of the global algorithm boundary one function below,
 * for the same reason and with the same arithmetic: a dated change, and
 * a comparison that straddles the date. A stored day names its recipe
 * version and the delta compares that first; this is the answer for a
 * day stored before the version was written onto the row.
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
 * The week-over-week move of the health score, read from the days the
 * score's history holds.
 *
 * The number it compares against is the stored score of the comparison
 * day (`comparisonDay`), the point the history chart draws for that day,
 * and today's side is the score shown now, the chart's newest point. So
 * "+2" is always the difference between two points the chart beside it
 * shows. Computing the earlier side again from today's rows, as this did
 * before 1.50, could produce a move the chart had no point for, and a
 * number for a day that was never shown.
 *
 * The guards keep their order and their meaning, each read off the stored
 * row: a method change (`algorithm_changed`), the person's own recipe
 * change (`config_changed`, the act ahead of its consequence), a changed
 * pillar set (`composition_changed`), a pillar set that only became
 * eligible in the comparison week (`first_eligibility_window`: the week
 * before it holds no day of the same set), and a move inside the noise
 * floor.
 *
 * `config` is required and has no default on purpose. Every caller has
 * to state which recipe today was scored under, and the account that
 * authored none says so with {@link UNCONFIGURED_SCORE_BOUNDARY}.
 */
export function attachScoreDelta(args: {
  current: Derived<CompositeValue>;
  /** Stored days before today, any order; today's own row is not read. */
  history: readonly StoredScoreDay[];
  todayKey: string;
  asOf: Date;
  config: ScoreConfigBoundary;
}): Pick<HealthScoreReport, "delta" | "deltaReason"> {
  const { current, config } = args;
  if (current.status !== "ok") {
    return { delta: null, deltaReason: "no_current_score" };
  }
  const previous = comparisonDay(args.history, args.todayKey);
  if (!previous) {
    return { delta: null, deltaReason: "no_previous_window" };
  }

  const boundary = new Date(SCORE_ALGORITHM_CHANGED_AT);
  if (
    current.value.scoreVersion !== previous.scoreVersion ||
    (args.asOf >= boundary && previous.computedAt < boundary)
  ) {
    return { delta: null, deltaReason: "algorithm_changed" };
  }
  if (
    previous.configVersion === null
      ? crossesConfigBoundary(config, previous.computedAt, args.asOf)
      : previous.configVersion !== config.version
  ) {
    return { delta: null, deltaReason: "config_changed" };
  }
  if (!sameComposition(current.value.composition, previous.composition)) {
    return { delta: null, deltaReason: "composition_changed" };
  }
  const before = comparisonDay(args.history, previous.dayKey);
  if (!before || !sameComposition(previous.composition, before.composition)) {
    return { delta: null, deltaReason: "first_eligibility_window" };
  }

  const delta = current.value.score - previous.composite;
  if (Math.abs(delta) < current.value.noiseFloor) {
    return { delta: null, deltaReason: "below_noise_floor" };
  }
  return { delta, deltaReason: null };
}
