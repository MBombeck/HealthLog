"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Loader2, TrendingUp } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useScrollResetOnRoute } from "@/hooks/use-scroll-reset-on-route";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { HeroStrip } from "@/components/insights/hero-strip";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import type { CorrelationResult } from "@/lib/insights/correlations";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * v1.4.33 IW2 — defer the three below-the-fold mother-page blocks
 * behind `next/dynamic`. `<HeroStrip>` (the only above-the-fold piece)
 * stays an eager import so the initial paint shows the greeting and
 * health-score badge without a flash; the briefing, correlation row
 * and trends row each carry their own icon-set + chart wiring (a chart
 * card alone weighs in at the lucide tree-shake limit) and used to
 * land on every Insights cold mount. Loader skeletons match the
 * existing fallback so the layout doesn't shift while the chunks
 * resolve.
 */
const DailyBriefing = dynamic(
  () =>
    import("@/components/insights/daily-briefing").then((mod) => ({
      default: mod.DailyBriefing,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="bg-card border-border h-48 animate-pulse rounded-xl border" />
    ),
  },
);
const CorrelationRow = dynamic(
  () =>
    import("@/components/insights/correlation-row").then((mod) => ({
      default: mod.CorrelationRow,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="bg-card border-border h-32 animate-pulse rounded-xl border" />
    ),
  },
);
const TrendsRow = dynamic(
  () =>
    import("@/components/insights/trends-row").then((mod) => ({
      default: mod.TrendsRow,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="bg-card border-border h-64 animate-pulse rounded-xl border" />
    ),
  },
);

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

  // v1.4.33 IW9 — scroll-to-top on route mount centralised in the
  // shared `useScrollResetOnRoute()` hook. The mother page + the
  // `<SubPageShell>` both consume the same hook; the legacy duplicate
  // RAF that lived here pre-v1.4.33 produced a visible double-snap on
  // slow hydrates (chart skeletons inflating between the two
  // callbacks).
  useScrollResetOnRoute();

  // v1.4.27 R3d MB4 — Coach drawer state lives in the layout-level
  // `<CoachLaunchProvider>` so every routed sub-page can reach it.
  // The hero strip + suggested-prompt chips call `askCoach(prefill)`
  // on the same context, and the drawer itself is mounted next to
  // the provider in `src/app/insights/layout.tsx`.
  const coachLaunch = useCoachLaunch();
  const flags = useFeatureFlags();

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

  // v1.4.33 IW2 — the mother page reads `correlations` + `healthScore`
  // (thick-only fields) so it stays on the default thick slice. The
  // shared hook still centralises the cache settings so the consumer
  // dedups with the sub-page mounts that ride the slim slice instead.
  const analyticsQuery = useAnalyticsQuery();
  const analytics = analyticsQuery.data as AnalyticsData | undefined;

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

      {flags.briefing && (
        <DailyBriefing
          briefing={briefingPayload}
          updatedAt={heroStripUpdatedAt}
          loading={advisor.isLoading}
          onRegenerate={advisor.regenerate}
          regenerating={advisor.isRegenerating}
        />
      )}

      {flags.correlations && analytics?.correlations && (
        <CorrelationRow results={analytics.correlations} />
      )}

      <TrendsRow annotations={advisor.payload?.trendAnnotations ?? null} />
    </div>
  );
}
