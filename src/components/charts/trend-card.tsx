"use client";

import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import type { TrendSlope } from "@/lib/analytics/trends";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";

interface SecondaryMetric {
  /** Sub-value latest reading (e.g. diastolic when latest is systolic). */
  latest: number | null;
  avg7: number | null;
  avg30: number | null;
}

/**
 * Maps a metric's "up means" direction to colour sentiment for the small
 * trend arrow on each tile. v1.4.6 P4 stripped the colour entirely after
 * the original up=red / down=green mapping was wrong for half the metrics
 * (mood up = good, BP up = bad, pulse up = neutral). v1.5 phase-5 restores
 * the colour but per-metric:
 *
 *   - `up-good`   — higher value is better (mood, sleep hours, steps).
 *                   ↑ green, ↓ orange.
 *   - `up-bad`    — higher value is worse (BP, weight, body fat).
 *                   ↑ orange, ↓ green.
 *   - `neutral`   — direction doesn't carry a value judgement (pulse,
 *                   "BP in target %" — those have their own range
 *                   colouring on the avg7/avg30 numbers already).
 *
 * Strictly affects the ↑/↓/→ arrow next to the latest reading. Chart
 * lines, axes, and the avg7/avg30 colour classes are untouched.
 */
export type TrendDirectionSentiment = "up-good" | "up-bad" | "neutral";

interface TrendCardProps {
  label: string;
  latest: number | null;
  unit: string;
  avg7: number | null;
  avg30: number | null;
  avg7ColorClass?: string;
  avg30ColorClass?: string;
  avg7Hint?: React.ReactNode;
  avg30Hint?: React.ReactNode;
  slope30: TrendSlope | null;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Whether an upward slope is good, bad, or neutral for this metric.
   * Defaults to `"neutral"` so existing call sites that haven't been
   * updated keep the v1.4.6 behaviour (muted-foreground arrow).
   */
  directionSentiment?: TrendDirectionSentiment;
  /** Optional second value rendered next to the primary as `X / Y` (used for
   *  paired metrics like blood-pressure systolic/diastolic so a single tile
   *  shows both numbers). */
  secondary?: SecondaryMetric;
  /**
   * v1.4.15 Fix 4 — 7-day trend delta. When provided, the avg7 line
   * shows a signed delta (e.g. "+1.2 kg") next to the average and the
   * label switches from `charts.avg7dShort` (just "7d") to
   * `charts.trend7dShort` ("7d trend"). Color of the delta follows the
   * same `directionSentiment` rules as the headline arrow:
   *   - up-good metric, positive delta → green
   *   - up-bad metric, positive delta → orange
   *   - neutral metric → muted regardless of sign
   *
   * Pass `null` (default) to keep the legacy avg-only behaviour for
   * call sites that haven't been migrated yet.
   */
  trend7Delta?: number | null;
  /**
   * v1.4.16 phase B8 — comparison delta callout. When the dashboard's
   * comparison toggle is active and we can compute a baseline value,
   * the tile renders a "Δ −2.3 kg vs. last month" caption on a second
   * line below the latest value. Color follows the same metric-aware
   * sentiment rules as the headline arrow + 7d delta.
   *
   * `compareBaseline === "none"` or `compareDelta === null` keeps the
   * tile rendering exactly as before (regression guard).
   */
  compareBaseline?: ComparisonBaseline;
  compareDelta?: number | null;
}

