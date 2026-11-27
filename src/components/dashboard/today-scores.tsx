"use client";

/**
 * The score row on the start page: the Health score, last night's sleep
 * score and today's readiness, each one link to its page.
 *
 * Wide (the tile strip below fits four or more columns): one tile per score,
 * each two strip columns wide, so at six columns its edges sit on the strip's
 * gutters. The ring stands at the tile's content edge, nearly centred over
 * the tile below it, with the title and one meta line beside it in the
 * metric tile's anatomy. Narrow (the strip is two or three columns): one tile
 * with the three rings side by side and their names under them, no dividers.
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

import { TileHeader } from "@/components/insights/tile-header";
import { ScoreRing } from "@/components/insights/derived/score-ring";
import type { ScoreBand } from "@/components/insights/derived/band-tokens";
import type { RingHue } from "@/components/insights/derived/ring-hues";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendTile } from "@/components/ui/trend-tile";
import type { Locale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import { pluralKey } from "@/lib/i18n/plural";
import { metricHref, pageHref } from "@/lib/links/hrefs";
import { cn } from "@/lib/utils";
import type { DailyDigest } from "@/lib/daily/digest";
import type { DailyMorning, DailyMorningScore } from "@/lib/daily/morning";

/** One tile, resolved for display. */
export interface ScoreTileView {
  id: "health" | "sleep" | "readiness";
  label: string;
  icon: LucideIcon;
  hue: RingHue;
  href: string;
  /** Null: no number (not fresh, or not enough data yet). */
  score: number | null;
  band: ScoreBand | undefined;
  /** A past value exists: the bare track instead of the provisional dash. */
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
    if (rounded === 0) return t("daily.today.deltaFlat");
    return t("daily.today.deltaVsBaseline", {
      delta: rounded > 0 ? `+${rounded}` : `${rounded}`,
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
    icon: id === "sleep" ? Moon : Gauge,
    hue: id,
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
      icon: HeartPulse,
      hue: "health",
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

function ring(tile: ScoreTileView, size: "dashboard" | "compact") {
  return (
    <ScoreRing
      score={tile.score}
      band={tile.band}
      hue={tile.hue}
      size={size}
      flat
      emptyFace={tile.stale}
      ariaLabel={
        tile.score === null && tile.stale
          ? [tile.label, tile.line].filter(Boolean).join(": ")
          : undefined
      }
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
          <Link
            key={tile.id}
            href={tile.href}
            data-slot="today-score-tile"
            data-score={tile.id}
            data-fresh={tile.score !== null ? "true" : "false"}
            className={cn(
              "focus-visible:ring-ring/50 hover:ring-ring/30 min-w-0 rounded-xl transition-[box-shadow] hover:ring-2 focus-visible:ring-2 focus-visible:outline-none",
              WIDE_SPAN[tiles.length],
            )}
          >
            {/* The metric tile's own frame and inset. The ring stands at the
                tile's content edge, close to centred over the tile below it;
                the title and its line take the rest, so a long name or a
                long line still reads on one or two lines. */}
            <TrendTile className="flex-row items-center gap-4 md:py-4">
              {ring(tile, "dashboard")}
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <TileHeader icon={tile.icon} title={tile.label} titleAs="h3" />
                {tile.line ? (
                  <p
                    data-slot="today-score-line"
                    className="text-muted-foreground text-sm"
                  >
                    {tile.line}
                  </p>
                ) : null}
              </div>
            </TrendTile>
          </Link>
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
            {ring(tile, "compact")}
            <span className="text-foreground text-sm leading-tight font-medium break-words hyphens-auto">
              {tile.label}
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
