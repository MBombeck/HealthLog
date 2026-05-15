"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Moon } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { SleepOverview } from "@/components/insights/sleep-overview";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import type { DataSummary } from "@/lib/analytics/trends";
import { hasMetricData } from "@/lib/insights/metric-availability";

/**
 * v1.4.25 W4c — `/insights/schlaf`.
 *
 * The Sleep sub-page surfaces the per-stage breakdown + duration trend
 * the v1.4.23 schema gained but never rendered. All charts live inside
 * `<SleepOverview>` so the page-level scaffold stays trivial; data
 * fetches and empty-state handling are encapsulated in the component.
 *
 * v1.4.27 F17 — when `summaries.SLEEP_DURATION.count === 0` (no
 * Apple-Health / Withings sleep rows yet), the page short-circuits
 * to an empty-state CTA pointing at `/settings/data-sources` so the
 * user can connect a sleep source.
 */
interface AnalyticsData {
  summaries: Record<string, DataSummary>;
}

export default function InsightsSchlafPage() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

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
    !hasMetricData("SLEEP_DURATION", {
      summaries: analytics.summaries,
      hasMood: false,
      hasMedication: false,
    })
  ) {
    return (
      <SubPageShell title={t("insights.sleep.title")}>
        <EmptyState
          icon={<Moon className="size-6" />}
          title={t("insights.emptyState.sleep.title")}
          description={t("insights.emptyState.sleep.description")}
          ctaSize="lg"
          action={
            <Button size="sm" asChild>
              <Link href="/settings/data-sources">
                {t("insights.emptyState.sleep.cta")}
              </Link>
            </Button>
          }
        />
        <CoachLaunchButton
          prefill="I don't have any sleep data yet — why does sleep tracking matter, and what should I know before I connect a source?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.sleep.title")}
      description={t("insights.sleep.description")}
    >
      <SleepOverview />

      <CoachLaunchButton />
    </SubPageShell>
  );
}
