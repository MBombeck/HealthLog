"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Loader2, TrendingUp } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { HeroStrip } from "@/components/insights/hero-strip";
import { DailyBriefing } from "@/components/insights/daily-briefing";
import { TrendsRow } from "@/components/insights/trends-row";
import { CorrelationRow } from "@/components/insights/correlation-row";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import type { CorrelationResult } from "@/lib/insights/correlations";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * v1.4.25 W4d — Insights mother page.
 *
 * The page used to be a single 1.8k-LOC monolith that scroll-anchored
 * six per-metric sections beneath the hero. W4a/c carved those out
 * into routed sub-pages under `/insights/{slug}`; this file now holds
 * the overview-only surface:
 *
 *   - The sticky tab strip lives in `src/app/insights/layout.tsx`
 *     (the shared `<InsightsLayoutShell>` mounts it). The strip handles
 *     navigation to every sub-page + the regenerate affordance.
 *   - Hero + DailyBriefing + Correlation row + Trends row + advisor
 *     card stay here — they're the cross-metric overview.
 *   - The CoachDrawer is mounted in the mother-page body only (Marc
 *     directive). Navigating to a sub-page unmounts the drawer.
 *
 * The per-section status cards (BP/Weight/Pulse/etc.) and their
 * heavy chart wiring moved to the matching sub-pages.
 */

/**
 * The mother page only checks whether the comprehensive payload arrived
 * (the EmptyState gates on `!data`); the metric-specific shape lives on
 * the sub-pages now. Keep this slim — anything more is dead weight here.
 */
interface ComprehensiveData {
  totalMeasurements: number;
}

interface AnalyticsData {
  summaries: Record<string, DataSummary>;
  correlations?: {
    bpCompliance: CorrelationResult;
    moodPulse: CorrelationResult;
    weightWeekday: CorrelationResult;
  } | null;
  healthScore?: {
    score: number;
    band: "green" | "yellow" | "red";
    components: {
      // v1.4.25 W8e — the optional `source`/`asOf` slots feed the
      // provenance accordion. Older clients reading this payload
      // happily ignore the extras (additive contract).
      bp: {
        value: number | null;
        weight: number;
        source?: "manual" | "withings" | "appleHealth" | "mixed" | "none";
        asOf?: string;
      };
      weight: {
        value: number | null;
        weight: number;
        source?: "manual" | "withings" | "appleHealth" | "mixed" | "none";
        asOf?: string;
      };
      mood: {
        value: number | null;
        weight: number;
        source?: "manual" | "withings" | "appleHealth" | "mixed" | "none";
        asOf?: string;
      };
      compliance: {
        value: number | null;
        weight: number;
        source?: "manual" | "withings" | "appleHealth" | "mixed" | "none";
        asOf?: string;
      };
    };
    delta: number | null;
  } | null;
}

export default function InsightsPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();

  // v1.4.28 FB-D3 — mirror `<SubPageShell>`'s deferred scroll-reset on
  // the mother page so a back-navigation from a sub-page (where
  // `SubPageShell` already reset the scroll on mount) lands cleanly
  // at the top of the overview instead of inheriting the sub-page's
  // vertical position through the cached scroll state. Single
  // mount-only effect; uses `requestAnimationFrame` so the reset
  // settles after first paint, same as the sub-page shell.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(handle);
  }, []);

  // v1.4.27 R3d MB4 — Coach drawer state lives in the layout-level
  // `<CoachLaunchProvider>` so every routed sub-page can reach it.
  // The hero strip + suggested-prompt chips call `askCoach(prefill)`
  // on the same context, and the drawer itself is mounted next to
  // the provider in `src/app/insights/layout.tsx`.
  const coachLaunch = useCoachLaunch();

  const { data, isLoading } = useQuery({
    queryKey: ["insights", "comprehensive"],
    queryFn: async () => {
      const res = await fetch("/api/insights/comprehensive");
      if (!res.ok) throw new Error(t("insights.loadError"));
      const json = await res.json();
      return json.data as ComprehensiveData;
    },
    enabled: isAuthenticated,
  });

  // The advisor query is also mounted by the layout shell; the page
  // consumer re-reads from the same cache key so this call is free
  // beyond the React-state subscription.
  const advisor = useInsightsAdvisorQuery(isAuthenticated);

  const { data: analytics } = useQuery({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch("/api/analytics");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as AnalyticsData;
    },
    enabled: isAuthenticated,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!data) {
    return (
      <EmptyState
        icon={<TrendingUp className="size-6" />}
        title={t("insights.emptyTitle")}
        description={t("insights.emptyDescription")}
        action={
          <Button size="sm" asChild>
            <Link href="/measurements">
              {t("insights.emptyAddMeasurement")}
            </Link>
          </Button>
        }
      />
    );
  }

  const heroGreetingName =
    user?.username?.trim() && user.username.trim().length > 0
      ? user.username.split(/\s+/)[0]
      : null;
  const briefingPayload = advisor.payload?.dailyBriefing ?? null;
  const heroStripUpdatedAt = advisor.payload?.cachedAt ?? null;

  return (
    <div className="space-y-8">
      <HeroStrip
        briefing={briefingPayload}
        updatedAt={heroStripUpdatedAt}
        userName={heroGreetingName}
        onAskCoach={
          coachLaunch
            ? (prefill?: string) => coachLaunch.askCoach(prefill ?? null)
            : undefined
        }
        onPickPrompt={
          coachLaunch
            ? (prompt) => coachLaunch.askCoach(prompt)
            : undefined
        }
        healthScore={analytics?.healthScore ?? undefined}
      />

      <DailyBriefing
        briefing={briefingPayload}
        updatedAt={heroStripUpdatedAt}
        loading={advisor.isLoading}
        onRegenerate={advisor.regenerate}
        regenerating={advisor.isRegenerating}
      />

      {analytics?.correlations && (
        <CorrelationRow results={analytics.correlations} />
      )}

      <TrendsRow annotations={advisor.payload?.trendAnnotations ?? null} />
    </div>
  );
}
