"use client";

/**
 * One score as a tile: the ring, the score's short name and one line that
 * says how it stands, all one link to the score's page. Shared by the start
 * page and the Insights head, so a score looks the same in both places.
 *
 * `compact`: the ring on top, the name and the line centred under it, for a
 * row of five or six tiles of equal width. `wide`: the ring beside the name
 * and the line, for a row of three.
 *
 * The ring's colour is the band, never the score's own hue; a ring without
 * a band (a device value, a value that is not fresh) has none. A value that
 * is not fresh draws the bare track and no number, and its line says when
 * the last one was. A tile always carries its line, so a row of tiles reads
 * the same from left to right.
 */
import type { ComponentType, ReactNode } from "react";
import Link from "next/link";

import { TileHeader } from "@/components/insights/tile-header";
import { TrendTile } from "@/components/ui/trend-tile";
import { cn } from "@/lib/utils";

import type { ScoreBand } from "./band-tokens";
import { ScoreRing } from "./score-ring";

export interface ScoreRingTileProps {
  size: "wide" | "compact";
  /** The score's id, on `data-score`. */
  id: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** The name in a compact tile. */
  shortLabel: string;
  /** Null: no number (not fresh, or not enough data yet). */
  score: number | null;
  /** Null: the value has no band (a device's own number); the ring is neutral. */
  band: ScoreBand | null | undefined;
  /** A past value exists: the bare track instead of the provisional dash. */
  stale: boolean;
  /** The band in words; null without a band. */
  bandWord: string | null;
  /** The one line under the name. Falls back to the band word. */
  line: string | null;
  /** A dial other than the 0..100 score ring (the cycle). */
  ring?: ReactNode;
  /** The ring's accessible name, when the default would say the wrong thing. */
  ariaLabel?: string;
  /** A load (stress, strain): lower is better. */
  load?: boolean;
  titleAs?: "h2" | "h3";
  /** Stagger of the reveal (ms); null paints the final ring at once. */
  revealDelayMs?: number | null;
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
  ariaLabel,
  load = false,
  titleAs = "h3",
  revealDelayMs = null,
}: ScoreRingTileProps) {
  const text = line ?? bandWord;
  const dial = ring ?? (
    <ScoreRing
      score={score}
      band={band}
      load={load}
      size="tile"
      className={size === "compact" ? "md:size-20" : undefined}
      animate={revealDelayMs !== null}
      delayMs={revealDelayMs ?? 0}
      flat={revealDelayMs === null}
      emptyFace={stale}
      ariaLabel={
        ariaLabel ??
        (score === null && stale
          ? [label, text].filter(Boolean).join(": ")
          : undefined)
      }
    />
  );
  return (
    <Link
      href={href}
      data-slot="score-ring-tile"
      data-size={size}
      data-score={id}
      data-fresh={score !== null ? "true" : "false"}
      className="focus-visible:ring-ring/50 hover:ring-ring/30 block h-full min-w-0 rounded-xl transition-[box-shadow] hover:ring-2 focus-visible:ring-2 focus-visible:outline-none"
    >
      <TrendTile
        className={cn(
          size === "compact"
            ? "items-center gap-3 p-3 text-center md:p-4"
            : "flex-row items-center gap-4 md:py-4",
        )}
      >
        {dial}
        <div
          className={cn(
            "flex w-full min-w-0 flex-col gap-1",
            size === "compact" ? "items-center" : "flex-1",
          )}
        >
          {/* A compact tile names its score under the ring without the
              glyph, as the dashboard's narrow face does: five or six to a
              row, the glyph would push a German compound onto two lines. */}
          <TileHeader
            icon={size === "compact" ? undefined : icon}
            size={size === "compact" ? "sm" : "default"}
            title={size === "compact" ? shortLabel : label}
            titleAs={titleAs}
            className={size === "compact" ? "max-w-full" : undefined}
          />
          {/* One line in every tile, also when empty, so names and lines
              stand at the same heights across the row. */}
          <p
            data-slot="score-ring-tile-line"
            title={text ?? undefined}
            className="text-muted-foreground w-full truncate text-xs leading-5"
          >
            {text ?? " "}
          </p>
        </div>
      </TrendTile>
    </Link>
  );
}
