"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Smile } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightStatus } from "@/hooks/use-insight-status";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.4.25 W4 — `/insights/stimmung`.
 *
 * Routed Mood sub-page. Unlike the mother page (which hid the mood
 * section entirely when no mood data existed), a dedicated sub-page
 * cannot just blank itself — we'd land on an empty white page. Instead,
 * the sub-page surfaces a clear empty-state CTA into `/mood` so the
 * user can log their first entry, matching the Apple Health "No data"
 * convention (research §1.1).
 */
const MoodChart = dynamic(
  () =>
    import("@/components/charts/mood-chart").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

interface ComprehensiveMoodData {
  moodSummary: { count: number } | null;
}

export default function InsightsStimmungPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { data: status, isLoading: isStatusLoading } = useInsightStatus("mood");

  // Reuse the mother-page comprehensive query — TanStack Query
  // dedups so this is a free cache read for the common case.
  const { data: comprehensive } = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: async () => {
      const res = await fetch("/api/insights/comprehensive");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as ComprehensiveMoodData;
    },
    enabled: isAuthenticated,
  });

  const moodCount = comprehensive?.moodSummary?.count ?? 0;

  // v1.4.27 F17 — Mood is event-driven so the gate reads
  // `hasMood = moodCount > 0`. CTA targets `/mood` (the dedicated
  // mood-logging surface) — short-circuits the user to the quickest
  // path to log their first entry.
  //
  // v1.4.28 R3d (BK-F-M1) — empty-state render delegates to the shared
  // `<MetricEmptyState>` primitive. The mood data path stays on
  // `/api/insights/comprehensive` because the `moodSummary.count`
  // signal is event-driven, not sensor-aggregated.
  if (isAuthenticated && comprehensive && moodCount === 0) {
    return (
      <SubPageShell
        title={t("insights.moodSectionTitle")}
        description={t("insights.subPage.stimmungDescription")}
      >
        <MetricEmptyState
          icon={<Smile className="size-6" />}
          title={t("insights.emptyState.mood.title")}
          description={t("insights.emptyState.mood.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/mood">{t("insights.emptyState.mood.cta")}</Link>
            </Button>
          }
          coachPrefill="I haven't logged any mood entries yet — why does mood tracking matter, and how should I start?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.moodSectionTitle")}
      description={t("insights.subPage.stimmungDescription")}
    >
      <MoodChart
        chartKey="mood"
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />

      <InsightStatusCard
        title={t("insights.assessmentTitle")}
        icon={<Smile className="h-5 w-5" />}
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
