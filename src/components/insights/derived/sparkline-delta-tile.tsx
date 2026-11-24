"use client";

import dynamic from "next/dynamic";
import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  getTrendSentiment,
  sentimentColorClass,
  type TrendDirectionSentiment,
} from "@/lib/insights/trend-sentiment";
import { TileHeader } from "@/components/insights/tile-header";
import { TrendTile } from "@/components/ui/trend-tile";

/**
 * v1.10.0 — the Apple-Health-Highlights grid tile.
 *
 * Extends the shipped `trend-card` grammar (label + icon row, big
 * `tabular-nums` value, sentiment-coloured trend arrow) with the single
 * biggest visible grid upgrade the design direction names: an inline
 * Recharts sparkline, a signed period delta, and an age / normal-range
 * framing slot. Reuses the already-imported Recharts (Area sparkline,
 * 40–60px fixed height) — 0 KB new runtime.
 *
 * States, defined up front (no fallback afterthought):
 *  - populated: value + sparkline + delta + framing line
 *  - empty (`value == null`): em-dash, no sparkline, optional framing line
 *  - stale (`staleDays`): "last value Xd ago" caption, value kept visible
 * Fixed footprint so a tile never reflows its neighbours.
 */

// The recharts sparkline body loads through the shared chart-runtime
// boundary so this tile (statically imported by the vitals dashboard)
// carries no recharts in its own chunk group. The tile owns the fixed
// 40 px container, so the async gap is an identically-sized empty band —
// no layout shift, no skeleton needed.
const DeltaSparkline = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.DeltaSparkline,
    })),
  { ssr: false, loading: () => null },
);

export interface SparklineDeltaTileProps {
  label: string;
  /** Latest reading; `null` renders the empty state. */
  value: number | null;
  unit: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Trailing sparkline points (oldest → newest). < 2 points suppresses the
   * sparkline (a line needs at least two). Reuses Recharts, capped to a
   * small fixed height.
   */
  series?: number[];
  /**
   * v1.34.0 — an optional second curve drawn behind `series` on the same
   * axes, index-aligned with it. This is what turns the sparkline into the
   * two-trajectory comparison the same-time baseline needs: today's running
   * total against the person's typical one. Ignored unless it is exactly as
   * long as `series` — two curves of different lengths would be read as
   * aligned when they are not, which is worse than one curve.
   */
  comparisonSeries?: number[];
  /** Accessible name for `comparisonSeries` (e.g. "your typical day"). */
  comparisonLabel?: string;
  /** Signed delta vs the baseline; drives the arrow + the (Δ) caption. */
  delta?: number | null;
  /** Whether an up move is good / bad / neutral for this metric. */
  directionSentiment?: TrendDirectionSentiment;
  /**
   * The age / normal-range framing line (e.g. "typical for age 31",
   * "~5 yrs younger", "within normal range"). Plain text children — no
   * markdown. Rendered muted under the value row.
   */
  framing?: React.ReactNode;
  /** Days since the last reading; > 7 surfaces the stale caption. */
  staleDays?: number | null;
  /** Decimal places for the value + delta. Defaults to 1. */
  precision?: number;
  /**
   * Optional provenance affordance — the `ProvenanceExplainer` ⓘ trigger
   * rendered in the label row so the method + cited standard reach the user
   * on a tile that has no detail page (vitals baseline, HRV, BMI,
   * fitness/vascular age). Plain element children — the caller wires the
   * explainer; the tile just gives it a slot.
   */
  provenance?: React.ReactNode;
  /**
   * Optional quiet footer slot — a discreet pointer (e.g. a `LearnMoreLink`)
   * rendered under the framing row. Plain element children; the caller decides
   * whether a tile carries one, so the dense grid stays uncluttered.
   */
  footer?: React.ReactNode;
  className?: string;
}

