"use client";

import type { ComponentType, ReactNode } from "react";
import { Sigma } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import type { DataSummary } from "@/lib/analytics/trends";
import type { MetricWindowStats } from "@/lib/charts/window-stats";

/**
 * v1.8.5 — at-a-glance stat strip for the insights category pages.
 *
 * Leads each metric page with the four central statistics — min / max /
 * median / mean — read straight from the already-fetched `summaries`
 * slice (`useInsightsAnalytics`). Zero new network: the layout shell and
 * the empty-state gate already warm the `["analytics", "summaries"]`
 * cache, so the strip is a pure render of cached numbers. This is the
 * numbers-first header Apple Health / Withings / Oura lead their detail
 * screens with — the single biggest "data-rich" lift per unit effort.
 *
 * Median sits alongside mean on purpose: a series with a handful of very
 * high or very low readings drags the mean away from the typical value,
 * and showing both makes that skew legible rather than hidden.
 *
 * The thin HealthKit pages (`HealthkitMetricPage`) mount this too so they
 * reach parity with the bespoke pages — a rich numeric header even where
 * there is no target band or AI assessment.
 *
 * v1.12.7 follow-up — two render modes:
 *   - single-series (default): one Card, one `<TileHeader>` + 4-stat grid.
 *   - multi-series (`series=[…]`): ONE Card with the series side by side
 *     (two columns on desktop, stacking on narrow mobile). Blood pressure
 *     uses this so systolic + diastolic share a single card rather than
 *     stacking two. Each column keeps its own header, its own four stats,
 *     and its own brushed-window behaviour.
 *
 * The card chrome is tightened from the earlier `py-5 / gap-3 / min-h-56px`
 * to a denser rhythm so the numbers-first header gives away less vertical
 * space on every subpage without dropping below a readable value size or
 * the AA-contrast micro-labels.
 */

/**
 * One series rendered inside the strip — its header (label + icon), the
 * full-range `summary`, and the optional brushed-window stats. Single-series
 * callers pass these props at the top level; multi-series callers pass an
 * array of these via `series`.
 */
export interface MetricStatSeries {
  /**
   * Analytics summary for the series' `MeasurementType`. Null is allowed
   * so the parent doesn't have to gate on the network read finishing — the
   * series simply doesn't paint until the data lands. A zero-count summary
   * (brand-new metric) also renders nothing.
   */
  summary: DataSummary | null;
  /** Unit suffix rendered next to each value (e.g. `bpm`, `kg`, `mmHg`). */
  unit: string;
  /**
   * Decimal precision for the formatted values. Defaults to 1 — enough
   * for weight (78.4) and HRV (41.5) without trailing noise on integer
   * metrics, which `Intl.NumberFormat` drops anyway.
   */
  fractionDigits?: number;
  /**
   * Series caption rendered through the canonical `<TileHeader>` (white
   * heading + white icon). Single-series metrics pass the metric name;
   * blood pressure labels each half (systolic / diastolic).
   */
  seriesLabel?: string;
  /**
   * Leading glyph for the series `<TileHeader>`. Defaults to a generic
   * stats glyph so a caller that supplies a `seriesLabel` without an icon
   * still renders a complete header.
   */
  icon?: ComponentType<{ className?: string }>;
  /**
   * v1.12.7 — chart-reactive metric statistics. When the user brushes a
   * window in the metric's chart, the sub-page lifts the chart's per-series
   * Min / Max / Median / Mean for that window and threads it here. When
   * present (non-null) it renders in place of the full-range `summary` and
   * the header pins a "selected range" pill. Null falls back to the
   * precomputed `summary`.
   */
  windowStats?: MetricWindowStats | null;
  /**
   * Stable suffix for the per-cell `data-slot`s. Multi-series mode passes a
   * distinct token per column (e.g. the unit or label slug) so the two
   * columns' cells don't collide on `[data-stat="min"]` in e2e. Optional;
   * single-series mode omits it.
   */
  dataKey?: string;
  /**
   * v1.16.16 — optional override for the "Median" cell label. The median
   * cell follows the chart's ACTIVE range (`windowStats`) when a range is
   * selected and only falls back to the full-range `summary` p50 otherwise,
   * so the label must NOT assert a fixed day-count it can't honor. Blood
   * glucose passes a metric-naming string (e.g. "Median glucose") so the
   * number reads as that metric's median for the visible range, not an
   * all-time central value. Omit it to keep the generic label.
   */
  medianLabel?: string;
  /**
   * v1.28.4 — optional descriptive line rendered INSIDE the tile, directly
   * under the `<TileHeader>` and above the four-stat grid. Lets a metric block
   * own its heading + blurb in a single tile rather than duplicating the
   * heading in an outer section above it. Muted supporting copy; omit it for
   * the numbers-only header the other subpages lead with.
   */
  description?: ReactNode;
  /**
   * Render the series' `<TileHeader>` title as a real heading element (e.g.
   * "h2") rather than the presentational `CardTitle` div. Used where the tile
   * carries the ONLY heading on its subpage branch (the recovery blocks) so the
   * `h1 → h2` outline under `SubPageShell` stays nested with no skipped level.
   */
  titleAs?: "h2";
}

