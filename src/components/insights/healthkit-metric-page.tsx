"use client";

import Link from "next/link";
import type { ComponentProps, ComponentType, ReactNode } from "react";

import { RefreshCw, Sparkles } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { useChartDomainStats } from "@/hooks/use-chart-domain-stats";
import { useTranslations } from "@/lib/i18n/context";
import type { InsightMetric } from "@/lib/insights/metric-availability";
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";
import type { ChartOverlayKey } from "@/lib/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { MetricStatusCard } from "@/components/insights/metric-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { CoachReadStrip } from "@/components/insights/derived/coach-read-strip";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.4.32 — shared scaffold for the wave-A HealthKit metric pages.
 *
 * Each of the five new metric sub-pages (HRV, resting HR, oxygen
 * saturation, body temperature, active energy) shares the same
 * envelope:
 *
 *   1. `<SubPageShell>` with a localised title + description.
 *   2. Optional empty-state CTA when the user has no observations for the
 *      metric — points at `/measurements?add=<TYPE>` so the existing
 *      quick-entry dialog can light up. Device-led empty states may omit it
 *      even when the populated page offers manual contextual capture.
 *   3. `<HealthChartDynamic>` mounted on the canonical
 *      `ChartOverlayKey` so the chart-cog popover persists per metric.
 *   4. A header-height Coach launch icon (`coachLaunch` on the shell) —
 *      feature-flag gating runs inside the button so this scaffold stays
 *      agnostic.
 *
 * Adding a new metric is a four-line page module that hands the right
 * Zod / MeasurementType + ChartOverlayKey + i18n-key prefix to this
 * component; the template stays single-source-of-truth.
 */

