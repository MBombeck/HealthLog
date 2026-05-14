"use client";

import dynamic from "next/dynamic";
import { ArrowDown, ArrowRight, ArrowUp, Gauge, Minus } from "lucide-react";

import { useTranslations, useFormatters } from "@/lib/i18n/context";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";
import type { DataSummary } from "@/lib/analytics/trends";
import { cn } from "@/lib/utils";

/**
 * v1.4.25 W16a — VO2 max chart-row card for `/insights/puls`.
 *
 * The dashboard already carries an opt-in VO2 max trend tile (W8d.5);
 * this is the deeper Insights surface. Renders one HealthChart for the
 * trend plus a compact stat strip:
 *
 *   - latest value with the personalised target unit
 *   - min / max across the underlying samples
 *   - 30-day average and the comparison delta vs. the prior period
 *
 * The card stays mounted even when `summary` reports zero samples — a
 * brand-new account gets the "no data yet" hint rather than a missing
 * surface, matching the dashboard tile's opt-in pattern.
 */

// Mirror the Recharts defer-load + skeleton used by `<TrendsRow>` so the
// VO2 chart-row doesn't blow up the Insights bundle.
const ChartSkeleton = () => (
  <div className="bg-muted/40 h-[220px] w-full animate-pulse rounded-md motion-reduce:animate-none" />
);

const HealthChart = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false, loading: ChartSkeleton },
);

interface Vo2MaxChartRowProps {
  /**
   * Analytics summary for `MeasurementType=VO2_MAX`. Null is allowed so
   * the parent doesn't have to gate on the network read finishing — the
   * row falls back to the empty-state hint until the data lands.
   */
  summary: DataSummary | null;
  /**
   * Comparison baseline propagated from the user's Insights layout pref
   * so the chart's reference line + the in-card delta caption line up.
   */
  compareBaseline?: ComparisonBaseline;
  /** User's IANA timezone string — propagates to HealthChart formatting. */
  userTimezone?: string;
}

export function Vo2MaxChartRow({
  summary,
  compareBaseline = "none",
  userTimezone,
}: Vo2MaxChartRowProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const latest = summary?.latest ?? null;
  const min = summary?.min ?? null;
  const max = summary?.max ?? null;
  const avg30 = summary?.avg30 ?? null;
  const slope30 = summary?.slope30 ?? null;
  const count = summary?.count ?? 0;

  // 30-day delta. Mirrors the dashboard's `tileCompareDelta` rule:
  // suppressed when comparison is off OR either side has no data.
  const compareDelta = ((): number | null => {
    if (!summary || compareBaseline === "none") return null;
    const current = summary.avg30 ?? null;
    const prior =
      compareBaseline === "lastMonth"
        ? (summary.avg30LastMonth ?? null)
        : (summary.avg30LastYear ?? null);
    if (current === null || prior === null) return null;
    return Math.round((current - prior) * 100) / 100;
  })();

  // Higher VO2 max is better → up-good sentiment (mirrors the dashboard
  // tile). Determines arrow + delta colour.
  const TrendIcon =
    slope30?.direction === "up"
      ? ArrowUp
      : slope30?.direction === "down"
        ? ArrowDown
        : slope30
          ? ArrowRight
          : Minus;
  const trendColor = ((): string => {
    if (!slope30 || slope30.direction === "stable")
      return "text-muted-foreground";
    return slope30.direction === "up"
      ? "text-dracula-green"
      : "text-dracula-orange";
  })();

  const formatValue = (value: number | null): string =>
    value === null ? "—" : fmt.number(value, 1);

  const formatDelta = (value: number): string => {
    if (Math.abs(value) < 0.05) return "±0";
    const sign = value > 0 ? "+" : "−";
    return `${sign}${fmt.number(Math.abs(value), 1)}`;
  };

  const unit = t("dashboard.vo2MaxUnit") ?? "mL/(kg·min)";
  const title = t("dashboard.vo2Max") ?? "VO₂ max";
  const hasData = count > 0;

  // Color the comparison delta with the same up-good sentiment rules.
  const compareColor = ((): string => {
    if (compareDelta === null || Math.abs(compareDelta) < 0.05) {
      return "text-muted-foreground";
    }
    return compareDelta > 0 ? "text-dracula-green" : "text-dracula-orange";
  })();

  return (
    <section
      data-slot="vo2-chart-row"
      aria-label={title}
      className="space-y-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Gauge className="text-muted-foreground h-4 w-4" aria-hidden="true" />
          {title}
        </h2>
        <p className="text-muted-foreground text-xs">{unit}</p>
      </div>

      {/* Stat strip — latest / min / max / avg30 / Δ vs. prior period. */}
      <div
        data-slot="vo2-chart-row-stats"
        className="bg-card border-border grid grid-cols-2 gap-3 rounded-xl border p-4 sm:grid-cols-4"
      >
        <div data-slot="vo2-stat" data-stat="latest" className="space-y-1">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            {t("insights.vo2Max.statLatest") ?? "Latest"}
          </p>
          <p className="flex items-baseline gap-1 text-xl font-semibold tabular-nums">
            <span>{formatValue(latest)}</span>
            {slope30 ? (
              <TrendIcon
                className={cn("h-4 w-4 shrink-0", trendColor)}
                aria-hidden="true"
              />
            ) : null}
          </p>
        </div>
        <div data-slot="vo2-stat" data-stat="min" className="space-y-1">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            {t("insights.vo2Max.statMin") ?? "Min"}
          </p>
          <p className="text-xl font-semibold tabular-nums">
            {formatValue(min)}
          </p>
        </div>
        <div data-slot="vo2-stat" data-stat="max" className="space-y-1">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            {t("insights.vo2Max.statMax") ?? "Max"}
          </p>
          <p className="text-xl font-semibold tabular-nums">
            {formatValue(max)}
          </p>
        </div>
        <div data-slot="vo2-stat" data-stat="avg30" className="space-y-1">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            {t("charts.avg30dShort") ?? "30d"}
          </p>
          <p className="text-xl font-semibold tabular-nums">
            {formatValue(avg30)}
          </p>
          {compareDelta !== null ? (
            <p
              data-slot="vo2-compare-delta"
              data-compare-baseline={compareBaseline}
              className={cn(
                "text-xs font-medium tabular-nums",
                compareColor,
              )}
            >
              {`Δ ${formatDelta(compareDelta)} ${t(
                compareBaseline === "lastMonth"
                  ? "comparison.captionLastMonth"
                  : "comparison.captionLastYear",
              )}`}
            </p>
          ) : null}
        </div>
      </div>

      {/* Trend chart. The chartKey isolates per-chart overlay prefs from
          the dashboard VO2 tile and from the pulse chart sitting above
          it on the same page. */}
      {hasData ? (
        <HealthChart
          chartKey="vo2Max"
          types={["VO2_MAX"]}
          title={title}
          colors={["#50fa7b"]}
          unit={unit}
          compareBaseline={compareBaseline}
          userTimezone={userTimezone}
        />
      ) : (
        <p
          data-slot="vo2-chart-row-empty"
          className="text-muted-foreground bg-muted/30 rounded-md border border-dashed p-6 text-center text-sm italic"
        >
          {t("insights.vo2Max.empty") ??
            "No VO₂ max data yet — sync Apple Health to populate this view."}
        </p>
      )}
    </section>
  );
}
