"use client";

/**
 * One score as a tile: the ring, the score's short name and one meta line,
 * all one link to the score's page.
 *
 * Two sizes on one anatomy:
 *  - `wide` (the start page's score row): the ring beside a `TileHeader` and
 *    the line, the metric tile's frame and inset;
 *  - `compact` (a row of five or six on Insights): the ring on top, about
 *    80 px, then the name, then the line, each on one line at a fixed
 *    height, so the tiles of a row line up.
 *
 * No band word stands next to the ring: its colour and its number say the
 * band, and the ring's accessible name says it in words, so colour is never
 * the only carrier. The colour is the band and nothing else (concept B,
 * `ring-color.ts`): which score it is, the icon and the name say. A score
 * without a band (`band` undefined) draws in the neutral ink; a score that
 * is not about today (`stale`) shows the solid track and a centred "—", and
 * its line reads "not from today"; when the last value was is said in the
 * ring's accessible name and on the score's page. `ring` replaces the ScoreRing where
 * a tile draws its own dial (the cycle ring).
 */
import type { ComponentType, ReactNode } from "react";
import Link from "next/link";

import { TileHeader } from "@/components/insights/tile-header";
import { TrendTile } from "@/components/ui/trend-tile";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import type { ScoreBand } from "./band-tokens";
import { ScoreRing } from "./score-ring";

export interface ScoreRingTileProps {
  size: "wide" | "compact";
  /** The score's id, on `data-score`. */
  id: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  /** The full name: tooltip and accessible name. */
  label: string;
  /** The one-line name the tile shows. */
  shortLabel: string;
  score: number | null;
  /** The score's band; undefined when it carries none (neutral ring). */
  band: ScoreBand | undefined;
  /** Not about today: the solid track, a centred "—", no number. */
  stale: boolean;
  /**
   * One line, truncated: the move, the duration, a device's reading. On a
   * stale tile the line reads "not from today" and this text (when the last
   * value was) moves into the ring's accessible name.
   */
  line: string | null;
  /** Replaces the ScoreRing. */
  ring?: ReactNode;
  /** A load (stress, strain): the ring's spoken band reads high, not low. */
  load?: boolean;
  titleAs?: "h2" | "h3";
}

export function ScoreRingTile({
  size,
  id,
  href,
  icon,
  label,
  shortLabel,
  score,
  band,
  stale,
  line,
  ring,
  load = false,
  titleAs = "h3",
}: ScoreRingTileProps) {
  const { t } = useTranslations();
  const shownLine = stale ? t("insights.derived.scoreRing.notToday") : line;
  const dial = ring ?? (
    <ScoreRing
      score={stale ? null : score}
      band={band ?? null}
      load={load}
      size={size === "wide" ? "dashboard" : "row"}
      flat
      emptyFace={stale}
      ariaLabel={
        // A stale ring names itself ("not from today") and then says when
        // the last value was.
        stale
          ? (line ?? undefined)
          : band === undefined
            ? [label, score, line]
                .filter((part) => part !== null && part !== "")
                .join(": ")
            : undefined
      }
    />
  );
  const lineRow = (
    <p
      data-slot="score-ring-tile-line"
      title={shownLine ?? undefined}
      className={cn(
        "text-muted-foreground truncate leading-5",
        size === "wide" ? "text-sm" : "text-xs",
      )}
    >
      {shownLine ?? " "}
    </p>
  );

  return (
    <Link
      href={href}
      data-slot="score-ring-tile"
      data-size={size}
      data-score={id}
      data-fresh={score !== null && !stale ? "true" : "false"}
      className="focus-visible:ring-ring/50 hover:ring-ring/30 block min-w-0 rounded-xl transition-[box-shadow] hover:ring-2 focus-visible:ring-2 focus-visible:outline-none"
    >
      {size === "wide" ? (
        <TrendTile className="flex-row items-center gap-4 md:py-4">
          {dial}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <TileHeader
              icon={icon}
              title={{ full: label, short: shortLabel }}
              titleAs={titleAs}
              reserveLines={1}
            />
            {lineRow}
          </div>
        </TrendTile>
      ) : (
        <TrendTile className="items-center gap-2 p-3 text-center md:p-4">
          {dial}
          <TileHeader
            icon={icon}
            title={{ full: label, short: shortLabel }}
            titleAs={titleAs}
            reserveLines={1}
            size="sm"
            className="max-w-full justify-center"
          />
          <div className="flex w-full min-w-0 flex-col items-center">
            {lineRow}
          </div>
        </TrendTile>
      )}
    </Link>
  );
}
