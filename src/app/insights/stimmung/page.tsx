"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Smile } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightStatus } from "@/hooks/use-insight-status";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
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
  { ssr: false },
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
    queryKey: ["insights", "comprehensive"],
    queryFn: async () => {
      const res = await fetch("/api/insights/comprehensive");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as ComprehensiveMoodData;
    },
    enabled: isAuthenticated,
  });

  const moodCount = comprehensive?.moodSummary?.count ?? 0;

  if (isAuthenticated && comprehensive && moodCount === 0) {
    return (
      <SubPageShell title={t("insights.moodSectionTitle")}>
        <EmptyState
          icon={<Smile className="size-6" />}
          title={t("insights.subPage.stimmungEmptyTitle")}
          description={t("insights.subPage.stimmungEmptyDescription")}
          action={
            <Button size="sm" asChild>
              <Link href="/mood">
                {t("insights.subPage.stimmungEmptyAction")}
              </Link>
            </Button>
          }
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
    </SubPageShell>
  );
}
