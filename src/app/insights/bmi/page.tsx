"use client";

import Link from "next/link";
import { Ruler } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightStatus } from "@/hooks/use-insight-status";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.4.25 W4 — `/insights/bmi`.
 *
 * Routed BMI sub-page. BMI is derived from `WEIGHT / (height/100)^2`,
 * so the chart sets `valueMode="bmi"` on `<HealthChartDynamic>` and the
 * underlying WEIGHT series is reused. When the user has no height set
 * the chart can't compute; we surface the same plain empty-state the
 * mother page used.
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — analytics fetch + the
 * weight-not-logged-yet branch consume the shared hook + primitive.
 * The "height not set" branch keeps its bespoke `<EmptyState>` because
 * the CTA targets `/settings/account`, not the measurement onboarding.
 */
const BMI_BANDS = [
  { min: 0, max: 17, color: "#ff5555", opacity: 0.16 },
  { min: 17, max: 18.5, color: "#ffb86c", opacity: 0.18 },
  { min: 18.5, max: 24.9, color: "#50fa7b", opacity: 0.2 },
  { min: 24.9, max: 29.9, color: "#ffb86c", opacity: 0.18 },
  { min: 29.9, max: 120, color: "#ff5555", opacity: 0.16 },
];

export default function InsightsBmiPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { data: status, isLoading: isStatusLoading } = useInsightStatus("bmi");

  const { isEmpty } = useInsightsAnalytics("BMI");

  // v1.4.27 F17 — BMI is derived from WEIGHT. When no weight readings
  // exist yet, the existing "set your height" branch can never compute
  // anything useful either; surface the empty-state CTA pointing at
  // `/measurements?add=WEIGHT` instead so the user logs the weight
  // first. v1.4.27 MB6 — query-param replaces the dead
  // `/measurements/new` route.
  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.bmiSectionTitle")}
        description={t("insights.subPage.bmiDescription")}
      >
        <MetricEmptyState
          icon={<Ruler className="size-6" />}
          title={t("insights.emptyState.bmi.title")}
          description={t("insights.emptyState.bmi.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/measurements?add=WEIGHT">
                {t("insights.emptyState.bmi.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I haven't recorded any weight yet — why does BMI matter for me, and what should I know before I start tracking it?"
        />
      </SubPageShell>
    );
  }

  if (!user?.heightCm) {
    return (
      <SubPageShell
        title={t("insights.bmiSectionTitle")}
        description={t("insights.subPage.bmiDescription")}
      >
        <EmptyState
          icon={<Ruler className="size-6" />}
          title={t("insights.bmiEmptyTitle")}
          description={t("insights.bmiEmptyDescription")}
          ctaSize="lg"
          action={
            <Button size="sm" asChild>
              <Link href="/settings/account">
                {t("insights.bmiEmptyAction")}
              </Link>
            </Button>
          }
        />
        <CoachLaunchButton
          prefill="I haven't set my height yet — why does BMI matter, and what should I know before I configure it?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.bmiSectionTitle")}
      description={t("insights.subPage.bmiDescription")}
    >
      <HealthChartDynamic
        chartKey="bmi"
        types={["WEIGHT"]}
        title={t("targets.bmi")}
        colors={["#f1fa8c"]}
        unit="kg/m²"
        valueMode="bmi"
        valueBands={BMI_BANDS}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />

      <InsightStatusCard
        title={t("insights.assessmentTitle")}
        icon={<Ruler className="h-5 w-5" />}
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