export function SparklineDeltaTile({
  label,
  value,
  unit,
  icon: Icon,
  series,
  comparisonSeries,
  comparisonLabel,
  delta = null,
  directionSentiment = "neutral",
  framing,
  staleDays = null,
  precision = 1,
  provenance,
  footer,
  className,
}: SparklineDeltaTileProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const arrowSentiment = getTrendSentiment(delta ?? null, directionSentiment);
  const trendColor = sentimentColorClass(arrowSentiment);

  const TrendIcon = ((): typeof ArrowUp => {
    if (delta == null) return Minus;
    if (Math.abs(delta) < 0.05) return ArrowRight;
    return delta > 0 ? ArrowUp : ArrowDown;
  })();

  const formatDelta = (d: number): string => {
    if (Math.abs(d) < 0.05) return "±0";
    const sign = d > 0 ? "+" : "−";
    return `${sign}${fmt.number(Math.abs(d), precision)}`;
  };

  // The comparison curve only rides along when it lines up point-for-point;
  // a mismatched length would draw two curves that look aligned and are not.
  const paired =
    comparisonSeries && series && comparisonSeries.length === series.length
      ? comparisonSeries
      : null;
  const sparkData =
    series && series.length >= 2
      ? series.map((v, i) => (paired ? { i, v, b: paired[i] } : { i, v }))
      : null;

  // The sparkline tints with the trend sentiment so it reads "same signal"
  // as the arrow; neutral metrics ride the muted-foreground line.
  // Semantic tokens, not raw --dracula-*, so the sparkline tint tracks the
  // AA-safe :root.light overrides on the white card (the band-token fix).
  const strokeVar =
    arrowSentiment === "positive"
      ? "var(--success)"
      : arrowSentiment === "negative"
        ? "var(--warning)"
        : "var(--muted-foreground)";

  return (
    <TrendTile data-slot="sparkline-delta-tile" className={className}>
      {/* The canonical tile-header primitive (was a hand-rolled copy of it):
          leading foreground icon + foreground `CardTitle` heading, provenance
          in the `right` slot. Routing through the primitive keeps this dense
          grid tile from drifting out of the header contract. */}
      <TileHeader
        icon={Icon}
        title={label}
        titleAs="h2"
        reserveLines={2}
        className="min-w-0"
        right={
          provenance ? (
            <span
              data-slot="sparkline-delta-tile-provenance"
              className="shrink-0"
            >
              {provenance}
            </span>
          ) : undefined
        }
      />

      <div
        className="mt-3 flex flex-wrap items-baseline gap-x-1.5"
        data-slot="sparkline-delta-tile-value-row"
      >
        <span
          className="shrink-0 text-3xl leading-none font-semibold tracking-tight whitespace-nowrap tabular-nums"
          data-slot="sparkline-delta-tile-value"
        >
          {value !== null ? fmt.number(value, precision) : "—"}
        </span>
        {/* v1.16.4 — the unit is short, load-bearing metadata ("mmHg",
            "kg") and must never ellipsis ("m…"); on a too-narrow tile
            the row wraps instead (hence `flex-wrap` above). */}
        <span className="text-muted-foreground shrink-0 text-sm whitespace-nowrap tabular-nums">
          {unit}
        </span>
        <span
          className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
          data-slot="sparkline-delta-tile-arrow"
          aria-hidden="true"
        >
          {/* No signal yet: the slot stays empty and keeps its width, so the
              value row lines up across the grid. It never prints a glyph
              of its own; a dash beside the value read as a value. */}
          {delta != null ? (
            <TrendIcon className={cn("h-4 w-4", trendColor)} />
          ) : null}
        </span>
      </div>

      {/* Inline sparkline — fixed 40px height so the tile never reflows.
          When there is no trailing series the row collapses entirely rather
          than reserving an empty dashed placeholder (which read as visual
          dead space across the whole grid). */}
      {sparkData ? (
        <div
          className="mt-3 h-10 w-full"
          data-slot="sparkline-delta-tile-spark"
        >
          <DeltaSparkline
            data={sparkData}
            strokeVar={strokeVar}
            comparisonLabel={comparisonLabel}
          />
        </div>
      ) : null}

      {/* Framing + delta caption row. */}
      <div className="mt-2 flex min-h-[18px] items-baseline justify-between gap-2">
        {framing ? (
          <span
            className="text-muted-foreground min-w-0 flex-1 truncate text-xs leading-snug"
            data-slot="sparkline-delta-tile-framing"
          >
            {framing}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {delta != null && (
          <span
            className={cn(
              "shrink-0 text-xs font-medium tabular-nums",
              trendColor,
            )}
            data-slot="sparkline-delta-tile-delta"
            aria-label={`${formatDelta(delta)} ${unit}`.trim()}
          >
            {formatDelta(delta)}
          </span>
        )}
      </div>

      {staleDays != null && staleDays > 7 && (
        <span
          className="text-muted-foreground mt-1 line-clamp-1 text-xs leading-snug tabular-nums"
          data-slot="sparkline-delta-tile-stale"
          data-stale-days={staleDays}
        >
          {t("dashboard.staleHint", { count: staleDays })}
        </span>
      )}

      {footer ? (
        <div className="mt-2" data-slot="sparkline-delta-tile-footer">
          {footer}
        </div>
      ) : null}
    </TrendTile>
  );
}
