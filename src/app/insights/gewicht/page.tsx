"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Scale } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightStatus } from "@/hooks/use-insight-status";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { buildWeightBandsFromHeight } from "@/lib/analytics/value-bands";
import type { DataSummary } from "@/lib/analytics/trends";
import { hasMetricData } from "@/lib/insights/metric-availability";

interface AnalyticsData {
  summaries: Record<string, DataSummary>;
}

/**
 * v1.4.25 W4 — `/insights/gewicht`.
 *
 * Routed Weight sub-page. Renders the weight chart with the user's
 * height-derived green/orange/red bands plus the per-section AI
 * assessment. The chart-cog (`chartKey="weight"`) lets the user toggle
 * trend lines + comparison overlay independently from the dashboard
 * weight card.
 */
const HealthChart = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false },
);

export default function InsightsGewichtPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { data: status, isLoading: isStatusLoading } =
    useInsightStatus("weight");

  const { data: analytics } = useQuery({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch("/api/analytics");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as AnalyticsData;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  if (
    isAuthenticated &&
    analytics &&
    !hasMetricData("WEIGHT", {
      summaries: analytics.summaries,
      hasMood: false,
      hasMedication: false,
    })
  ) {
    return (
      <SubPageShell title={t("insights.weightSectionTitle")}>
        <EmptyState
          icon={<Scale className="size-6" />}
          title={t("insights.emptyState.weight.title")}
          description={t("insights.emptyState.weight.description")}
          ctaSize="lg"
          action={
            <Button size="sm" asChild>
              <Link href="/measurements?add=WEIGHT">
                {t("insights.emptyState.weight.cta")}
              </Link>
            </Button>
          }
        />
        <CoachLaunchButton
          prefill="I haven't recorded any weight yet — why does it matter, and what should I know before I start tracking?"
        />
      </SubPageShell>
    );
  }

  const weightBands = user?.heightCm
    ? buildWeightBandsFromHeight(user.heightCm, {
        lowerBound: 30,
        upperBound: 250,
      })
    : undefined;

  return (
    <SubPageShell
      title={t("insights.weightSectionTitle")}
      description={t("insights.subPage.gewichtDescription")}
    >
      <HealthChart
        chartKey="weight"
        types={["WEIGHT"]}
        title={t("charts.weight")}
        colors={["#bd93f9"]}
        unit="kg"
        valueBands={weightBands}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />

      <InsightStatusCard
        title={t("insights.assessmentTitle")}
        icon={<Scale className="h-5 w-5" />}
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
