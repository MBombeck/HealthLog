import type { ComponentType, ReactNode } from "react";

import { CardTitle } from "@/components/ui/card";
import { ShortName } from "@/components/ui/short-name";
import type { MetricName } from "@/lib/measurements/type-label-keys";
import { cn } from "@/lib/utils";

/**
 * v1.12.6 — the one canonical tile header used by every Insights tile.
 *
 * Pre-v1.12.6 each tile hand-rolled its own `icon + heading` row at a
 * slightly different size, weight, and colour: the "Einschätzung" card
 * led with a foreground-colour icon + `CardTitle`, the target panel led
 * with a small muted `Target` glyph + a range string, and the stat strip
 * led with a tiny uppercase muted caption. Side-by-side on the same
 * subpage they read as three different card languages.
 *
 * `TileHeader` pins the single header contract to the "Einschätzung"
 * reference (the calmest, most legible of the three): a `flex
 * items-center gap-2` row with the icon and the `CardTitle` BOTH in the
 * foreground colour (white in dark mode) — never `text-muted-foreground`
 * — at `text-base`, icon `h-5 w-5 shrink-0`. An optional `right` slot
 * carries a trailing affordance (a provenance / tooltip glyph, a status
 * pill) without breaking the row's alignment.
 *
 * RSC-safe: no hooks, no browser API, so it renders on the server inside
 * any client or server tile.
 */

interface TileHeaderProps {
  /**
   * Leading glyph. Accepts a Lucide icon component (or any component that
   * takes a `className`) so the caller passes the component itself
   * (`icon={Target}`), not a pre-sized node — `TileHeader` owns the size
   * and colour so every tile header matches. Optional: a text-only tile
   * header (chart cards whose title needs no glyph) omits it and still
   * gets the canonical row + `CardTitle` treatment.
   */
  icon?: ComponentType<{ className?: string }>;
  /**
   * Heading text (or node). Rendered inside a `CardTitle` at `text-base`. A
   * metric's `MetricName` shows its short form, with the full name as the
   * tooltip and as what a screen reader reads, so shortening a heading never
   * shortens what it tells someone who cannot see it.
   */
  title: ReactNode | MetricName;
  /** Optional trailing affordance pinned to the right edge of the row. */
  right?: ReactNode;
  /**
   * The ONE sanctioned compact variant: icon `h-4 w-4`, title `text-sm` —
   * for dense correlation/stat tiles that sit several to a row where the
   * full `text-base` header visually overpowers the tile body. Everything
   * else stays on the default.
   */
  size?: "default" | "sm";
  className?: string;
  /** Optional id on the `CardTitle`, e.g. for an `aria-labelledby` link. */
  id?: string;
  /**
   * Render the title as a real heading element (e.g. `"h2"`) instead of the
   * default presentational `CardTitle` div, keeping the identical CardTitle
   * styling. Use on tiles that sit directly under the page's `h1` — a single
   * owning block (the recovery blocks) or a grid of sibling tiles (dashboard
   * tiles, insights overview grids) both nest correctly as `h1 → h2, h2, …`;
   * just don't nest a `titleAs="h2"` tile inside another heading's own
   * subsection. `"h3"` is the same for a card that sits inside a section
   * which already owns an `h2` (the since-last-visit card under the visits
   * section). Default (unset) keeps every other tile a plain CardTitle.
   */
  titleAs?: "h2" | "h3";
  /**
   * Reserve two title lines at a fixed height, for a tile that sits in a
   * grid row beside others. A title that wraps ("Herzfrequenzvariabilität"
   * on a narrow tile) would otherwise push its value and sparkline below
   * the neighbours' and the row stops reading as one line; with the reserve
   * every tile's body starts at the same height whether its title takes one
   * line or two. A title that would need a third line clamps, with its full
   * text in `title` when it is a string. The dashboard trend strip does the
   * same for its labels (`trend-card.tsx`).
   */
  reserveLines?: 2;
}

export function TileHeader({
  icon: Icon,
  title,
  right,
  size = "default",
  className,
  id,
  titleAs,
  reserveLines,
}: TileHeaderProps) {
  const Heading = titleAs ?? "h2";
  // The title wraps; it never truncates. A tile title is the only thing that
  // says what the number below it is, and German compounds
  // ("Herzfrequenzvariabilität", "Körperfettverteilung") overrun a narrow
  // tile in one word. `min-w-0` lets it shrink beside the icon and the
  // `right` slot, `hyphens-auto` breaks a compound at a syllable (the
  // document's `lang` drives the dictionary) and `break-words` is the floor
  // for a word the dictionary does not know. `leading-tight` keeps a second
  // line clear of the first; on one line it matches the 20 px icon box, so a
  // single-line header is the height it was. There is no class override:
  // every caller used one to add `truncate`.
  const reserve = reserveLines === 2;
  const titleClassNames = cn(
    "min-w-0 leading-tight break-words hyphens-auto",
    size === "sm" ? "text-sm" : "text-base",
    reserve && "line-clamp-2",
  );
  const text = isMetricName(title) ? (
    <ShortName short={title.short} full={title.full} />
  ) : (
    title
  );
  const fullTitle = isMetricName(title)
    ? title.full
    : reserve && typeof title === "string"
      ? title
      : undefined;
  return (
    <div
      data-slot="tile-header"
      data-reserve-lines={reserve ? 2 : undefined}
      className={cn(
        "flex gap-2",
        // Two `leading-tight` lines: 2 × 20 px at `text-base`, 2 × 17.5 px
        // at `text-sm`. The icon then sits on the first line.
        reserve
          ? cn("items-start", size === "sm" ? "h-9" : "h-10")
          : "items-center",
        className,
      )}
    >
      {/* Icon and heading share the foreground colour — the calm,
          high-contrast read the "Einschätzung" card established. */}
      {Icon ? (
        <Icon
          className={cn(
            "text-foreground shrink-0",
            size === "sm" ? "h-4 w-4" : "h-5 w-5",
            reserve && size === "sm" && "mt-px",
          )}
          aria-hidden="true"
        />
      ) : null}
      {titleAs ? (
        // Heading semantics with the exact CardTitle visual treatment so the
        // tile can carry a real heading where it owns one.
        <Heading
          id={id}
          data-slot="card-title"
          title={fullTitle}
          className={cn("font-semibold", titleClassNames)}
        >
          {text}
        </Heading>
      ) : (
        <CardTitle id={id} title={fullTitle} className={titleClassNames}>
          {text}
        </CardTitle>
      )}
      {right ? <div className="ml-auto flex items-center">{right}</div> : null}
    </div>
  );
}

function isMetricName(title: ReactNode | MetricName): title is MetricName {
  return (
    typeof title === "object" &&
    title !== null &&
    "short" in title &&
    "full" in title
  );
}