type MetricStatStripProps = Partial<MetricStatSeries> & {
  /**
   * v1.12.7 — multi-series mode. When supplied, the strip renders ONE Card
   * with each entry as a side-by-side column (two columns on desktop,
   * stacking on narrow mobile). The top-level `summary` / `unit` /
   * `seriesLabel` / … props are ignored. `aria-label` then describes the
   * group; pass `groupLabel` for the accessible name.
   *
   * Single-series callers MUST still pass `summary` + `unit` at the top
   * level (the contract the ~30 HealthKit pages + the weight/pulse/… pages
   * rely on); they are optional in the type only so multi-series callers can
   * omit them, and the single-series branch self-gates on a missing
   * `summary` by rendering nothing.
   */
  series?: MetricStatSeries[];
  /**
   * Accessible name for the multi-series group (e.g. "Blood pressure").
   * Single-series mode derives the label from `seriesLabel` instead.
   */
  groupLabel?: string;
  /**
   * The read behind the summary is still in flight. The strip then holds its
   * place with a card of the same anatomy instead of painting nothing: it
   * sits at the top of the sub-page, so arriving later pushed the read strip,
   * the chart and everything below it down the page.
   */
  pending?: boolean;
};

/**
 * Render one series' four stats. Self-gates: returns null while the
 * summary is in flight or for a zero-count metric. The brushed-window
 * source wins over the full-range summary when a selection is active.
 */
