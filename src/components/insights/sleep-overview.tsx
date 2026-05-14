"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Moon } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  SleepStageStackedBar,
  type SleepStageBreakdown,
} from "./sleep-stage-stacked-bar";
import { SleepDurationChart } from "./sleep-duration-chart";

/**
 * v1.4.25 W4c — Sleep insights composition.
 *
 * Pulls the analytics `sleepStages` aggregate (added in v1.4.23 W2)
 * plus the SLEEP_DURATION trend series via `<SleepDurationChart>` and
 * renders three blocks:
 *
 *   1. Headline card with the average nightly total (h / min) and the
 *      number of nights covered.
 *   2. Stage composition stacked bar (REM / Deep / Core / Awake / In
 *      bed / Asleep).
 *   3. Duration trend chart with chart-cog parity (`chartKey="sleep"`).
 *
 * Empty state: no SLEEP_DURATION rows yet → render the "Apple Health
 * sync is coming in v1.5" message with a deep-link to Settings →
 * Devices so the user can prepare. We do NOT render any of the three
 * blocks in that case — half-rendered empty cards would be worse than
 * a single clean CTA.
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

function formatHoursMinutes(
  totalMinutes: number,
  locale: string,
): { primary: string } {
  const hours = Math.floor(totalMinutes / 60);
  const mins = Math.round(totalMinutes - hours * 60);
  if (locale === "de") {
    return { primary: `${hours} Std. ${mins} Min.` };
  }
  return { primary: `${hours}h ${mins}m` };
}

export function SleepOverview() {
  const { isAuthenticated, user } = useAuth();
  const { t, locale } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { data, isLoading } = useQuery({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch("/api/analytics");
      if (!res.ok) throw new Error("Failed to load analytics");
      const json = await res.json();
      return json.data as SleepAnalyticsResponse;
    },
    enabled: isAuthenticated,
  });

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
            <Link href="/settings/devices">
              {t("insights.sleep.empty.action")}
            </Link>
          </Button>
        }
      />
    );
  }

  const averageMinutes = sleepSummary?.avg30 ?? sleepSummary?.avg7 ?? null;
  const suffix = t("insights.sleep.headlineCaptionSuffix");
  const { primary } =
    averageMinutes != null
      ? formatHoursMinutes(averageMinutes, locale)
      : { primary: "—" };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Moon className="text-dracula-cyan h-4 w-4" />
            <CardTitle className="text-sm font-medium">
              {t("insights.sleep.headlineTitle")}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            <p className="text-2xl font-semibold">{primary}</p>
            <p className="text-muted-foreground text-xs">
              {sleepSummary?.count
                ? t("insights.sleep.headlineCaption", {
                    count: sleepSummary.count,
                    suffix,
                  })
                : suffix}
            </p>
          </div>
        </CardContent>
      </Card>

      {sleepStages ? (
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
