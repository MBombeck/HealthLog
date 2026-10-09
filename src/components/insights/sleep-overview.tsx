"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { Moon } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import dynamic from "next/dynamic";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";
import type { SleepStageBreakdown } from "./sleep-stage-stacked-bar";
import { SleepDurationChart } from "./sleep-duration-chart";

// v1.18.11 (W5 perf) — the stage stacked bar is the only recharts consumer
// on this page (the duration chart already routes through
// `health-chart-dynamic`). Defer it through `next/dynamic` so recharts is
// off `/insights/sleep`'s first-load JS; the `<ChartSkeleton>` loading shell
// matches the card the bar paints so the layout stays stable.
const SleepStageStackedBarLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({
        default: mod.SleepStageStackedBar,
      }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function SleepStageStackedBar(
  props: ComponentProps<typeof SleepStageStackedBarLazy>,
) {
  return (
    <ChartErrorBoundary>
      <SleepStageStackedBarLazy {...props} />
    </ChartErrorBoundary>
  );
}

/**
 * v1.4.25 W4c — Sleep insights composition.
 *
 * Pulls the analytics `sleepStages` aggregate (added in v1.4.23 W2)
 * plus the SLEEP_DURATION trend series via `<SleepDurationChart>` and
 * renders two blocks:
 *
 *   1. Stage composition stacked bar (REM / Deep / Core / Awake / In
 *      bed / Asleep) — the canonical sleep-phase distribution.
 *   2. Duration trend chart with chart-cog parity (`chartKey="sleep"`).
 *
 * v1.22.0 — the leading "average per night" headline card was dropped:
 * the same figure + label already renders in `<AverageSleepCard>` inside
 * the shared sleep-rhythm grid row directly below, so the top card only
 * duplicated it.
 *
 * v1.18.7 W-D — the single-night "Last night" hypnogram card was removed:
 * its per-stage breakdown (time + %) duplicated the phase distribution the
 * stage stacked bar already shows directly below it. The `/api/sleep/night`
 * route stays (the dashboard still reads it); only this redundant surface is
 * gone.
 *
 * Empty state: no SLEEP_DURATION rows yet → render the "Apple Health
 * sync is coming in v1.5" message with a deep-link to Settings →
 * Integrations so the user can connect a sleep source. We do NOT render
 * any of the three blocks in that case — half-rendered empty cards would
 * be worse than a single clean CTA.
 */

interface SleepAnalyticsSummary {
  latest: number | null;
  avg7: number | null;
  avg30: number | null;
  count: number;
}

interface SleepAnalyticsResponse {
  summaries: {
    SLEEP_DURATION?: SleepAnalyticsSummary | null;
  };
  sleepStages: SleepStageBreakdown | null;
}

export function SleepOverview() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  // v1.4.33 IW2 — sleep overview reads `sleepStages` (a thick-only
  // field) alongside `summaries.SLEEP_DURATION`, so it stays on the
  // default thick slice. The shared hook still centralises the cache
  // settings (60s staleTime, no refetch on mount / window focus) so
  // the consumer behaves identically to every other analytics mount.
  const analyticsQuery = useAnalyticsQuery();
  const data = analyticsQuery.data as SleepAnalyticsResponse | undefined;
  const isLoading = analyticsQuery.isLoading;

  const sleepSummary = data?.summaries?.SLEEP_DURATION ?? null;
  const sleepStages = data?.sleepStages ?? null;
  const totalCount = sleepSummary?.count ?? 0;

  if (!isLoading && totalCount === 0) {
    return (
      <EmptyState
        icon={<Moon className="size-6" />}
        title={t("insights.sleep.empty.title")}
        description={t("insights.sleep.empty.description")}
        action={
          <Button size="sm" variant="outline" asChild>
            <Link href="/settings/integrations">
              {t("insights.sleep.empty.action")}
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* While the read is in flight the bar's own skeleton holds its
          place: the "stages unavailable" card is a statement about the data,
          and painting it before the data arrived both said something untrue
          and pushed the duration chart down when the bar replaced it. */}
      {isLoading ? (
        <ChartSkeleton />
      ) : sleepStages ? (
        <SleepStageStackedBar breakdown={sleepStages} />
      ) : (
        <Card>
          <CardContent className="text-muted-foreground py-6 text-sm">
            {t("insights.sleep.stages.unavailable")}
          </CardContent>
        </Card>
      )}

      <SleepDurationChart
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />
    </div>
  );
}
