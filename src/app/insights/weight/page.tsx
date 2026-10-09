"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { useChartDomainStats } from "@/hooks/use-chart-domain-stats";
import { Button } from "@/components/ui/button";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { SlugInsightStatusCard } from "@/components/insights/slug-insight-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { CoachReadStrip } from "@/components/insights/derived/coach-read-strip";
import { MetricCorrelationCard } from "@/components/insights/metric-correlation-card";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import {
  buildBandsFromTrafficRange,
  buildWeightBandsFromHeight,
  type TrafficRange,
} from "@/lib/analytics/value-bands";

/**
 * v1.4.25 W4 — `/insights/weight`.
 *
 * Routed Weight sub-page. Renders the weight chart with green/orange/red
 * bands plus the per-section AI assessment. The chart-cog
 * (`chartKey="weight"`) lets the user toggle trend lines + comparison
 * overlay independently from the dashboard weight card.
 *
 * v1.34 — the bands follow the user's own weight target when one is set,
 * and fall back to the height-derived WHO band only when it is not.
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — analytics fetch + empty-state
 * branch now consume `useInsightsAnalytics()` + `<MetricEmptyState>`.
 */
export default function InsightsGewichtPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);
  const unitDisplay = useUnitDisplay();

  const {
    data: analytics,
    isEmpty,
    isLoading: analyticsLoading,
  } = useInsightsAnalytics("WEIGHT");
  const weightSummary = analytics?.summaries?.WEIGHT ?? null;

  // v1.34 — the user's own weight target, read through the shared
  // `queryKeys.userThresholds()` cell the targets editor also subscribes to, so
  // editing the target repaints this chart's band without a reload.
  const { data: thresholds } = useQuery({
    queryKey: queryKeys.userThresholds(),
    queryFn: async () => {
      return apiGet<{
        effective: Record<
          string,
          { range: TrafficRange | null; isOverride: boolean }
        >;
      }>("/api/user/thresholds");
    },
    enabled: isAuthenticated,
  });

  // v1.32.26 — resolve the weight display unit + scale from the user's
  // preference (kg for metric, lb for imperial). This page inlines the shell
  // rather than riding the scaffold, so it converts the stat strip + chart
  // series + bands here. Weight has no affine offset, so the factor alone
  // covers both the values and the bands.
  const weightTransform = unitDisplay.transformFor("WEIGHT");
  const weightUnit = weightTransform.displayUnit;
  const weightScale = weightTransform.factor;
  // v1.32.39 — the strip + band values convert through `toDisplay`, which
  // rounds to the transform's own decimals. `weightScale` stays for the chart
  // alone: it folds the factor into its series and formats at its own
  // precision, so it needs the raw multiplier rather than a rounded value.
  const toDisplayWeight = (value: number) =>
    unitDisplay.toDisplay("WEIGHT", value);
  const displaySummary =
    weightSummary && weightScale !== 1
      ? {
          ...weightSummary,
          min:
            weightSummary.min === null
              ? null
              : toDisplayWeight(weightSummary.min),
          max:
            weightSummary.max === null
              ? null
              : toDisplayWeight(weightSummary.max),
          mean:
            weightSummary.mean === null
              ? null
              : toDisplayWeight(weightSummary.mean),
          median:
            weightSummary.median === null
              ? null
              : toDisplayWeight(weightSummary.median),
        }
      : weightSummary;

  // v1.12.8 — visible-range stats shared between the chart and the strip.
  const { statsByType, statsSettled, onVisibleStats } = useChartDomainStats();

  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.weightSectionTitle")}
        description={t("insights.subPage.gewichtDescription")}
        explainerMetric="weight"
      >
        <MetricEmptyState
          icon={<Scale className="size-6" />}
          title={t("insights.emptyState.weight.title")}
          description={t("insights.emptyState.weight.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/measurements?add=WEIGHT">
                {t("insights.emptyState.weight.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I haven't recorded any weight yet. Why does it matter, and what should I know before I start tracking?"
        />
      </SubPageShell>
    );
  }

  // v1.34 — the shaded zone follows the user's OWN target when they set one.
  // The page used to shade the height-derived WHO band unconditionally, so
  // someone who had entered a target on `/targets` kept reading a chart that
  // ignored the answer. `/api/user/thresholds` already resolves the override
  // (with its orange wings) through `getEffectiveRange`, so the page reads the
  // resolved band rather than re-deriving one. No target and no height → no
  // bands, unchanged.
  const overrideRange = thresholds?.effective?.WEIGHT?.isOverride
    ? (thresholds.effective.WEIGHT.range ?? null)
    : null;
  const weightBands = overrideRange
    ? buildBandsFromTrafficRange(overrideRange, {
        lowerBound: 30,
        upperBound: 250,
      })
    : user?.heightCm
      ? buildWeightBandsFromHeight(user.heightCm, {
          lowerBound: 30,
          upperBound: 250,
        })
      : undefined;
  // The bands are kg bounds → scale into the display unit so the shaded zone
  // tracks the converted line (factor-only; weight carries no offset).
  const displayBands =
    weightBands && weightScale !== 1
      ? weightBands.map((band) => ({
          ...band,
          min: toDisplayWeight(band.min),
          max: toDisplayWeight(band.max),
        }))
      : weightBands;

  return (
    <SubPageShell
      title={t("insights.weightSectionTitle")}
      description={t("insights.subPage.gewichtDescription")}
      explainerMetric="weight"
      statStrip={
        <MetricStatStrip
          pending={analyticsLoading}
          summary={displaySummary}
          unit={weightUnit}
          fractionDigits={weightTransform.decimals}
          seriesLabel={t("insights.weightSectionTitle")}
          icon={Scale}
          windowStats={statsByType?.WEIGHT ?? null}
          windowPending={!statsSettled}
        />
      }
      coachReadStrip={<CoachReadStrip metricType="WEIGHT" unit={weightUnit} />}
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType="WEIGHT"
          metricLabel={t("insights.weightSectionTitle")}
          timeZone={user?.timezone ?? undefined}
        />
      }
      coachLaunch
      captureType="WEIGHT"
      showAllValuesType="WEIGHT"
    >
      <HealthChartDynamic
        chartKey="weight"
        types={["WEIGHT"]}
        title={t("charts.weight")}
        titleIcon={Scale}
        colors={["var(--chart-1)"]}
        unit={weightUnit}
        valueBands={displayBands}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
        valueScale={weightScale}
        onVisibleStats={onVisibleStats}
        showDataTable
        dayLinks
      />

      <MetricTargetSummary slug="weight" />

      {/* v1.12.0 — Weight owns the weight × weekday correlation (relocated
          off the overview onto its metric page). */}
      <MetricCorrelationCard slug="weight" />

      <SlugInsightStatusCard
        slug="weight"
        icon={<Scale className="h-5 w-5" />}
      />
    </SubPageShell>
  );
}
