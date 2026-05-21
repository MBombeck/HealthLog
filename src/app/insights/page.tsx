"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { TrendingUp } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useScrollResetOnRoute } from "@/hooks/use-scroll-reset-on-route";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { HeroStrip } from "@/components/insights/hero-strip";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
// v1.4.41 W-ORG — shared shape lives in `src/types/analytics.ts` as
// `InsightsAnalyticsData`; aliased back to the local name to keep the
// rest of this file readable.
import type { InsightsAnalyticsData as AnalyticsData } from "@/types/analytics";

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

  // v1.4.36 W1 — drop the page-level `isLoading` gate that used to
  // block the entire shell on `/api/insights/comprehensive`. The
  // comprehensive payload still feeds the empty-state decision but
  // every other section now mounts in parallel under its own
  // <Suspense> boundary, so the user sees the hero + tile skeletons
  // within ~500 ms instead of waiting on the slowest fan-out. The
  // empty-state branch only fires once the query has resolved AND
  // reported zero measurements; while it's in-flight the page paints
  // the regular shell and the tiles fill in as their data lands.
  const { data, isLoading, isFetched } = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
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

  // Empty-state shortcut — only paint once the comprehensive query has
  // resolved AND reported zero measurements. While it's in-flight we
  // fall through to the streamed shell so the user gets the hero +
  // skeleton tiles inside the first paint budget.
  if (!isLoading && isFetched && !data) {
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

  // v1.4.36 QA C2 — no `<Suspense>` wrappers below. The mother page is
  // `"use client"`, the below-the-fold blocks load via `next/dynamic`
  // with `{ ssr: false }` (no Promise-throw on hydrate), and the
  // TanStack Query hooks each return their own loading state without
  // ever throwing a thenable. Wrapping these in `<Suspense>` would be
  // dead code — Suspense never engages and the `loading` props inside
  // each section already drive the skeleton. The perceptual win we
  // ship is "early-skeleton paint": the page-level `isLoading` gate is
  // gone, the hero + each section's own loader skeleton paints inside
  // the first paint budget while data fills in. Genuinely streamed
  // server children would require a Server-Component refactor; that's
  // a v1.5.x track.

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

      <TrendsRow
        annotations={advisor.payload?.trendAnnotations ?? null}
        loading={advisor.isLoading || advisor.isRegenerating}
      />
    </div>
  );
}
