"use client";

import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, HeartPulse } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { useChartDomainStats } from "@/hooks/use-chart-domain-stats";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { SlugInsightStatusCard } from "@/components/insights/slug-insight-status-card";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { CoachReadStrip } from "@/components/insights/derived/coach-read-strip";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { getBpTargets } from "@/lib/analytics/bp-targets";

/**
 * v1.4.25 W4 — `/insights/blood-pressure`.
 *
 * Routed Blood-Pressure sub-page. The mother page hosts the overview
 * (hero + briefing + advisor); this page concentrates on BP-only depth:
 * the BP chart with its chart-cog overlays, the per-section AI
 * assessment, and the chart's target zones tied to the user's age.
 *
 * v1.4.27 F17 — when the user has zero BP observations, the page
 * short-circuits to an empty-state CTA pointing at
 * `/measurements?add=BLOOD_PRESSURE`. Apple Health convention: empty
 * surfaces lead to onboarding hints rather than chart skeletons.
 * v1.4.27 MB6 — the previous `/measurements/new` href hit a 404; the
 * measurements page now consumes `?add=<TYPE>` and auto-opens the
 * dialog with the matching default type.
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — the analytics fetch and the
 * empty-state render were lifted into `useInsightsAnalytics()` and
 * `<MetricEmptyState>`; the page module is now Apple-Health-lean.
 */
export default function InsightsBlutdruckPage() {
  const { user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(user != null);

  const { data: analytics, isEmpty } =
    useInsightsAnalytics("BLOOD_PRESSURE_SYS");
  // v1.12.4 — blood pressure is two series, so it stacks two stat strips
  // (systolic / diastolic) rather than the single-series strip the other
  // metrics carry. Both summaries ride the same `summaries` slice.
  const sysSummary = analytics?.summaries?.BLOOD_PRESSURE_SYS ?? null;
  const diaSummary = analytics?.summaries?.BLOOD_PRESSURE_DIA ?? null;

  // v1.12.8 — chart-reactive metric statistics. Blood pressure tracks BOTH
  // series at once: the single chart reports per-type visible-range stats and
  // each strip column reads its own half.
  const { statsByType, onVisibleStats } = useChartDomainStats();

  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.bloodPressureSectionTitle")}
        description={t("insights.subPage.blutdruckDescription")}
        explainerMetric="bloodPressure"
      >
        <MetricEmptyState
          icon={<HeartPulse className="size-6" />}
          title={t("insights.emptyState.bloodPressure.title")}
          description={t("insights.emptyState.bloodPressure.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/measurements?add=BLOOD_PRESSURE">
                {t("insights.emptyState.bloodPressure.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I haven't recorded any blood pressure yet — why does it matter, and what should I know before I start?"
        />
      </SubPageShell>
    );
  }

  const bpTargets =
    user?.dateOfBirth != null ? getBpTargets(new Date(user.dateOfBirth)) : null;
  const bpTargetZones = bpTargets
    ? [
        {
          min: bpTargets.sysLow,
          max: bpTargets.sysHigh,
          color: "var(--chart-3)",
          opacity: 0.21,
          label: t("charts.systolic"),
          textColor: "var(--chart-3)",
          lineOpacity: 0.24,
        },
        {
          min: bpTargets.diaLow,
          max: bpTargets.diaHigh,
          color: "var(--info)",
          opacity: 0.21,
          label: t("charts.diastolic"),
          textColor: "var(--info)",
          lineOpacity: 0.24,
        },
      ]
    : undefined;

  return (
    <SubPageShell
      title={t("insights.bloodPressureSectionTitle")}
      description={t("insights.subPage.blutdruckDescription")}
      explainerMetric="bloodPressure"
      coachLaunch
      coachReadStrip={
        <CoachReadStrip
          metricType="BLOOD_PRESSURE_SYS"
          unit="mmHg"
          fractionDigits={0}
        />
      }
      statStrip={
        // v1.12.7 — blood pressure is two series, but they share ONE card
        // with the systolic / diastolic columns side by side (stacking only
        // on narrow mobile) rather than two stacked cards. Each column keeps
        // its header, its four stats, and its own brushed-window behaviour:
        // brushing the single chart reports per-type windowed stats and each
        // column reads its own half.
        <MetricStatStrip
          groupLabel={t("insights.bloodPressureSectionTitle")}
          series={[
            {
              dataKey: "sys",
              summary: sysSummary,
              unit: "mmHg",
              fractionDigits: 0,
              seriesLabel: t("charts.systolic"),
              icon: ArrowUpRight,
              windowStats: statsByType?.BLOOD_PRESSURE_SYS ?? null,
            },
            {
              dataKey: "dia",
              summary: diaSummary,
              unit: "mmHg",
              fractionDigits: 0,
              seriesLabel: t("charts.diastolic"),
              icon: ArrowDownRight,
              windowStats: statsByType?.BLOOD_PRESSURE_DIA ?? null,
            },
          ]}
        />
      }
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType="BLOOD_PRESSURE_SYS"
          metricLabel={t("insights.bloodPressureSectionTitle")}
          timeZone={user?.timezone ?? undefined}
        />
      }
      captureType="BLOOD_PRESSURE"
      showAllValuesType="BLOOD_PRESSURE_SYS"
    >
      <HealthChartDynamic
        chartKey="bp"
        types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
        title={t("charts.bloodPressure")}
        titleIcon={HeartPulse}
        colors={["var(--chart-3)", "var(--info)"]}
        unit="mmHg"
        yAxisUnit="mmHg"
        targetZones={bpTargetZones}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
        onVisibleStats={onVisibleStats}
      />

      {/* v1.12.4 — target card sits between the chart and the assessment on
          the canonical spine (ESH classification + sys/dia band + 30-day S/D
          average). */}
      <MetricTargetSummary slug="blood-pressure" />

      {/* v1.18.6 — free derived BP context: pulse pressure (SBP − DBP) and
          mean arterial pressure ((SBP + 2·DBP)/3), computed from the most
          recent reading. Pure derivation of stored BP — no schema, no extra
          fetch. Calm, cited, non-alarming. */}
      {(() => {
        const sbp = sysSummary?.latest ?? null;
        const dbp = diaSummary?.latest ?? null;
        if (sbp == null || dbp == null || sbp <= dbp) return null;
        const pp = Math.round(sbp - dbp);
        const map = Math.round((sbp + 2 * dbp) / 3);
        return (
          // Card shell at the compact density so the explainer shares the
          // spine's left text edge (the bare paragraph sat at the container
          // edge, ~16–24 px left of every neighbouring card's text) — and
          // foreground, not muted: multi-sentence explainer prose is
          // content, muted stays reserved for meta.
          <Card data-slot="bp-derived-caption" className="gap-2 py-3 md:py-4">
            <CardContent>
              <p className="text-sm leading-relaxed">
                {t("insights.subPage.bpDerived.pulsePressure", {
                  value: pp,
                })}{" "}
                {t("insights.subPage.bpDerived.meanArterialPressure", {
                  value: map,
                })}{" "}
                {t("insights.subPage.bpDerived.caveat")}
              </p>
            </CardContent>
          </Card>
        );
      })()}

      {/* v1.12.4 — Einschätzung is the last content block; the stat strip
          (rendered by the shell) closes the spine below it. */}
      <SlugInsightStatusCard
        slug="blood-pressure"
        icon={<HeartPulse className="h-5 w-5" />}
      />
    </SubPageShell>
  );
}
