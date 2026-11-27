"use client";

/**
 * One score as a tile: the ring, the score's short name, its band word and
 * one meta line, all one link to the score's page.
 *
 * Two sizes on one anatomy:
 *  - `wide` (the start page's score row): the ring beside a `TileHeader`, the
 *    band word and the line, the metric tile's frame and inset;
 *  - `compact` (a row of five or six on Insights): the ring on top, about
 *    80 px, then the name, then the band word and the line, each on one line
 *    at a fixed height, so the tiles of a row line up.
 *
 * The ring's colour is the band and nothing else (concept B,
 * `ring-color.ts`): which score it is, the icon and the name say. A score
 * without a band (`band` undefined) draws in the neutral ink and has no band
 * word; a score that is not about today (`stale`) shows the bare track and
 * no band word, and its line says when the last value was. `ring` replaces
 * the ScoreRing where a tile draws its own dial (the cycle ring).
 */
import type { ComponentType, ReactNode } from "react";
import Link from "next/link";

import { TileHeader } from "@/components/insights/tile-header";
import { TrendTile } from "@/components/ui/trend-tile";
import { cn } from "@/lib/utils";

import type { ScoreBand } from "./band-tokens";
import { ringColor } from "./ring-color";
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
  /** Not about today: the bare track, no band word. */
  stale: boolean;
  /** The band in words ("good", or "low" for a load); null for none. */
  bandWord: string | null;
  /** One line, truncated: the move, the duration, the last value. */
  line: string | null;
  /** Replaces the ScoreRing. */
  ring?: ReactNode;
  /** A load (stress, strain): the ring's spoken band reads high, not low. */
  load?: boolean;
  titleAs?: "h2" | "h3";
}

/**
 * The band word with its fill mark: full for good, half for fair, hollow
 * for low, in the band's colour. Colour is never the only carrier: the mark's
 * fill and the word say the same.
 */
export function BandWord({
  band,
  word,
  className,
}: {
  band: ScoreBand;
  word: string;
  className?: string;
}) {
  const color = ringColor(band);
  return (
    <span
      data-slot="score-band-word"
      data-band={band}
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full border"
        style={{
          borderColor: color,
          background:
            band === "green"
              ? color
              : band === "yellow"
                ? `linear-gradient(90deg, ${color} 50%, transparent 50%)`
                : "transparent",
        }}
      />
      <span className="truncate">{word}</span>
    </span>
  );
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
  bandWord,
  line,
  ring,
  load = false,
  titleAs = "h3",
}: ScoreRingTileProps) {
  const showBand = !stale && score !== null;
  const dial = ring ?? (
    <ScoreRing
      score={stale ? null : score}
      band={band ?? null}
      load={load}
      size={size === "wide" ? "dashboard" : "row"}
      flat
      emptyFace={stale}
      ariaLabel={
        stale || band === undefined
          ? [label, score !== null && !stale ? score : null, line]
              .filter((part) => part !== null && part !== "")
              .join(": ")
          : undefined
      }
    />
  );
  const bandRow = (
    <p
      data-slot="score-ring-tile-band"
      className="text-foreground h-5 min-w-0 text-sm leading-5"
    >
      {showBand && band !== undefined && bandWord ? (
        <BandWord band={band} word={bandWord} />
      ) : (
        <span aria-hidden="true">{" "}</span>
      )}
    </p>
  );
  const lineRow = (
    <p
      data-slot="score-ring-tile-line"
      title={line ?? undefined}
      className={cn(
        "text-muted-foreground truncate leading-5",
        size === "wide" ? "text-sm" : "text-xs",
      )}
    >
      {line ?? " "}
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
            {bandRow}
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
            {bandRow}
            {lineRow}
          </div>
        </TrendTile>
      )}
    </Link>
  );
}