export interface HealthKitMetricPageProps {
  /** The MeasurementType that backs the chart. */
  measurementType: string;
  /**
   * v1.17.0 — optional secondary MeasurementType the page falls back to
   * when the primary type has no rows but the fallback does. Used by HRV:
   * the primary `HEART_RATE_VARIABILITY` (SDNN, Apple / Fitbit) is empty
   * for a ring / strap user whose nightly HRV is stored as `HRV_RMSSD`
   * (Oura / Polar / WHOOP). When the swap is active the chart, stat strip,
   * "all values" list, and diversity nudge key off the fallback type and
   * `fallbackMeasureLabel` names the measure so the two are never silently
   * merged. Omit it and every other page renders byte-identically.
   */
  fallbackMeasurementType?: string;
  /**
   * v1.17.0 — short label naming the fallback measure (e.g. "RMSSD") shown
   * beneath the chart title when the fallback series is active, so the user
   * sees which measure their reading is. Required in practice whenever
   * `fallbackMeasurementType` is set.
   */
  fallbackMeasureLabel?: string;
  /** The InsightMetric key used by `useInsightsAnalytics()`. */
  insightMetric: InsightMetric;
  /** The chart-overlay slot id. */
  chartKey: ChartOverlayKey;
  /**
   * i18n key prefix that drives `title`, `description`, `chartTitle`,
   * `emptyState.title`, `emptyState.description`, `emptyState.cta`.
   * Pages pass e.g. `"insights.hrv"` and the scaffold resolves each
   * sub-key off the prefix.
   */
  i18nPrefix: string;
  /**
   * Single canonical colour for the chart line. Typed as a `var(--…)`
   * template so pages can only pass a theme token (`"var(--success)"`),
   * never a raw hex — raw stock hex ignores both themes and every future
   * token retune (see UI standards, colour token rules).
   */
  color: `var(--${string})`;
  /** Unit suffix the chart renders next to the value. */
  unit: string;
  /** Optional y-axis label shown above the unit. */
  yAxisUnit?: string;
  /** Optional value bands (Apple-Health-style target zone shading). */
  valueBands?: ComponentProps<typeof HealthChartDynamic>["valueBands"];
  /**
   * Optional empty-state CTA target. `null` renders the empty state without a
   * primary action. String values land in `/measurements?add=<x>`.
   */
  emptyStateCtaType?: string | null;
  /**
   * Manual capture type for the populated-page header action. When omitted,
   * the empty-state CTA type is reused; pass it explicitly when a metric is
   * manually supported but its empty state deliberately remains device-led.
   */
  captureType?: string | null;
  /** Icon node mounted in the empty-state card. */
  emptyStateIcon: ReactNode;
  /**
   * v1.12.6 — leading glyph for the stat strip's `<TileHeader>` (the
   * numbers-first block above the chart). Pass the metric's icon component
   * (e.g. `Activity`, `Droplet`); when omitted the strip falls back to a
   * generic stats glyph so every HealthKit page still leads with a complete
   * header carrying the metric name.
   */
  statIcon?: ComponentType<{ className?: string }>;
  /**
   * Optional Coach prefill for the empty-state launch. Falls back to a
   * generic onboarding prompt threaded through `<CoachLaunchButton>`'s
   * default.
   */
  coachPrefill?: string;
  /**
   * v1.7.0 — display-time value scale for the chart (e.g. WALKING_SPEED
   * stores m/s but renders km/h via `valueScale={3.6}`). Defaults to 1
   * (identity) so every existing page renders unchanged.
   */
  valueScale?: number;
  /**
   * v1.8.0 — metric key threaded into `<SubPageShell explainerMetric>`
   * so the `?` heading glyph opens the static "What is X?" explainer.
   * Resolves `insights.subPage.explainer.<explainerMetric>{Title,Body}`.
   */
  explainerMetric?: string;
  /**
   * v1.8.5 W5 — when set, renders `<MetricTargetSummary slug=…>` beneath
   * the chart. Used by blood glucose, whose per-context ADA / DDG bands
   * live on the targets wire but whose page rides this generic scaffold
   * rather than a bespoke module. Omit it for metrics without a target.
   */
  targetSummarySlug?: string;
  /**
   * v1.8.7.1 — when set, mounts `<InsightStatusCard>` beneath the chart,
   * pointed at the generic per-metric assessment route
   * (`/api/insights/metric-status?metric=<statusMetric>`). The value is
   * the HealthKit metric identifier the route keys on — almost always the
   * same string as `measurementType`. The card is only rendered on the
   * data-bearing branch; the empty (insufficient-data) branch keeps the
   * existing `<MetricEmptyState>` note and never fires an assessment
   * fetch. Omit it for metrics that should not carry an assessment.
   *
   * Typed to the closed `MetricStatusMetricId` union (the registry-id
   * vocabulary the route's Zod enum accepts) rather than a bare string,
   * so a page that passes a MeasurementType remap (e.g.
   * `ACTIVE_ENERGY_BURNED` instead of the `ACTIVE_ENERGY` registry id)
   * is a compile error, not a silent 422.
   */
  statusMetric?: MetricStatusMetricId;
  /**
   * v1.16.16 — decimal precision for the stat-strip values. Defaults to the
   * strip's own default (1). Blood glucose passes 0 for mg/dL (integer
   * readings) and 1 for mmol/L so the numbers and the unit agree.
   */
  statFractionDigits?: number;
  /**
   * v1.16.16 — optional override for the stat strip's "Median" label. Blood
   * glucose passes a window- + context-declaring string so the trailing
   * 90-day p50 is not read as an all-time central value.
   */
  statMedianLabel?: string;
  /**
   * v1.17.0 — optional extra content rendered beneath the chart + target
   * summary, before the metric-status card. Blood glucose mounts its clinical
   * panel (TIR / GMI / eA1C / CV% + advanced indices) here. Only rendered on
   * the data-bearing branch (the empty / loading / error branches skip it, so
   * a no-data metric never shows a void panel). Additive: every other page
   * omits it and renders byte-identically.
   */
  afterChart?: ReactNode;
  /**
   * v1.30 (UX/IA audit H1) — optional content rendered at the very foot of the
   * data-bearing spine, AFTER the metric-status assessment card. The
   * resting-pulse + HRV pages mount `<EcgCrossLink>` here so the ECG pointer
   * trails the assessment, matching the placement it has on `/insights/pulse`.
   * Self-gating nodes only (the cross-link un-mounts without recordings), so
   * the empty / loading / error branches skip it and no void card appears.
   */
  afterAssessment?: ReactNode;
}

