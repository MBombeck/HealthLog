"use client";

import Link from "next/link";

import {
  DAY_SCORE_HREF,
  type DayScore,
  type DayScoreKey,
} from "@/lib/day/contract";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import { DAY_SECTION_LABEL, NumberLine } from "./day-sections";

/**
 * The day's scores, below its values: one tile per score the record holds
 * for the day, each opening the score's own page. A score the day does not
 * have gets no tile, and a day without any gets no section.
 */

/** The name each score carries on its own page. */
const SCORE_LABEL: Readonly<Record<DayScoreKey, string>> = {
  healthScore: "insights.healthScore.label",
  readiness: "insights.derived.composite.READINESS.title",
  recovery: "insights.derived.scores.recovery",
  sleepScore: "insights.derived.composite.SLEEP_SCORE.title",
  strain: "insights.derived.scores.strain",
};

/** The scale every score but a device's day strain is read on. */
const PERCENT_SCALE = 100;

function ScoreTile({ score }: { score: DayScore }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const decimals = score.max === PERCENT_SCALE ? 0 : 1;
  const show = (n: number) => fmt.number(n, decimals);
  return (
    <li className="min-w-0">
      <Link
        href={DAY_SCORE_HREF[score.key]}
        data-slot="day-score"
        data-score={score.key}
        className="bg-muted/60 hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 flex-col rounded-lg px-3 py-2.5 transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
      >
        <span className="text-muted-foreground truncate text-xs">
          {t(SCORE_LABEL[score.key])}
        </span>
        <span className="truncate text-base font-semibold tabular-nums">
          {show(score.value)}
          {score.max !== PERCENT_SCALE ? (
            <span className="text-muted-foreground ml-1 text-xs font-medium">
              {t("day.scoreOfMax", { max: score.max })}
            </span>
          ) : null}
        </span>
        {score.band ? (
          <>
            <NumberLine value={score.value} band={score.band} />
            <span className="sr-only">
              {t("day.usualRange", {
                lo: show(score.band.lo),
                hi: show(score.band.hi),
              })}
            </span>
          </>
        ) : null}
      </Link>
    </li>
  );
}

export function DayScores({ scores }: { scores: readonly DayScore[] }) {
  const { t } = useTranslations();
  if (scores.length === 0) return null;
  return (
    <section className="space-y-2" data-slot="day-scores">
      <h3 className={DAY_SECTION_LABEL}>{t("day.groups.scores")}</h3>
      <ul className="grid grid-cols-2 gap-2">
        {scores.map((score) => (
          <ScoreTile key={score.key} score={score} />
        ))}
      </ul>
    </section>
  );
}
