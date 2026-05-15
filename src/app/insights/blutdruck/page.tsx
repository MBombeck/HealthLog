"use client";

import Link from "next/link";
import { HeartPulse } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightStatus } from "@/hooks/use-insight-status";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { getBpTargets } from "@/lib/analytics/bp-targets";

/**
 * v1.4.25 W4 — `/insights/blutdruck`.
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

  const { data: status, isLoading: isStatusLoading } =
    useInsightStatus("blood-pressure");

  const { isEmpty } = useInsightsAnalytics("BLOOD_PRESSURE_SYS");

  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.bloodPressureSectionTitle")}
        description={t("insights.subPage.blutdruckDescription")}
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
          color: "#ff79c6",
          opacity: 0.21,
          label: t("charts.systolic"),
          textColor: "#ff79c6",
          lineOpacity: 0.24,
        },
        {
          min: bpTargets.diaLow,
          max: bpTargets.diaHigh,
          color: "#8be9fd",
          opacity: 0.21,
          label: t("charts.diastolic"),
          textColor: "#8be9fd",
          lineOpacity: 0.24,
        },
      ]
    : undefined;

  return (
    <SubPageShell
      title={t("insights.bloodPressureSectionTitle")}
      description={t("insights.subPage.blutdruckDescription")}
    >
      <HealthChartDynamic
        chartKey="bp"
        types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
        title={t("charts.bloodPressure")}
        colors={["#ff79c6", "#8be9fd"]}
        unit="mmHg"
        yAxisUnit="Hg"
        targetZones={bpTargetZones}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />

      <InsightStatusCard
        title={t("insights.assessmentTitle")}
        icon={<HeartPulse className="h-5 w-5" />}
        text={status?.text ?? null}
        hasProvider={status?.hasProvider ?? false}
        cached={status?.cached ?? false}
        updatedAt={status?.updatedAt ?? null}
        loading={isStatusLoading}
      />

      <CoachLaunchButton />
    </SubPageShell>
  );
}