export function HealthKitMetricPage({
  measurementType,
  fallbackMeasurementType,
  fallbackMeasureLabel,
  insightMetric,
  chartKey,
  i18nPrefix,
  color,
  unit,
  yAxisUnit,
  valueBands,
  emptyStateCtaType,
  captureType,
  emptyStateIcon,
  coachPrefill,
  valueScale,
  explainerMetric,
  targetSummarySlug,
  statusMetric,
  statIcon,
  statFractionDigits,
  statMedianLabel,
  afterChart,
  afterAssessment,
}: HealthKitMetricPageProps) {
  const { user, isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const {
    data: analytics,
    isEmpty,
    isLoading,
    error,
    refetch,
  } = useInsightsAnalytics(insightMetric);

  // v1.12.8 — shared visible-range state. The chart reports the per-type
  // Min / Max / Median / Mean for the data under its active range tab; the
  // stat strip reads it back for this page's single series.
  const { statsByType, onVisibleStats } = useChartDomainStats();

  // v1.17.0 — fallback-type swap. When the primary type has no rows but the
  // declared fallback does (HRV: SDNN empty, RMSSD present), key the chart,
  // stat strip, and "all values" list off the fallback so a ring / strap
  // user's stored HRV renders instead of an empty state. The swap only
  // triggers once analytics has loaded and the primary is genuinely empty.
  const primaryCount = analytics?.summaries?.[measurementType]?.count ?? 0;
  const fallbackCount = fallbackMeasurementType
    ? (analytics?.summaries?.[fallbackMeasurementType]?.count ?? 0)
    : 0;
  const usingFallback =
    primaryCount === 0 && fallbackCount > 0 && !!fallbackMeasurementType;
  const effectiveType = usingFallback
    ? (fallbackMeasurementType as string)
    : measurementType;

  const rawSummary = analytics?.summaries?.[effectiveType] ?? null;
  // The stat strip renders display-unit values. The summary holds stored
  // values, so when the page renders a scaled unit (e.g. WALKING_SPEED
  // stores m/s but displays km/h via `valueScale`), fold the same scale
  // into the strip's min / max / median / mean so the numbers and the
  // unit agree. `valueScale` defaults to 1 (identity) → byte-identical
  // for every non-scaled metric.
  const scale = valueScale ?? 1;
  const summary =
    rawSummary && scale !== 1
      ? {
          ...rawSummary,
          min: rawSummary.min === null ? null : rawSummary.min * scale,
          max: rawSummary.max === null ? null : rawSummary.max * scale,
          mean: rawSummary.mean === null ? null : rawSummary.mean * scale,
          median: rawSummary.median === null ? null : rawSummary.median * scale,
        }
      : rawSummary;

  const title = t(`${i18nPrefix}.title`);
  const description = t(`${i18nPrefix}.description`);

  // v1.12.7 — in-flight skeleton. The page consumed only `{data, isEmpty}`
  // before, so the ~30 HealthKit sub-pages painted nothing until the
  // analytics read landed, then popped the content in. Branch on the hook's
  // `isLoading` to reserve the stat-strip + chart height with the same
  // skeletons the rest of the surface uses, so the layout holds.
  if (isLoading) {
    return (
      <SubPageShell
        title={title}
        description={description}
        explainerMetric={explainerMetric}
        statStrip={<StatStripSkeleton />}
      >
        <ChartSkeleton />
      </SubPageShell>
    );
  }

  // v1.12.7 — error + retry. A failed analytics read used to fall through to
  // the empty-state (or a blank surface); surface a compact message + a
  // Retry that re-issues the query, mirroring the `<VitalsDashboard>`
  // pattern.
  if (error) {
    return (
      <SubPageShell
        title={title}
        description={description}
        explainerMetric={explainerMetric}
      >
        <div
          data-slot="healthkit-metric-error"
          role="alert"
          className="bg-card border-border text-muted-foreground flex flex-col items-start gap-3 rounded-xl border p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>{t("insights.subPage.loadError")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            data-slot="healthkit-metric-retry"
            className="gap-1.5"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("common.retry")}</span>
          </Button>
        </div>
      </SubPageShell>
    );
  }

  if (isEmpty) {
    const ctaNode =
      emptyStateCtaType != null ? (
        <Button size="sm" asChild>
          <Link href={`/measurements?add=${emptyStateCtaType}`}>
            {t(`${i18nPrefix}.emptyState.cta`)}
          </Link>
        </Button>
      ) : null;
    return (
      <SubPageShell
        title={title}
        description={description}
        explainerMetric={explainerMetric}
      >
        <MetricEmptyState
          icon={emptyStateIcon}
          title={t(`${i18nPrefix}.emptyState.title`)}
          description={t(`${i18nPrefix}.emptyState.description`)}
          cta={ctaNode}
          coachPrefill={coachPrefill ?? null}
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={title}
      description={description}
      explainerMetric={explainerMetric}
      statStrip={
        <MetricStatStrip
          summary={summary}
          unit={yAxisUnit ?? unit}
          fractionDigits={statFractionDigits}
          seriesLabel={title}
          icon={statIcon}
          windowStats={statsByType?.[effectiveType] ?? null}
          medianLabel={statMedianLabel}
        />
      }
      coachReadStrip={
        <CoachReadStrip
          metricType={effectiveType}
          unit={yAxisUnit ?? unit}
          fractionDigits={statFractionDigits}
          valueScale={valueScale}
        />
      }
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType={effectiveType}
          metricLabel={title}
          timeZone={user?.timezone ?? undefined}
        />
      }
      coachLaunch
      captureType={
        (captureType === undefined ? emptyStateCtaType : captureType) ??
        undefined
      }
      showAllValuesType={effectiveType}
    >
      <HealthChartDynamic
        chartKey={chartKey}
        types={[effectiveType]}
        title={
          usingFallback && fallbackMeasureLabel
            ? `${t(`${i18nPrefix}.chartTitle`)} · ${fallbackMeasureLabel}`
            : t(`${i18nPrefix}.chartTitle`)
        }
        titleIcon={statIcon}
        colors={[color]}
        unit={unit}
        yAxisUnit={yAxisUnit}
        valueBands={valueBands}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
        valueScale={valueScale}
        onVisibleStats={onVisibleStats}
      />
      {targetSummarySlug ? (
        <MetricTargetSummary slug={targetSummarySlug} />
      ) : null}
      {/* v1.17.0 — page-specific extra block (blood glucose: the clinical
          panel). Mounted on the data-bearing branch only. */}
      {afterChart}
      {/* v1.12.0 — Einschätzung is the last block on the canonical
          metric-detail spine. */}
      {statusMetric ? (
        <MetricStatusCard
          metric={statusMetric}
          icon={<Sparkles className="h-5 w-5" />}
          enabled={!isEmpty}
        />
      ) : null}
      {/* v1.30 (H1) — foot-of-spine slot, after the assessment card. The
          resting-pulse + HRV pages mount the ECG cross-link here. */}
      {afterAssessment}
    </SubPageShell>
  );
}

/**
 * v1.12.7 — layout-stable loading shell for the stat strip slot. Mirrors
 * the loaded `<MetricStatStrip>` card chrome (denser `py-3` rhythm, one
 * header row + a four-up grid) so the page does not jump when the analytics
 * read lands. Decorative — hidden from assistive tech; the chart skeleton
 * below it carries the `aria-busy` announcement.
 */
function StatStripSkeleton() {
  return (
    <Card
      data-slot="metric-stat-strip-skeleton"
      aria-hidden="true"
      className="gap-2 py-3 md:py-4"
    >
      <CardContent className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="min-h-[44px] space-y-1">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
