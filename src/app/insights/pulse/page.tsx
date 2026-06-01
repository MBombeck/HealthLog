"use client";

import Link from "next/link";
import { Heart } from "lucide-react";

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
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { Vo2MaxChartRow } from "@/components/insights/vo2-max-chart-row";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";

/**
 * v1.4.25 W4 — `/insights/pulse`.
 *
 * Routed Pulse sub-page. Renders the pulse chart with the personalized
 * Karvonen-derived target band plus the per-section AI assessment.
 * Note: `chartKey="pulse"` so the chart-cog can override the
 * comparison-overlay independently from the dashboard pulse card; the
 * MeasurementType filter is `PULSE` (the same field used elsewhere
 * in the codebase).
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — analytics fetch + empty-state
 * branch consume `useInsightsAnalytics()` + `<MetricEmptyState>`. The
 * VO2 max chart-row still reads `data.summaries.VO2_MAX` directly so
 * the hook exposes the unwrapped payload alongside `isEmpty`.
 */
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
  const { data: analytics, isEmpty } = useInsightsAnalytics("PULSE");
  const vo2Summary = analytics?.summaries?.VO2_MAX ?? null;

  // v1.4.27 F17 — gate the sub-page on at least one pulse observation.
  // Brand-new accounts (no manual logs, no Apple-Health upload yet)
  // see a one-line empty-state with a CTA into
  // `/measurements?add=PULSE` rather than a chart skeleton over a
  // blank target band. v1.4.27 MB6 — query-param replaces the dead
  // `/measurements/new` route.
  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.pulseSectionTitle")}
        description={t("insights.subPage.pulsDescription")}
        explainerMetric="pulse"
      >
        <MetricEmptyState
          icon={<Heart className="size-6" />}
          title={t("insights.emptyState.pulse.title")}
          description={t("insights.emptyState.pulse.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/measurements?add=PULSE">
                {t("insights.emptyState.pulse.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I haven't recorded any resting pulse yet — why does it matter, and what should I know before I start?"
        />
      </SubPageShell>
    );
  }

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
      explainerMetric="pulse"
    >
      <HealthChartDynamic
        chartKey="pulse"
        types={["PULSE"]}
        title={t("charts.pulse")}
        colors={["#50fa7b"]}
        unit="bpm"
        valueBands={pulseBands}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />

      <MetricTargetSummary slug="pulse" />

      <InsightStatusCard
        title={t("insights.assessmentTitle")}
        icon={<Heart className="h-5 w-5" />}
        text={status?.text ?? null}
        hasProvider={status?.hasProvider ?? false}
        cached={status?.cached ?? false}
        updatedAt={status?.updatedAt ?? null}
        loading={isStatusLoading}
        preparing={status?.preparing ?? false}
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

      <CoachLaunchButton />
    </SubPageShell>
  );
}
