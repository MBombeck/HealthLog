"use client";

/**
 * v1.7.0 W6 — unified dashboard first-paint snapshot hook.
 *
 * One client cell against `GET /api/dashboard/snapshot` that hydrates
 * every above-the-fold tile, replacing the legacy four-cell waterfall
 * (slim analytics + thick analytics + mood + widget layout). Three
 * properties matter:
 *
 *   - It is NOT gated on `isAuthenticated`. The server `requireAuth()`
 *     is the real gate (401 on a missing cookie); on the dashboard
 *     route the cookie is always present because `src/proxy.ts` has
 *     already passed the auth / onboarding redirect. Firing un-gated
 *     removes the `/api/auth/me` round-trip from the cold critical path
 *     (R-firstpaint §1a — the single biggest first-byte win).
 *   - `staleTime: 60_000` + `refetchOnMount: false` +
 *     `refetchOnWindowFocus: false` mirror `DASHBOARD_QUERY_OPTS` so a
 *     return-to-dashboard within a minute is a free cache hit.
 *   - `refetchInterval: 120_000` + `refetchIntervalInBackground: false`
 *     keep an open dashboard live: an idle tab polls the snapshot every
 *     two minutes so freshly-synced Withings / HealthKit readings appear
 *     without a manual reload. The poll hits the warm 60 s server cache
 *     cheaply and only triggers a sub-second rollup rebuild when the
 *     underlying data actually changed — never the LLM surfaces, which
 *     stay daily / pre-generated. The interval pauses while the tab is
 *     backgrounded.
 *   - The queryKey is the centralised factory entry
 *     `queryKeys.dashboardSnapshot()`.
 */
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";

async function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  const res = await fetch("/api/dashboard/snapshot");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.data as DashboardSnapshot;
}

export function useDashboardSnapshot(enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboardSnapshot(),
    queryFn: fetchDashboardSnapshot,
    enabled,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchInterval: DASHBOARD_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
