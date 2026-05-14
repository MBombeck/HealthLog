"use client";

import type { ReactNode } from "react";

import { useAuth } from "@/hooks/use-auth";
import { InsightsTabStrip } from "@/components/insights/insights-tab-strip";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";

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
 * CRITICAL — the `<CoachDrawer>` does NOT mount here. It lives only in
 * `src/app/insights/page.tsx` body so navigating into a sub-page
 * unmounts the drawer.
 */
export function InsightsLayoutShell({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const advisor = useInsightsAdvisorQuery(isAuthenticated);

  return (
    <div className="space-y-8">
      <InsightsTabStrip
        onRegenerate={isAuthenticated ? advisor.regenerate : undefined}
        regenerating={advisor.isRegenerating}
      />
      {children}
    </div>
  );
}
