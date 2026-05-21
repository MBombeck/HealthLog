"use client";

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useWorkouts } from "@/hooks/use-workouts";
import { InsightsTabStrip } from "@/components/insights/insights-tab-strip";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { queryKeys } from "@/lib/query-keys";
import type { InsightInputs } from "@/lib/insights/metric-availability";

/**
 * v1.4.25 W4 — client shell for `src/app/insights/layout.tsx`.
 *
 * Owns the advisor query so the regenerate button on the sticky tab
 * strip works from every Insights surface (mother + the seven sub-
 * pages). TanStack Query dedup keeps the cost negligible: the mother
 * page's own `useInsightsAdvisorQuery` consumer shares the same
 * `queryKeys.insightsAdvisor()` key, so the two consumers reuse the
 * same cache entry without extra network traffic.
 *
 * v1.4.27 F19 — also owns the analytics + comprehensive reads that
 * power the tab-strip availability gate. The analytics consumer goes
 * through the shared `useAnalyticsQuery({ slice: "summaries" })` hook
 * (v1.4.33 IW2); the comprehensive consumer still owns its bespoke
 * fetch but shares its cache key with the sub-page consumers so the
 * payload lands once per route, dedup-shared across consumers.
 *
 * CRITICAL — the `<CoachDrawer>` does NOT mount here. It lives only in
 * `src/app/insights/page.tsx` body so navigating into a sub-page
 * unmounts the drawer.
 */
interface ComprehensivePayload {
  moodSummary: { count: number } | null;
  medications: Array<{ id: string }>;
}

export function InsightsLayoutShell({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  // v1.4.33 F18 — gate the advisor POST on the operator's assistant
  // feature flag. Pre-fix, every /insights mount fired POST
  // /api/insights/generate even when the operator had disabled the
  // briefing surface or the user had no AI provider configured. The
  // server returned 422 in that case and the regenerate button on the
  // tab strip rendered a non-functional spinner. Reading the flag
  // matrix off `/api/feature-flags` keeps the hot path one fetch
  // (shared `["feature-flags"]` cache, 60s staleTime) and skips the
  // advisor request entirely when the operator has the briefing gate
  // off. The fail-open default in `useFeatureFlags` means a network
  // hiccup still renders the advisor — the gate only takes effect when
  // the operator has explicitly turned the surface off.
  const flags = useFeatureFlags();
  const advisorEnabled =
    isAuthenticated && flags.enabled && flags.briefing;
  const advisor = useInsightsAdvisorQuery(advisorEnabled);

  // Shared analytics fetch — the layout shell only reads
  // `summaries[METRIC].count` for the tab-strip availability gate, so
  // it lands on IW1's slim `?slice=summaries` branch (2 SQL passes,
  // no correlations / health-score / bp-in-target tail).
  const analyticsQuery = useAnalyticsQuery({ slice: "summaries" });

  // Shared comprehensive fetch — mood + medication signals for the
  // event-driven gating branches. Sub-pages read the same key so the
  // payload lands once per route.
  const comprehensiveQuery = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: async () => {
      const res = await fetch("/api/insights/comprehensive");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as ComprehensivePayload;
    },
    enabled: isAuthenticated,
  });

  // v1.4.32 — workout-presence gate. The workouts pill gates on at
  // least one canonical row in the list-endpoint response. The
  // single-row probe shares its cache slot with the list page +
  // dashboard tile so navigation between surfaces is a free cache hit.
  const workoutsProbe = useWorkouts({ limit: 1 });

  // v1.4.31 — memoise the `availability` prop so an unchanged
  // payload doesn't recreate the object on every cache-write of
  // analytics or comprehensive. The strip is wrapped in
  // `React.memo` and would still rerun `buildTabs(availability)` on
  // every parent render if this prop kept arriving as a fresh
  // reference. Per
  // `.planning/research/v15-insights-blocking-bug.md` fix 2.
  const summaries = analyticsQuery.data?.summaries;
  const hasMood = (comprehensiveQuery.data?.moodSummary?.count ?? 0) > 0;
  const hasMedication =
    (comprehensiveQuery.data?.medications?.length ?? 0) > 0;
  const hasWorkouts = (workoutsProbe.data?.workouts.length ?? 0) > 0;
  const availability: InsightInputs | undefined = useMemo(() => {
    if (!isAuthenticated) return undefined;
    return { summaries, hasMood, hasMedication, hasWorkouts };
  }, [isAuthenticated, summaries, hasMood, hasMedication, hasWorkouts]);

  return (
    <div className="space-y-8">
      <InsightsTabStrip
        onRegenerate={advisorEnabled ? advisor.regenerate : undefined}
        regenerating={advisor.isRegenerating}
        availability={availability}
      />
      {children}
    </div>
  );
}
