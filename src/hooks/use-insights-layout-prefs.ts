"use client";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import {
  resolveDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

/**
 * v1.4.25 W4 — shared reader for the dashboard-layout payload across
 * the insights surfaces.
 *
 * The mother page and every sub-page need the persisted
 * `comparisonBaseline` so the dashboard / insights chart-cog stays
 * in sync. The shape repeats the same `useQuery({ … queryKey:
 * queryKeys.dashboardWidgets() … })` four-line block that lived inline
 * on the mother page — extracted here so a new sub-page consumer drops
 * the boilerplate and so the TanStack-Query cache lookup stays
 * authoritative for every consumer.
 *
 * Returns the resolved `comparisonBaseline` (defaults to `"none"`)
 * directly so consumers don't have to remember the `resolveDashboardLayout`
 * fallback dance. `enabled` controls whether the query fires — the
 * sub-pages gate this on `useAuth().isAuthenticated`.
 */
export function useInsightsLayoutPrefs(enabled: boolean) {
  const { data } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      const res = await fetch("/api/dashboard/widgets");
      if (!res.ok) throw new Error("Failed to load dashboard layout");
      const json = await res.json();
      return json.data as DashboardLayout;
    },
    enabled,
  });
  const compareBaseline =
    resolveDashboardLayout(data).comparisonBaseline ?? "none";
  return { layout: data ?? null, compareBaseline } as const;
}