export function TrendCard({
  label,
  latest,
  unit,
  avg7,
  avg30,
  avg7ColorClass,
  avg30ColorClass,
  avg7Hint,
  avg30Hint,
  slope30,
  icon: Icon,
  directionSentiment = "neutral",
  secondary,
  trend7Delta = null,
  compareBaseline = "none",
  compareDelta = null,
}: TrendCardProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const TrendIcon =
    slope30?.direction === "up"
      ? ArrowUp
      : slope30?.direction === "down"
        ? ArrowDown
        : slope30
          ? ArrowRight
          : Minus;

  // v1.5: per-metric arrow sentiment. Flat ("→") and "no slope yet" ("—")
  // always stay muted; only an actual rise / fall paints colour, and the
  // colour direction depends on what's good for *this* metric. The
  // `text-muted-foreground` default keeps every metric tagged `neutral`
  // (pulse, BP-in-target %) visually identical to v1.4.6.
  const trendColor = ((): string => {
    // No data yet (Minus icon) or a "stable" slope (ArrowRight) stays muted —
    // we don't celebrate or scold a flat metric.
    if (!slope30 || slope30.direction === "stable") {
      return "text-muted-foreground";
    }
    if (directionSentiment === "neutral") return "text-muted-foreground";
    const isUp = slope30.direction === "up";
    const isGood =
      (directionSentiment === "up-good" && isUp) ||
      (directionSentiment === "up-bad" && !isUp);
    return isGood ? "text-dracula-green" : "text-dracula-orange";
  })();

  const formatValue = (value: number) => fmt.number(value, 1);

  // v1.4.15 Fix 4 — color the 7-day delta with the same metric-aware
  // sentiment rules the headline arrow already uses. Tiny absolute
  // deltas (< 0.05) read as "no movement" and stay muted.
  const deltaColor = ((): string => {
    if (trend7Delta == null || Math.abs(trend7Delta) < 0.05) {
      return "text-muted-foreground";
    }
    if (directionSentiment === "neutral") return "text-muted-foreground";
    const isUp = trend7Delta > 0;
    const isGood =
      (directionSentiment === "up-good" && isUp) ||
      (directionSentiment === "up-bad" && !isUp);
    return isGood ? "text-dracula-green" : "text-dracula-orange";
  })();

  /**
   * v1.4.16 phase B8 — color the comparison delta with the same
   * metric-aware sentiment rules used everywhere else on the tile.
   * Tiny deltas read as stable and stay muted.
   */
  const comparisonDeltaColor = ((): string => {
    if (compareDelta == null || Math.abs(compareDelta) < 0.05) {
      return "text-muted-foreground";
    }
    if (directionSentiment === "neutral") return "text-muted-foreground";
    const isUp = compareDelta > 0;
    const isGood =
      (directionSentiment === "up-good" && isUp) ||
      (directionSentiment === "up-bad" && !isUp);
    return isGood ? "text-dracula-green" : "text-dracula-orange";
  })();

  const formatDelta = (value: number): string => {
    if (Math.abs(value) < 0.05) return `±0`;
    const sign = value > 0 ? "+" : "−";
    return `${sign}${fmt.number(Math.abs(value), 1)}`;
  };

  // The label flips from "7d" / "7T" (mean) to "7d trend" / "7T-Trend"
  // when the call site supplies a delta. the maintainer's v1.4.15 feedback —
  // "7-Tage-Schnitt" sounds like an average, but the value next to it
  // is now a TREND. Distinct keys keep the label change in i18n.
  const avg7LabelKey =
    trend7Delta != null ? "charts.trend7dShort" : "charts.avg7dShort";

  const renderPair = (
    primary: number | null,
    secondaryValue: number | null | undefined,
  ): string => {
    if (primary === null) return "—";
    if (secondary && secondaryValue !== null && secondaryValue !== undefined) {
      return `${formatValue(primary)}/${formatValue(secondaryValue)}`;
    }
    return formatValue(primary);
  };

  return (
    <div className="bg-card border-border flex h-full w-full min-w-0 flex-col rounded-xl border p-4 md:p-6">
      {/* v1.4.25 W20a — single-line discipline + deterministic height for
          the heading row so the value row below sits at the same baseline
          across every tile. The label is locale-abbreviated upstream (see
          `dashboard.*Short` keys) so `truncate` is a layout safeguard
          rather than the primary defence against wraps. `h-5` matches
          `text-xs leading-5` ≈ 20 px; identical across every tile. */}
      <div className="flex h-5 min-w-0 items-center justify-between gap-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate text-xs leading-5 font-medium tracking-wide whitespace-nowrap uppercase"
          data-slot="trend-card-label"
        >
          {label}
        </span>
        <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
      </div>
      {/* v1.4.25 W20a — baseline-aligned value row. The headline value,
          unit, and trend arrow share a single flex line with
          `items-baseline` so the digits line up at the same y-coordinate
          across every tile in the strip (Weight 80 kg vs. BP 122 mmHg used
          to land at different heights when one tile had a one-line heading
          and another had a two-line wrap). The arrow slot is always
          present — when there is no slope yet, a muted "—" placeholder
          renders so the value row keeps a deterministic width. Marc's
          ask: "rechts neben der Zahl … der Pfeil [ist], wie gerade der
          Trend ist". */}
      <div
        className="mt-2 flex min-w-0 items-baseline gap-x-1.5"
        data-slot="trend-card-value-row"
      >
        <span className="min-w-0 truncate text-3xl leading-none font-semibold tracking-tight tabular-nums">
          {latest !== null ? renderPair(latest, secondary?.latest) : "—"}
        </span>
        <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
          {unit}
        </span>
        <span
          className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
          data-slot="trend-card-arrow"
          aria-hidden="true"
        >
          {slope30 ? (
            <TrendIcon className={`h-4 w-4 ${trendColor}`} />
          ) : (
            <span className="text-muted-foreground text-xs opacity-30">—</span>
          )}
        </span>
      </div>
      {/* v1.4.16 phase B8 — comparison delta callout. Sits on its own
          line below the latest value so the tile stays scannable on
          mobile viewports (no horizontal-scroll, no overlap with the
          existing 7d/30d row). Suppressed when comparison is off OR
          we don't have enough data to compute a delta.

          v1.4.22 W5 reconcile (Design-H2) — on `<sm` viewports the
          BP-in-target tile (the only consumer of `avgAllTime`) packs
          three sub-rows + this callout into the height budget of
          every other tile. Hide the standalone callout at `<sm` for
          BP-in-target tiles; the secondary row below combines
          all-time + comparison-delta into a single line that stays
          scannable on Galaxy Fold (280 px) and Pixel 5 (375 px). The
          full layout returns at `>=sm`. */}
      {/* v1.4.27 MB7 / CF-41 — the `hidden sm:block` gate retired
          because the mobile-secondary block below is gone (CF-67
          vestigial wrapper drop). The callout paints on every
          viewport; when the parent grid is tight on `<sm`, the
          flex-wrap on the sibling row + this callout's `mt-1`
          horizontal-row layout absorb the overflow without crowding
          the headline value above. */}
      {/* v1.4.29 — clamp the callout to one line at `<sm` so the
          tile's overall height stays inside the 140-px contract.
          `min-h-[18px]` reserves the slot when no callout is being
          rendered so the sub-row pair below pins to the same y
          across every tile. `sm:` releases both bounds. */}
      <div className="mt-1 min-h-[18px] sm:min-h-0">
        {compareBaseline !== "none" && compareDelta != null && (
          <span
            className={cn(
              "line-clamp-1 inline-block max-w-full text-xs leading-snug font-medium tabular-nums sm:line-clamp-none sm:[overflow-wrap:anywhere]",
              comparisonDeltaColor,
            )}
            data-slot="tile-compare-delta"
            data-compare-baseline={compareBaseline}
            aria-label={`${formatDelta(compareDelta)}${unit ? ` ${unit}` : ""} ${t(
              compareBaseline === "lastMonth"
                ? "comparison.captionLastMonth"
                : "comparison.captionLastYear",
            )}`}
          >
            {`Δ ${formatDelta(compareDelta)}${unit ? ` ${unit}` : ""} ${t(
              compareBaseline === "lastMonth"
                ? "comparison.captionLastMonth"
                : "comparison.captionLastYear",
            )}`}
          </span>
        )}
      </div>
      <TooltipProvider>
        {/* v1.4.29 — sub-row pair clips rather than wraps at `<sm`
            so a narrow tile cannot grow vertically beyond the
            140-px contract. `sm:` releases back to the original
            wrap behaviour. */}
        <div className="text-muted-foreground mt-auto flex min-w-0 flex-nowrap items-baseline gap-x-3 overflow-hidden pt-1 text-xs leading-snug sm:flex-wrap sm:gap-y-1">
          <span className="max-w-full min-w-0 [overflow-wrap:anywhere]">
            {t(avg7LabelKey)}:{" "}
            {avg7Hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "font-medium [overflow-wrap:anywhere] tabular-nums",
                      avg7ColorClass,
                    )}
                  >
                    {avg7 !== null ? renderPair(avg7, secondary?.avg7) : "—"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="bg-muted border-border text-foreground">
                  <div className="space-y-1 text-xs">{avg7Hint}</div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span
                className={cn(
                  "font-medium [overflow-wrap:anywhere] tabular-nums",
                  avg7ColorClass,
                )}
              >
                {avg7 !== null ? renderPair(avg7, secondary?.avg7) : "—"}
              </span>
            )}
            {trend7Delta != null && (
              <span
                className={cn(
                  "ml-1 font-medium [overflow-wrap:anywhere] tabular-nums",
                  deltaColor,
                )}
                data-slot="trend7-delta"
                aria-label={`7-day trend ${formatDelta(trend7Delta)}`}
              >
                ({formatDelta(trend7Delta)})
              </span>
            )}
          </span>
          <span className="max-w-full min-w-0 [overflow-wrap:anywhere]">
            {t("charts.avg30dShort")}:{" "}
            {avg30Hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "font-medium [overflow-wrap:anywhere] tabular-nums",
                      avg30ColorClass,
                    )}
                  >
                    {avg30 !== null ? renderPair(avg30, secondary?.avg30) : "—"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="bg-muted border-border text-foreground">
                  <div className="space-y-1 text-xs">{avg30Hint}</div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span
                className={cn(
                  "font-medium [overflow-wrap:anywhere] tabular-nums",
                  avg30ColorClass,
                )}
              >
                {avg30 !== null ? renderPair(avg30, secondary?.avg30) : "—"}
              </span>
            )}
          </span>
          {/* v1.4.28 FB-C2 — the all-time third sub-value retired
              alongside the `avgAllTime*` props. The BD-Zielbereich
              tile was the only consumer; the same number stays
              visible on the `/targets` Blutdruck card with full
              context. Every dashboard tile now ships the same two
              sub-rows. */}
        </div>
      </TooltipProvider>
    </div>
  );
}
