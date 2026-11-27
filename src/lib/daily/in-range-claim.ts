/**
 * The one rule for a sentence that calls the day in range.
 *
 * "All four of today's values sit inside their usual range" is true of the
 * vitals it counted and still misleads beside a Health score whose blood
 * pressure pillar is red ("Blood pressure: outside the reference range"). So
 * no server text may claim the day is in range while the Health score flags
 * anything: its band setter, or any counted pillar below green. The flag is
 * read from the same fields that word `bandSetterLine` (`band`, `bandSetter`,
 * `bandSetterBand`, the pillar rows), through {@link healthScoreFlag}.
 *
 * Every all-in-range message key is listed in {@link ALL_IN_RANGE_KEYS} and
 * is worded only here, each through a function that takes the flag.
 * `in-range-claim-guard.test.ts` holds the tree to that: a registered key
 * named anywhere else fails, and so does a new all-in-range sentence in the
 * bundle that is not registered. Pure.
 */
import { scoreBand } from "@/lib/analytics/score/shared";
import type { ScoreBand, ScorePillarId } from "@/lib/analytics/score/types";
import type { Locale } from "@/lib/i18n/config";
import { pluralKey } from "@/lib/i18n/plural";
import {
  SCORE_PILLAR_LABEL_KEYS,
  worseScoreBand,
} from "@/lib/score-config/labels";
import { vitalLabel } from "@/lib/daily/lead-sentences";
import type { TodayVital } from "@/lib/daily/today-overview";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * Every message key (or plural prefix) whose text says the day, or all of
 * its values, are in range or need nothing. Only this module words them.
 */
export const ALL_IN_RANGE_KEYS = [
  "daily.lead.vitalsInRange",
  "daily.lead.vitalInRange",
  "daily.todayFact.vitals.allIn",
  "daily.line.allClear",
  "insights.derived.coincident.allClear",
] as const;

/** The Health score fields the flag is read from (digest or snapshot). */
export interface HealthScoreFlagSource {
  /** The worse of the number's band and the worst counted pillar's. */
  band: string;
  bandSetter?: ScorePillarId | null;
  bandSetterBand?: "yellow" | "red" | null;
  /**
   * The snapshot's pillar rows, when the caller has them: the served band,
   * else (a payload cached before it) the band of the value.
   */
  pillars?: readonly {
    id: ScorePillarId;
    value: number | null;
    band?: ScoreBand | null;
  }[];
}

/** What the Health score flags: the pillar when it is known, and its band. */
export interface HealthScoreFlag {
  band: "yellow" | "red";
  pillar: ScorePillarId | null;
}

const BAND_RANK: Record<string, number> = { red: 0, yellow: 1, green: 2 };

function worstPillar(
  pillars: HealthScoreFlagSource["pillars"],
): { id: ScorePillarId; band: "yellow" | "red" } | null {
  let worst: { id: ScorePillarId; band: "yellow" | "red" } | null = null;
  for (const p of pillars ?? []) {
    const band = p.band ?? (p.value === null ? null : scoreBand(p.value));
    if (band === null || band === "green") continue;
    if (!worst || BAND_RANK[band] < BAND_RANK[worst.band]) {
      worst = { id: p.id, band };
    }
  }
  return worst;
}

/**
 * Whether the Health score flags anything today, and what. Null when there
 * is no score or every counted pillar is green.
 */
export function healthScoreFlag(
  score: HealthScoreFlagSource | null | undefined,
): HealthScoreFlag | null {
  if (!score) return null;
  const band = worseScoreBand(score.band, score.bandSetterBand);
  if (band !== "yellow" && band !== "red") return null;
  if (score.bandSetter && score.bandSetterBand) {
    return { band: score.bandSetterBand, pillar: score.bandSetter };
  }
  const worst = worstPillar(score.pillars);
  return worst
    ? { band: worst.band, pillar: worst.id }
    : { band, pillar: null };
}

/**
 * The counting sentence for today's vitals, all inside their range: the
 * number of them, or the one by name. Null when there is none, and null
 * while the Health score flags anything.
 */
export function vitalsInRangeSentence(
  vitals: readonly TodayVital[],
  flag: HealthScoreFlag | null,
  locale: Locale,
  t: Translate,
): string | null {
  if (flag) return null;
  if (vitals.length >= 2) {
    return t(pluralKey("daily.lead.vitalsInRange", vitals.length, locale), {
      count: vitals.length,
    });
  }
  if (vitals.length === 1) {
    const v = vitals[0];
    return t("daily.lead.vitalInRange", {
      metric: vitalLabel(t, v.type),
      value: v.valueLabel,
      range: v.rangeLabel,
    });
  }
  return null;
}

/**
 * The sentence said in place of the in-range one while the Health score
 * flags something: the pillar by name, or the score itself when the pillar
 * is not known (a payload cached before the pillar rows).
 */
export function flaggedScoreSentence(
  flag: HealthScoreFlag,
  t: Translate,
): string {
  if (!flag.pillar) return t(`daily.lead.scoreFlagged.${flag.band}`);
  return t(`daily.lead.pillarFlagged.${flag.band}`, {
    pillar: t(SCORE_PILLAR_LABEL_KEYS[flag.pillar]),
  });
}

/**
 * The vitals fact when none is outside: "4 checked, all in your range", or
 * only the count while the Health score flags something.
 */
export function vitalsAllInFact(
  count: number,
  flag: HealthScoreFlag | null,
  locale: Locale,
  t: Translate,
): string {
  if (flag) {
    return t(pluralKey("daily.todayFact.vitals.checked", count, locale), {
      count,
    });
  }
  return t(pluralKey("daily.todayFact.vitals.allIn", count, locale), {
    count,
  });
}

/** "Nothing needs your attention today", never while something is flagged. */
export function allClearLine(
  flag: HealthScoreFlag | null,
  t: Translate,
): string | null {
  return flag ? null : t("daily.line.allClear");
}
