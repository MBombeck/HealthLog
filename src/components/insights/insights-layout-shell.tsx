"use client";

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { InsightsTabStrip } from "@/components/insights/insights-tab-strip";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import type { InsightInputs } from "@/lib/insights/metric-availability";
import type { DataSummary } from "@/lib/analytics/trends";

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
 * power the tab-strip availability gate. Both queries share their
 * cache keys with the sub-page consumers (`["analytics"]` and
 * `["insights", "comprehensive"]`) so the cost stays one fetch per
 * route, dedup-shared across consumers.
 *
 * CRITICAL — the `<CoachDrawer>` does NOT mount here. It lives only in
 * `src/app/insights/page.tsx` body so navigating into a sub-page
 * unmounts the drawer.
 */
interface AnalyticsPayload {
  summaries?: Record<string, DataSummary>;
}

interface ComprehensivePayload {
  moodSummary: { count: number } | null;
  medications: Array<{ id: string }>;
}

export function InsightsLayoutShell({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const advisor = useInsightsAdvisorQuery(isAuthenticated);

  // Shared analytics fetch — sub-pages consume the same cache key.
  const analyticsQuery = useQuery({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch("/api/analytics");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as AnalyticsPayload;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  // Shared comprehensive fetch — mood + medication signals for the
  // event-driven gating branches. Sub-pages read the same key so the
  // payload lands once per route.
  const comprehensiveQuery = useQuery({
    queryKey: ["insights", "comprehensive"],
    queryFn: async () => {
      const res = await fetch("/api/insights/comprehensive");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as ComprehensivePayload;
    },
    enabled: isAuthenticated,
  });

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
  const availability: InsightInputs | undefined = useMemo(() => {
    if (!isAuthenticated) return undefined;
    return { summaries, hasMood, hasMedication };
  }, [isAuthenticated, summaries, hasMood, hasMedication]);

  return (
    <div className="space-y-8">
      <InsightsTabStrip
        onRegenerate={isAuthenticated ? advisor.regenerate : undefined}
        regenerating={advisor.isRegenerating}
        availability={availability}
      />
      {children}
    </div>
  );
}
