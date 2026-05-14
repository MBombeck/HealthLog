"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { Heart } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightStatus } from "@/hooks/use-insight-status";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { Vo2MaxChartRow } from "@/components/insights/vo2-max-chart-row";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";

/**
 * v1.4.25 W4 — `/insights/puls`.
 *
 * Routed Pulse sub-page. Renders the pulse chart with the personalized
 * Karvonen-derived target band plus the per-section AI assessment.
 * Note: `chartKey="pulse"` so the chart-cog can override the
 * comparison-overlay independently from the dashboard pulse card; the
 * MeasurementType filter is `PULSE` (the same field used elsewhere
 * in the codebase).
 */
const HealthChart = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false },
);

interface AnalyticsData {
  summaries: Record<string, DataSummary>;
}

export default function InsightsPulsPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { data: status, isLoading: isStatusLoading } =
    useInsightStatus("pulse");

  // v1.4.25 W16a — VO2 max chart-row consumes the same `/api/analytics`
  // bundle the mother page reads. Sharing the cache key keeps the
  // payload single-fetch on tab navigation (React-Query unwraps from
  // the same key).
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
  const vo2Summary = analytics?.summaries?.VO2_MAX ?? null;

  const pulseAge = getAgeFromDateOfBirth(user?.dateOfBirth ?? null);
  const pulseTarget = getPersonalizedPulseTarget(
    pulseAge,
    (user?.gender as "MALE" | "FEMALE" | null | undefined) ?? null,
  );
  const pulseBands = [
    { min: 30, max: pulseTarget.orangeMin, color: "#ff5555", opacity: 0.16 },
    {
      min: pulseTarget.orangeMin,
      max: pulseTarget.greenMin,
      color: "#ffb86c",
      opacity: 0.18,
    },
    {
      min: pulseTarget.greenMin,
      max: pulseTarget.greenMax,
      color: "#50fa7b",
      opacity: 0.2,
    },
    {
      min: pulseTarget.greenMax,
      max: pulseTarget.orangeMax,
      color: "#ffb86c",
      opacity: 0.18,
    },
    { min: pulseTarget.orangeMax, max: 220, color: "#ff5555", opacity: 0.16 },
  ].filter((band) => band.max > band.min);

  return (
    <SubPageShell
      title={t("insights.pulseSectionTitle")}
      description={t("insights.subPage.pulsDescription")}
    >
      <HealthChart
        chartKey="pulse"
        types={["PULSE"]}
        title={t("charts.pulse")}
        colors={["#50fa7b"]}
        unit="bpm"
        valueBands={pulseBands}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />

      <InsightStatusCard
        title={t("insights.assessmentTitle")}
        icon={<Heart className="h-5 w-5" />}
        text={status?.text ?? null}
        hasProvider={status?.hasProvider ?? false}
        cached={status?.cached ?? false}
        updatedAt={status?.updatedAt ?? null}
        loading={isStatusLoading}
      />

      {/* v1.4.25 W16a — VO2 max sits on the cardio sub-page because it
          is a cardio-fitness metric (Apple's Health app surfaces it
          under "Heart"). The chart-row stays mounted even at zero
          samples so a brand-new account sees the "no data yet" hint
          rather than a missing surface — same pattern the dashboard
          tile uses (opt-in via Settings → Dashboard). */}
      <Vo2MaxChartRow
        summary={vo2Summary}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />
    </SubPageShell>
  );
}
