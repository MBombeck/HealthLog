"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Ruler } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { SlugInsightStatusCard } from "@/components/insights/slug-insight-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.4.25 — `/insights/bmi`.
 *
 * Routed BMI sub-page. BMI is derived from `WEIGHT / (height/100)^2`,
 * so the chart sets `valueMode="bmi"` on `<HealthChartDynamic>` and the
 * underlying WEIGHT series is reused. When the user has no height set
 * the chart can't compute; we surface the same plain empty-state the
 * mother page used.
 *
 * v1.4.28 — analytics fetch + the
 * weight-not-logged-yet branch consume the shared hook + primitive.
 * The "height not set" branch keeps its bespoke `<EmptyState>` because
 * the CTA targets `/settings/account`, not the measurement onboarding.
 */
const BMI_BANDS = [
  { min: 0, max: 17, color: "var(--destructive)", opacity: 0.16 },
  { min: 17, max: 18.5, color: "var(--warning)", opacity: 0.18 },
  { min: 18.5, max: 24.9, color: "var(--success)", opacity: 0.2 },
  { min: 24.9, max: 29.9, color: "var(--warning)", opacity: 0.18 },
  { min: 29.9, max: 120, color: "var(--destructive)", opacity: 0.16 },
];

export default function InsightsBmiPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { isEmpty } = useInsightsAnalytics("BMI");

  // `useAuth()` is the person at the keyboard. Inside somebody else's record
  // the height that decides is the record's, from the route that knows which
  // record is on screen (the reference panel below reads the same cell).
  const { inSharedRecord } = useRecordCapabilities();
  const { data: targets } = useQuery({
    queryKey: queryKeys.insightsTargets(),
    queryFn: () =>
      apiGet<{
        targets: ReadonlyArray<{ type: string; range: unknown }>;
        profile?: { heightCm: number | null };
      }>("/api/insights/targets"),
    enabled: isAuthenticated,
  });
  const heightCm = inSharedRecord
    ? (targets?.profile?.heightCm ?? null)
    : (user?.heightCm ?? null);
  const heightKnown = !inSharedRecord || targets !== undefined;
  // The adult bands only where the server names the BMI range: it names none
  // for a child's record, which they do not describe.
  const bmiBands = targets?.targets.find((entry) => entry.type === "BMI")?.range
    ? BMI_BANDS
    : undefined;

  // v1.4.27 — BMI is derived from WEIGHT. When no weight readings
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
        explainerMetric="bmi"
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
          coachPrefill={t("insights.emptyState.bmi.coachPrefill")}
        />
      </SubPageShell>
    );
  }

  if (heightKnown && !heightCm) {
    return (
      <SubPageShell
        title={t("insights.bmiSectionTitle")}
        description={t("insights.subPage.bmiDescription")}
        explainerMetric="bmi"
      >
        <EmptyState
          icon={<Ruler className="size-6" />}
          title={t("insights.bmiEmptyTitle")}
          description={t("insights.bmiEmptyDescription")}
          action={
            <Button size="sm" asChild>
              <Link href="/settings/account">
                {t("insights.bmiEmptyAction")}
              </Link>
            </Button>
          }
        />
        <CoachLaunchButton prefill={t("insights.bmiHeight.coachPrefill")} />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.bmiSectionTitle")}
      description={t("insights.subPage.bmiDescription")}
      explainerMetric="bmi"
      coachLaunch
    >
      {/* No `statStrip` / `diversityNudge` / `showAllValuesType`: BMI is a
          derived metric (computed from the WEIGHT series + the user's height),
          so it has no first-class summary or raw-reading rows of its own. A
          stat strip would have nothing to read, and a diversity nudge / "show
          all values" entry would point at WEIGHT and duplicate the weight
          page's controls. */}
      <HealthChartDynamic
        chartKey="bmi"
        types={["WEIGHT"]}
        title={t("targets.bmi")}
        colors={["var(--chart-5)"]}
        unit="kg/m²"
        valueMode="bmi"
        valueBands={bmiBands}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
        showDataTable
        dayLinks
      />

      <MetricTargetSummary slug="bmi" />

      <SlugInsightStatusCard slug="bmi" icon={<Ruler className="h-5 w-5" />} />
    </SubPageShell>
  );
}
