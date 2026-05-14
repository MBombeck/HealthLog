"use client";

import dynamic from "next/dynamic";
import { HeartPulse } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightStatus } from "@/hooks/use-insight-status";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
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
 * Empty-state rule (Marc directive): if the user has no BP data, the
 * chart's own empty-state takes over — no extra "no data" CTAs stack
 * on top of the chart skeleton.
 */
const HealthChart = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false },
);

export default function InsightsBlutdruckPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { data: status, isLoading: isStatusLoading } =
    useInsightStatus("blood-pressure");

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
      <HealthChart
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
    </SubPageShell>
  );
}
