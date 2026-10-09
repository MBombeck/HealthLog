"use client";

import type { ReactElement, ReactNode } from "react";

/**
 * Apple-Health-style rich tooltip for chart wrappers (B1a v1.4.16).
 *
 * Recharts' default tooltip is a flat list of `name: value` rows. Apple
 * Health paints something denser and friendlier: rounded card with a
 * faint drop shadow, the date on its own row, the metric value in
 * tabular numerals, and an optional sub-line with delta vs. baseline /
 * average. This wrapper renders that layout from a Recharts
 * `TooltipProps.content` callback.
 *
 * Design constraints (per the v1.4.16 brief):
 *   - SSR-safe — no `window` / `document` access. The unit test renders
 *     it via `renderToStaticMarkup`.
 *   - Dracula tokens canonical. The card surface uses `--card`/`--border`
 *     so dark mode + light mode both look right; per-row metric colour
 *     comes from the dot fill the chart already declares.
 *   - The component is dumb — it accepts a fully-shaped payload and
 *     renders. The chart wrappers compute baseline / delta themselves.
 */

export interface RichTooltipRow {
  /** Display name, e.g. "Systolic" or "Mood". */
  name: string;
  /**
   * Already-formatted value string (the chart wrapper applies units +
   * locale formatting). Example: `"128 mmHg"`.
   */
  value: string;
  /** Stroke colour of the corresponding line — used as a left dot. */
  color: string;
  /**
   * Optional second-line annotation for *this* row, e.g.
   * `"+3 mmHg vs. your normal"`. Painted in muted-foreground at 11px.
   */
  delta?: string;
}

export interface RichChartTooltipProps {
  /**
   * Recharts passes `active=true` and a non-empty payload only when the
   * cursor is over a data point. Outside a hover the renderer should
   * paint nothing.
   */
  active?: boolean;
  /** Row label shown at the top of the card — typically a formatted
   *  date string (`"Mon, May 5"`). Empty string hides the row. */
  label?: string;
  /** Already-shaped, sorted rows. The tooltip never re-orders. */
  rows: RichTooltipRow[];
  /**
   * v1.42 — one action under the rows, e.g. "View the whole day" on a touch
   * screen, where the tooltip is pinned by a tap and is the way onward. The
   * chart makes the tooltip take pointer events only when it passes one.
   */
  action?: ReactNode;
}

/**
 * Renders the tooltip card.
 *
 * Style choices that match the Apple Health "Trends" pop-over:
 *   - rounded-xl (matches the surrounding chart card)
 *   - drop-shadow `shadow-lg` for elevation
 *   - tabular-nums on the value cell so digits don't jiggle while
 *     hovering across a horizontal series
 *   - 11px sub-row (delta vs. baseline) keeps the tooltip compact
 */
export function RichChartTooltip({
  active,
  label,
  rows,
  action,
}: RichChartTooltipProps): ReactElement | null {
  if (!active || rows.length === 0) return null;

  return (
    <div
      data-slot="rich-chart-tooltip"
      className="bg-card border-border min-w-[140px] rounded-xl border p-3 text-xs shadow-lg"
      style={{
        // The card itself is layered above the chart's own SVG; without
        // an explicit background the gradient bleeds through the
        // semi-transparent border in Safari.
        backgroundColor: "var(--card)",
        boxShadow:
          "0 6px 20px rgba(0, 0, 0, 0.32), 0 1px 2px rgba(0, 0, 0, 0.16)",
      }}
    >
      {label ? (
        <div
          className="text-muted-foreground mb-1.5 text-[11px] tracking-wide uppercase"
          data-slot="rich-chart-tooltip-label"
        >
          {label}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div
            key={row.name}
            className="flex flex-col"
            data-slot="rich-chart-tooltip-row"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: row.color }}
                />
                <span className="text-foreground/80">{row.name}</span>
              </div>
              <span className="text-foreground tabular-nums">{row.value}</span>
            </div>
            {row.delta ? (
              <span
                className="text-muted-foreground mt-0.5 ml-3.5 text-[11px]"
                data-slot="rich-chart-tooltip-delta"
              >
                {row.delta}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {action ?? null}
    </div>
  );
}
