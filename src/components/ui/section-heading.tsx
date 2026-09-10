import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The one heading for a GROUP of cards, app-wide.
 *
 * Every top-level Insights overview section (health scores, daily briefing,
 * vitals, trends, period-in-review, cycle summary, signals of the day) and
 * every Settings card group (notification channels, the health record,
 * integrations) leads with this identical heading ABOVE its cards: a leading
 * Lucide icon and an `<h2>` title, both in the foreground colour (white in
 * dark mode — never a per-section accent hue), at one size + weight. An
 * optional `action` slot pins a trailing affordance (a subtitle, a meta
 * control) to the right edge without breaking the row's alignment.
 *
 * It lives under `ui/` because it is not an Insights component: Settings
 * used to open its groups with a bare `SettingsCardHeader` and no card, which
 * reads as a card title whose card failed to paint. `text-base` here against
 * `text-lg` on a card title is what separates "this labels the group" from
 * "this titles a card".
 *
 * The overview used to mix three heading dialects: a `text-lg` `<h2>` with a
 * purple Sparkles glyph (briefing), a `text-lg` `<h2>` with NO icon (trends),
 * a `text-base` `TileHeader` with a white icon (scores / vitals), and in-card
 * titles buried inside the period-narrative, cycle-summary and signals cards.
 * Side by side they read as four different surfaces. `SectionHeading` pins the
 * single contract so the system can't drift: icon `h-5 w-5 shrink-0
 * text-foreground`, title `<h2>` `text-base font-semibold`, `gap-2` between
 * icon and title. The caller owns the `space-y-3` gap to the card below.
 *
 * RSC-safe: no hooks, no browser API.
 */

interface SectionHeadingProps {
  /**
   * Leading glyph. The caller passes the Lucide component itself
   * (`icon={Sparkles}`), not a pre-sized node — `SectionHeading` owns the
   * size and colour so every overview heading matches.
   */
  icon: ComponentType<{ className?: string }>;
  /** Heading text rendered inside the `<h2>`. */
  title: ReactNode;
  /**
   * Optional one-line description rendered directly under the `<h2>`, in the
   * same muted typography the detail pages use beneath their headings
   * (`text-muted-foreground text-sm`). Opt-in per section so the overview can
   * carry the "descriptive line under every heading" rule without forcing a
   * subtitle where none reads well.
   */
  subtitle?: ReactNode;
  /** Optional trailing affordance pinned to the right edge of the row. */
  action?: ReactNode;
  /** Optional id on the `<h2>`, e.g. for an `aria-labelledby` link. */
  id?: string;
  /**
   * Stable spotlight-tour anchor, rendered as `data-tour-id` on the root.
   * The nav model carries the same field for its entries; a stop whose
   * anchor is a settings group heading names it here.
   */
  tourId?: string;
  className?: string;
}

export function SectionHeading({
  icon: Icon,
  title,
  subtitle,
  action,
  id,
  tourId,
  className,
}: SectionHeadingProps) {
  return (
    <div
      data-slot="section-heading"
      data-tour-id={tourId}
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="text-foreground h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {subtitle ? (
            <p
              data-slot="section-heading-subtitle"
              className="text-muted-foreground text-sm"
            >
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
      {action ? (
        // The action slot must be able to SHRINK. It was `shrink-0`, which
        // pins a flex item at its max-content width — fine for the compact
        // control the slot was designed for, wrong for the prose every real
        // caller passes today (the provenance method caption, the
        // device-score subtitle, the sleep-quality subtitle). A sentence at
        // max-content is ~1.2-1.5k px, and because the row sits inside the
        // AuthShell `<main>` — whose `overflow-y:auto` makes `overflow-x`
        // compute to `auto` — that width became a horizontally scrollable
        // page at every phone width, growing with the locale's string length.
        // `min-w-0` lifts the flex `min-width:auto` floor so the text can wrap
        // to the row width instead. The parent's `flex-wrap` still moves the
        // slot onto its own line before anything is squeezed, so a compact
        // control keeps its size.
        <div className="flex min-w-0 items-center gap-2">{action}</div>
      ) : null}
    </div>
  );
}
