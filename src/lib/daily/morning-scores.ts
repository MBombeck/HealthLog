/**
 * The start page's sleep and readiness tiles (`DailyMorning.scores`), and
 * the two readings they share with the morning's cards: whether last night
 * is scored, and what holds readiness back. Pure; worded through `t`.
 */
import { isLastNight } from "@/lib/sleep/last-night";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { metricHref, pageHref } from "@/lib/links/hrefs";
import type {
  DailyMorning,
  DailyMorningRing,
  DailyMorningScore,
  Facts,
  MorningInput,
  MorningReadinessComponent,
} from "@/lib/daily/morning";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

function moduleOn(input: MorningInput, key: "sleep"): boolean {
  return input.modules[key] !== false;
}

export const CONTRIBUTOR_LABEL_KEY: Record<
  MorningReadinessComponent["key"],
  string
> = {
  rhr: "insights.derived.composite.READINESS.component.rhr",
  hrv: "insights.derived.composite.READINESS.component.hrv",
  // The sleep contributor is the sleep score, and is called that.
  sleep: "insights.derived.composite.SLEEP_SCORE.title",
  respiratory: "insights.derived.composite.READINESS.component.respiratory",
  mood: "insights.derived.composite.READINESS.component.mood",
};

/**
 * The contributors holding readiness back, largest weighted deduction first.
 * A contributor at 100 deducts nothing and is never named.
 */
export function heaviestDeductions(
  components: readonly MorningReadinessComponent[],
): MorningReadinessComponent[] {
  return components
    .filter((c) => c.value !== null && c.weight > 0 && c.value < 100)
    .sort(
      (a, b) =>
        b.weight * (100 - (b.value as number)) -
        a.weight * (100 - (a.value as number)),
    );
}

/**
 * Whether the night card carries last night's sleep score ring: only when
 * last night is in (`resolveLastNight`), never beside "not in yet".
 */
export function lastNightScored(input: MorningInput): boolean {
  return (
    input.modules.sleep !== false &&
    input.sleep !== null &&
    input.sleepScore !== null &&
    isLastNight(
      { night: input.sleepScore.night, asleepMinutes: input.sleep.minutes },
      input.todayKey,
    )
  );
}

function sleepScoreTile(
  input: MorningInput,
  facts: Facts,
  t: Translate,
): DailyMorningScore | null {
  if (!moduleOn(input, "sleep")) return null;
  const score = input.sleepScore;
  if (!input.sleepExpected && !facts.sleep && !score) return null;
  const scored = score !== null && lastNightScored(input);
  const ring: DailyMorningRing = scored
    ? {
        score: Math.round(score.score),
        band: score.band,
        fresh: true,
        asOfDay: score.night,
      }
    : { score: null, band: null, fresh: false, asOfDay: score?.night ?? null };
  let line: string | null = null;
  if (facts.sleep) {
    line = formatDurationMinutes(Math.round(facts.sleep.minutes), t);
  } else if (facts.sleepPending) {
    line = t("daily.morningCard.nightPending");
  } else if (input.latestNightLabel) {
    line = t("daily.morningCard.latestNight", {
      date: input.latestNightLabel,
    });
  }
  return {
    ring,
    line,
    href: metricHref("sleep_score") ?? pageHref("insights"),
  };
}

function readinessScoreTile(
  input: MorningInput,
  facts: Facts,
  t: Translate,
): DailyMorningScore | null {
  const readiness = facts.readiness;
  if (!readiness) return null;
  const href = metricHref("readiness") ?? pageHref("insights");
  if (!readiness.fresh) {
    return {
      ring: {
        score: null,
        band: null,
        fresh: false,
        asOfDay: readiness.asOfDay,
      },
      line: input.readinessAsOfLabel
        ? t("daily.morningCard.readinessLast", {
            score: Math.round(readiness.score),
            date: input.readinessAsOfLabel,
          })
        : null,
      href,
    };
  }
  const banded = facts.restMode === null;
  // The heaviest pull on the score, named as the card names it; the sleep
  // score has its own tile beside this one, so it is not named twice.
  const pull = heaviestDeductions(readiness.components).find(
    (c) => !(lastNightScored(input) && c.key === "sleep"),
  );
  const line = pull
    ? t("daily.morningCard.contributor", {
        name: t(CONTRIBUTOR_LABEL_KEY[pull.key]),
        value: Math.round(pull.value as number),
      })
    : banded
      ? t(`daily.morningCard.readinessBand.${readiness.band}`)
      : null;
  return {
    ring: {
      score: Math.round(readiness.score),
      band: banded ? readiness.band : null,
      fresh: true,
      asOfDay: readiness.asOfDay,
    },
    line,
    href,
  };
}

/** Both score tiles, from the morning's one set of facts. */
export function buildMorningScores(
  input: MorningInput,
  facts: Facts,
  t: Translate,
): DailyMorning["scores"] {
  return {
    sleep: sleepScoreTile(input, facts, t),
    readiness: readinessScoreTile(input, facts, t),
  };
}
