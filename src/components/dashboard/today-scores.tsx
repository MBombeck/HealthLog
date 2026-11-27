"use client";

/**
 * The score row on the start page: the Health score, last night's sleep
 * score and today's readiness, each one link to its page.
 *
 * Wide (the tile strip below fits four or more columns): one tile per score,
 * each two strip columns wide, so at six columns its edges sit on the strip's
 * gutters; each is a `ScoreRingTile` (wide): the ring, the short name, the
 * band word and one line. Narrow (the strip is two or three columns): one
 * tile with the three rings side by side, their names and band words under
 * them, no dividers. Every ring is coloured by its band (concept B).
 * Both faces are in the markup; the one not shown is `display: none`, out of
 * the accessibility tree.
 *
 * Nothing is decided here. The Health score is the digest's, the sleep and
 * readiness tiles the morning's (`DailyMorning.scores`), worded and resolved
 * on the server. A value that is not fresh shows no number: the ring keeps
 * its bare track, and the line says when the last value was. A score the
 * record does not produce has no tile.
 */
import Link from "next/link";
import { Gauge, HeartPulse, Moon, type LucideIcon } from "lucide-react";

import { ScoreRing } from "@/components/insights/derived/score-ring";
import { ScoreRingTile } from "@/components/insights/derived/score-ring-tile";
import type { ScoreBand } from "@/components/insights/derived/band-tokens";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendTile } from "@/components/ui/trend-tile";
import type { Locale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import { pluralKey } from "@/lib/i18n/plural";
import { metricHref, pageHref } from "@/lib/links/hrefs";
import { metricName } from "@/lib/measurements/type-label-keys";
import { cn } from "@/lib/utils";
import type { DailyDigest } from "@/lib/daily/digest";
import type { DailyMorning, DailyMorningScore } from "@/lib/daily/morning";

/** One tile, resolved for display. */
export interface ScoreTileView {
  id: "health" | "sleep" | "readiness";
  label: string;
  /** The name under a ring in the narrow tile, three to a row. */
  shortLabel: string;
  icon: LucideIcon;
  href: string;
  /** Null: no number (not fresh, or not enough data yet). */
  score: number | null;
  band: ScoreBand | undefined;
  /** A past value exists: the stale face ("—", "not from today"). */
  stale: boolean;
  line: string | null;
}

type Translate = ReturnType<typeof useTranslations>["t"];

/** The Health score's one meta line: the band setter, else the move, else how long it held, else what it rests on. */
function healthLine(
  score: DailyDigest["score"],
  t: Translate,
  locale: Locale,
): string | null {
  if (!score) return null;
  // The pillar the green band leaves unsaid comes first: a green 79 over a
  // red blood pressure must not read as plain green (`bandSetter`).
  if (score.bandSetterLine) return score.bandSetterLine;
  if (score.delta !== null && score.deltaReason === null) {
    const rounded = Math.round(score.delta);
    if (rounded === 0) return t("daily.today.deltaFlatShort");
    return t("daily.today.deltaShort", {
      delta: rounded > 0 ? `+${rounded}` : `\u2212${Math.abs(rounded)}`,
    });
  }
  const weeks = score.steadyWeeks ?? null;
  if (weeks !== null) {
    return t(
      score.steadyAtLeast
        ? pluralKey("daily.today.steadyAtLeastWeeks", weeks, locale)
        : pluralKey("daily.today.steadyWeeks", weeks, locale),
      { count: weeks },
    );
  }
  const basis = score.scoreBasis ?? null;
  if (basis && basis.tier !== "full") {
    return t("insights.healthScore.basis", {
      count: basis.domains,
      recommended: basis.recommended,
    });
  }
  return null;
}

function morningTile(
  id: "sleep" | "readiness",
  tile: DailyMorningScore,
  label: string,
): ScoreTileView {
  const fresh = tile.ring.fresh && tile.ring.score !== null;
  return {
    id,
    label,
    shortLabel: label,
    icon: id === "sleep" ? Moon : Gauge,
    href: tile.href,
    score: fresh ? tile.ring.score : null,
    band: fresh && tile.ring.band ? (tile.ring.band as ScoreBand) : undefined,
    stale: !fresh && tile.ring.asOfDay !== null,
    line: tile.line,
  };
}

/** The tiles to show, in order. Pure, so the order and the gaps are pinned. */
export function scoreTiles(
  digest: DailyDigest,
  morning: DailyMorning | null | undefined,
  t: Translate,
  locale: Locale,
): ScoreTileView[] {
  const score = digest.score;
  const tiles: ScoreTileView[] = [
    {
      id: "health",
      label: t("insights.healthScore.label"),
      shortLabel: metricName("HEALTH_SCORE", t).short,
      icon: HeartPulse,
      href: metricHref("health_score") ?? pageHref("insights"),
      score: score?.value ?? null,
      band: score ? ((score.numberBand ?? score.band) as ScoreBand) : undefined,
      stale: false,
      line: healthLine(score, t, locale),
    },
  ];
  // A morning cached before the scores existed reads as "no tiles".
  const scores = morning?.scores;
  if (scores?.sleep) {
    tiles.push(
      morningTile(
        "sleep",
        scores.sleep,
        t("insights.derived.composite.SLEEP_SCORE.title"),
      ),
    );
  }
  if (scores?.readiness) {
    tiles.push(
      morningTile(
        "readiness",
        scores.readiness,
        t("insights.derived.composite.READINESS.title"),
      ),
    );
  }
  // No band word beside a ring: its colour and number say the band, and its
  // accessible name says it in words.
  return tiles;
}

/** The grid span of one wide tile: the row is six strip columns. */
const WIDE_SPAN: Record<number, string> = {
  1: "col-span-6",
  2: "col-span-3",
  3: "col-span-2",
};

/** The narrow tile's columns, one per ring. */
const COMPACT_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
};

