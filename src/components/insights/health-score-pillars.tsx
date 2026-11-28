"use client";

import { InfoPopover } from "@/components/ui/info-popover";
import {
  BAND_PROGRESS_CLASS,
  clampScore,
} from "@/components/insights/derived/band-tokens";
import { CoverageMeter } from "@/components/insights/derived/coverage-meter";
import {
  pillarDetailLines,
  pillarObservedText,
  type PillarDetailContext,
} from "@/components/insights/health-score-pillar-detail";
import type {
  ScorePillarResult,
  ScorePillarWeight,
} from "@/lib/analytics/score/types";
import { useTranslations } from "@/lib/i18n/context";
import { SCORE_PILLAR_LABEL_KEYS } from "@/lib/score-config/labels";
import { cn } from "@/lib/utils";

/**
 * What counts toward the Health score: one row per scored pillar under the
 * heading every score page uses, in server registry order with no
 * re-ranking. Each row carries the weight the scorer gave the pillar, from
 * the composite's own `weights`; a payload cached before 1.50 has none, and
 * the row then shows the score alone.
 */
export function HealthScorePillars({
  scored,
  weights,
  detail,
}: {
  scored: ScorePillarResult[];
  weights: readonly ScorePillarWeight[] | undefined;
  detail: PillarDetailContext;
}) {
  const { t } = useTranslations();
  if (scored.length === 0) return null;
  const weightOf = new Map((weights ?? []).map((w) => [w.id, w.weight]));
  return (
    <div
      data-slot="health-score-contributors"
      className="border-border/60 space-y-2 border-t pt-3"
    >
      <p className="text-muted-foreground text-xs font-semibold">
        {t("insights.derived.anatomy.contributorsLabel")}
      </p>
      <ul data-slot="health-score-pillars" className="space-y-2">
        {scored.map((pillar) => (
          <PillarRow
            key={pillar.id}
            pillar={pillar}
            weight={weightOf.get(pillar.id) ?? null}
            detail={detail}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * One scored pillar, one line: a truncating name, a thin fill bar, the score,
 * and the (i) that opens everything else. The bar takes the pillar's OWN band
 * colour, as the server resolved it (`value.band`) — a pillar at 92 reads
 * green even when the composite is red, which is the point of showing the
 * contributors at all.
 *
 * The observed value, the reference band, the personal target, the source and
 * the per-pillar confidence all live in the popover. That is one tap more
 * than the pinned card charged for the observed line, and it is what buys the
 * column back.
 */
function PillarRow({
  pillar,
  weight,
  detail,
}: {
  pillar: ScorePillarResult;
  /** The pillar's share of the number, 0..1, as the server published it. */
  weight: number | null;
  detail: PillarDetailContext;
}) {
  const { t } = useTranslations();
  if (pillar.result.status !== "ok") return null;
  const score = clampScore(pillar.result.value.score);
  // The band the scorer resolved for this pillar; a payload without one
  // (an older server) draws the bar neutral rather than banding it here.
  const band = pillar.result.value.band;
  const observed = pillarObservedText(pillar, detail);
  const lines = pillarDetailLines(pillar, detail);

  return (
    <li
      data-pillar={pillar.id}
      data-status="ok"
      className="grid grid-cols-[minmax(0,7rem)_1fr_auto_auto] items-center gap-2 text-xs"
    >
      {/* The label wraps inside a fixed track; the row grows a line rather
          than cutting the name. `minmax(0,…)` plus `min-w-0` keeps the track
          from growing to the longest word, and `hyphens-auto` splits a
          compound ("Körperfett-verteilung") at a syllable instead of ending
          it in an ellipsis. Widening the column does not rescue the long
          names: the longest label in most locales overruns any column this
          panel can afford, and the width would come off the fill bar. */}
      <span className="text-muted-foreground min-w-0 break-words hyphens-auto">
        {t(SCORE_PILLAR_LABEL_KEYS[pillar.id])}
      </span>
      <div
        className="bg-muted/50 h-1.5 min-w-0 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <div
          data-slot="health-score-pillar-bar"
          className={cn(
            "h-full rounded-full",
            band ? BAND_PROGRESS_CLASS[band] : "bg-muted-foreground",
          )}
          style={{ width: `${score}%` }}
          data-band={band ?? "none"}
        />
      </div>
      <span
        data-slot="health-score-pillar-value"
        className="text-foreground min-w-8 text-right tabular-nums"
      >
        {weight === null
          ? Math.round(score)
          : t("insights.derived.anatomy.contributorValue", {
              value: Math.round(score),
              weight: Math.round(weight * 100),
            })}
      </span>
      <InfoPopover
        content={
          <>
            {observed ? (
              <span className="block">
                {t("insights.healthScore.observed", { value: observed })}
              </span>
            ) : null}
            {lines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
            <span className="mt-1.5 block">
              <CoverageMeter
                coverage={pillar.result.coverage}
                confidence={pillar.result.confidence}
                size="sm"
              />
            </span>
          </>
        }
        bodyDataSlot="health-score-pillar-detail"
      />
    </li>
  );
}