function SeriesBlock({
  summary,
  unit,
  fractionDigits = 1,
  seriesLabel,
  icon,
  windowStats,
  dataKey,
  medianLabel,
  description,
  titleAs,
}: MetricStatSeries) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  // Nothing to show until the summary lands or for a metric with no
  // readings. The gate rides the full-range summary even when the chart
  // reports a narrower visible range, so a range change never resurrects a
  // series that has no data at all.
  if (!summary || summary.count <= 0) return null;

  // v1.12.8 — the chart reports stats for the data under its active range tab;
  // when present those visible-range numbers win over the full-range summary
  // so the strip always reads the same window the chart paints. No pill — the
  // chart's range tab is the single, visible selector for both.
  const windowed = windowStats != null && windowStats.count > 0;
  const source = windowed ? windowStats : summary;

  const format = (value: number | null): string =>
    value === null ? "—" : `${fmt.number(value, fractionDigits)} ${unit}`;

  const cells: Array<{ key: string; label: string; value: number | null }> = [
    { key: "min", label: t("insights.subPage.stats.min"), value: source.min },
    { key: "max", label: t("insights.subPage.stats.max"), value: source.max },
    {
      key: "median",
      label: medianLabel ?? t("insights.subPage.stats.median"),
      value: source.median,
    },
    {
      key: "mean",
      label: t("insights.subPage.stats.mean"),
      value: source.mean,
    },
  ];

  return (
    <div
      data-slot="metric-stat-series"
      data-series={dataKey}
      data-windowed={windowed ? "true" : undefined}
      className="space-y-1.5"
    >
      {seriesLabel ? (
        <TileHeader
          icon={icon ?? Sigma}
          title={seriesLabel}
          titleAs={titleAs}
        />
      ) : null}
      {description ? (
        <p className="text-foreground text-sm leading-relaxed">{description}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4 [&>div]:min-h-[44px]">
        {cells.map((cell) => (
          <div
            key={cell.key}
            data-slot="metric-stat"
            data-stat={cell.key}
            className="space-y-0.5"
          >
            <p className="text-muted-foreground text-xs tracking-wide uppercase">
              {cell.label}
            </p>
            <p className="text-base font-semibold tabular-nums">
              {format(cell.value)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MetricStatStrip({
  summary,
  unit,
  fractionDigits,
  seriesLabel,
  icon,
  windowStats,
  dataKey,
  medianLabel,
  description,
  titleAs,
  series,
  groupLabel,
  pending = false,
}: MetricStatStripProps) {
  const { t } = useTranslations();

  if (pending) {
    return <MetricStatStripSkeleton seriesCount={series?.length ?? 1} />;
  }

  // v1.12.7 — multi-series mode: ONE Card, columns side by side. The card
  // self-gates to nothing only when EVERY series is empty so a one-sided
  // metric (e.g. only systolic logged) still paints its half.
  if (series && series.length > 0) {
    const anyData = series.some((s) => s.summary && s.summary.count > 0);
    if (!anyData) return null;
    return (
      <Card
        data-slot="metric-stat-strip"
        data-multi-series="true"
        role="group"
        aria-label={groupLabel ?? t("insights.subPage.stats.label")}
        className="gap-2 py-3 md:py-4"
      >
        <CardContent>
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
            {series.map((s, i) => (
              <SeriesBlock key={s.dataKey ?? s.seriesLabel ?? i} {...s} />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Single-series mode (default, unchanged contract). Gate on the one
  // series' summary so a null / zero-count read paints nothing.
  if (!summary || summary.count <= 0) return null;

  return (
    // Card-wrapped so the header-to-body offset matches the sibling tiles
    // on the same subpage spine (assessment, mood, medication). The series
    // header now lives inside `SeriesBlock`, so the Card carries body chrome
    // only.
    <Card
      data-slot="metric-stat-strip"
      data-windowed={
        windowStats != null && windowStats.count > 0 ? "true" : undefined
      }
      role="group"
      aria-label={
        seriesLabel
          ? `${t("insights.subPage.stats.label")} — ${seriesLabel}`
          : t("insights.subPage.stats.label")
      }
      className="gap-2 py-3 md:py-4"
    >
      <CardContent>
        <SeriesBlock
          summary={summary}
          unit={unit ?? ""}
          fractionDigits={fractionDigits}
          seriesLabel={seriesLabel}
          icon={icon}
          windowStats={windowStats}
          dataKey={dataKey}
          medianLabel={medianLabel}
          description={description}
          titleAs={titleAs}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Layout-stable loading shell for the stat strip: the loaded card's chrome
 * (compact rhythm, a header row, a four-up grid per series, two series side
 * by side from `md`) so the page does not jump when the read lands.
 * Decorative — hidden from assistive tech; the chart skeleton below carries
 * the busy announcement.
 */
export function MetricStatStripSkeleton({
  seriesCount = 1,
}: {
  seriesCount?: number;
}) {
  return (
    <Card
      data-slot="metric-stat-strip-skeleton"
      aria-hidden="true"
      className="gap-2 py-3 md:py-4"
    >
      <CardContent>
        <div
          className={
            seriesCount > 1
              ? "grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2"
              : undefined
          }
        >
          {Array.from({ length: Math.max(1, seriesCount) }).map((_, s) => (
            <div key={s} className="space-y-1.5">
              {/* h-6: the TileHeader row is one 24 px line. */}
              <Skeleton className="h-6 w-32" />
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((__, i) => (
                  <div key={i} className="min-h-[44px] space-y-1">
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="h-5 w-16" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