function compactRing(tile: ScoreTileView) {
  return (
    <ScoreRing
      score={tile.score}
      band={tile.band ?? null}
      size="compact"
      flat
      emptyFace={tile.stale}
      ariaLabel={tile.stale ? (tile.line ?? undefined) : undefined}
    />
  );
}

export function TodayScores({
  digest,
  morning,
}: {
  digest: DailyDigest;
  morning: DailyMorning | null | undefined;
}) {
  const { t, locale } = useTranslations();
  const tiles = scoreTiles(digest, morning, t, locale);

  return (
    <section
      data-slot="today-scores"
      data-tile-count={tiles.length}
      aria-label={t("insights.scores.regionLabel")}
      className="@container"
    >
      {/* Wide: one tile per score on the strip's six columns. */}
      <div className="hidden gap-3 @min-[44.25rem]:grid @min-[44.25rem]:grid-cols-6">
        {tiles.map((tile) => (
          <div
            key={tile.id}
            data-slot="today-score-tile"
            data-score={tile.id}
            data-fresh={tile.score !== null ? "true" : "false"}
            className={cn("min-w-0", WIDE_SPAN[tiles.length])}
          >
            <ScoreRingTile
              size="wide"
              id={tile.id}
              href={tile.href}
              icon={tile.icon}
              label={tile.label}
              shortLabel={tile.shortLabel}
              score={tile.score}
              band={tile.band}
              stale={tile.stale}
              line={tile.line}
            />
          </div>
        ))}
      </div>

      {/* Narrow: the three rings in one tile, named underneath. */}
      <TrendTile
        data-slot="today-scores-compact"
        className={cn(
          "grid gap-3 md:p-4 @min-[44.25rem]:hidden",
          COMPACT_COLS[tiles.length],
        )}
      >
        {tiles.map((tile) => (
          <Link
            key={tile.id}
            href={tile.href}
            data-slot="today-score-compact"
            data-score={tile.id}
            className="focus-visible:ring-ring/50 flex min-w-0 flex-col items-center gap-2 rounded-lg text-center focus-visible:ring-2 focus-visible:outline-none"
          >
            {compactRing(tile)}
            <span className="text-foreground text-sm leading-tight font-medium break-words hyphens-auto">
              {tile.shortLabel}
            </span>
          </Link>
        ))}
      </TrendTile>
    </section>
  );
}

/** The row's footprint while the two reads are in flight. Decorative. */
export function TodayScoresSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-slot="today-scores-skeleton"
      className="@container"
    >
      <div className="hidden gap-3 @min-[44.25rem]:grid @min-[44.25rem]:grid-cols-6">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="col-span-2 h-34 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-34 rounded-xl @min-[44.25rem]:hidden" />
    </div>
  );
}

/** What the score row paints. */
export type TodaySlot =
  "off" | "block" | "skeleton" | "hero" | "error" | "none";

/**
 * Which face the score row shows, decided from the two reads.
 *
 * The full row needs BOTH reads. Until it has them it is a skeleton, in the
 * server render and the first client pass alike (`mounted` is false in
 * both), so the server's markup and the hydration render agree and the row
 * fills in one step. A digest without a morning (the morning read failed, or
 * an older service-worker cache) is `hero`: the Health score alone. A failed
 * digest is the error card. Pure, so the order of these cases is pinned
 * without a render.
 */
export function todaySlot(input: {
  visible: boolean;
  hasDigest: boolean;
  hasMorning: boolean;
  mounted: boolean;
  digestLoading: boolean;
  morningLoading: boolean;
  digestError: boolean;
}): TodaySlot {
  if (!input.visible) return "off";
  if (input.hasDigest && input.hasMorning) return "block";
  if (!input.mounted || input.digestLoading || input.morningLoading) {
    return "skeleton";
  }
  if (input.hasDigest) return "hero";
  if (input.digestError) return "error";
  return "none";
}
