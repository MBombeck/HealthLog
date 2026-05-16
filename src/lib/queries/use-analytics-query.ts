"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import type { DataSummary } from "@/lib/analytics/trends";
import type { SubPageAnalyticsData } from "@/types/analytics";

/**
 * v1.4.33 IW2 — single TanStack-Query wrapper for `/api/analytics`.
 *
 * Pre-fix, seven mount sites each declared `useQuery({ queryKey:
 * ["analytics"], … })` with inconsistent `staleTime` / `enabled` /
 * `refetchOnMount` options. TanStack treats the first-mount wins → the
 * earliest consumer's options govern the shared cache cell, but every
 * route-change re-mount still spins up a fresh subscription tree and
 * any consumer without an `enabled: isAuthenticated` short-circuit
 * re-issues the network on a back-forward swing. The audit
 * (`.planning/round-v1433-audit-perf.md` §1) ranks this as the top-1
 * ROI win.
 *
 * The shared hook:
 *   - centralises the queryKey via `queryKeys.analytics(slice)`,
 *   - sets `staleTime: 60_000` so a route swing within a minute is a
 *     free cache hit,
 *   - sets `refetchOnMount: false` + `refetchOnWindowFocus: false` so
 *     route transitions never trigger a refetch storm,
 *   - defaults to `enabled: isAuthenticated` so the unauthenticated
 *     surfaces (registration, sign-in) don't spin up a 401-bound
 *     request,
 *   - lets the caller opt into the slim `?slice=summaries` server
 *     branch shipped in IW1 / C1 when the consumer only needs the
 *     per-type DataSummary headlines (sub-pages, gating helpers,
 *     onboarding checklist).
 *
 * The dashboard's mother query keeps the default slice because it also
 * reads `bpInTargetPct*` and `glucoseByContext` — those slots stay
 * stubbed on the slim path per the IW1 follow-up.
 */

/**
 * Strict structural subset shared between the slim slice and the thick
 * default payload. Consumers that only read `summaries` should type
 * the hook return as `AnalyticsSlicePayload` (or import
 * `SubPageAnalyticsData` directly — same shape, kept aliased for
 * call-site clarity).
 */
export type AnalyticsSlicePayload = SubPageAnalyticsData;

/**
 * Discriminator for the server-side slice. `undefined` (the default)
 * routes onto the thick payload; `"summaries"` routes onto IW1's
 * `?slice=summaries` branch.
 */
export type AnalyticsSlice = "summaries" | undefined;

/**
 * The unwrapped `data` field returned by the API. Typed as a wide
 * shape so the dashboard's `bpInTargetPct*` / `glucoseByContext`
 * consumers can narrow without a runtime cast. The slim slice fills
 * the optional thick fields with `null` / empty so call-site reads
 * remain undefined-safe.
 */
export interface AnalyticsRawPayload {
  summaries: Record<string, DataSummary>;
  // Thick-only fields — present on the default slice, stubbed on the
  // slim branch. Optional so the type covers both shapes.
  bpInTargetPct?: number | null;
  bpInTargetPct7d?: number | null;
  bpInTargetPct30d?: number | null;
  bpInTargetPctAllTime?: number | null;
  bpInTargetPctPriorMonth?: number | null;
  bpInTargetPctPriorYear?: number | null;
  glucoseByContext?: Record<string, unknown>;
  correlations?: unknown;
  healthScore?: unknown;
  sleepStages?: unknown;
  /**
   * v1.4.34 IW-B — per-type freshness map. The dashboard's tile strip
   * reads `lastSeenByType[type]?.daysAgo` and forwards it to each
   * `<TrendCard>` so a stale tile renders an "Letzter Wert vor Xd"
   * caption instead of disappearing. Present on both the thick default
   * and the slim `?slice=summaries` branch.
   */
  lastSeenByType?: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  >;
  // Keep the contract open — additive server fields don't need a
  // type bump every release.
  [key: string]: unknown;
}

export interface UseAnalyticsQueryOptions {
  /**
   * `"summaries"` — hit IW1's slim slice (2 SQL passes, no
   * correlations / health-score / bp-in-target / sleep-stages).
   * Omit (or pass `undefined`) for the thick default payload.
   */
  slice?: AnalyticsSlice;
  /**
   * Optional override for the auth gate. Defaults to
   * `isAuthenticated`. The Insights mother page can pass extra
   * disabled-flag composition without losing the auth gate.
   */
  enabled?: boolean;
}

async function fetchAnalytics(
  slice: AnalyticsSlice,
): Promise<AnalyticsRawPayload> {
  const url =
    slice === "summaries" ? "/api/analytics?slice=summaries" : "/api/analytics";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load analytics (${res.status})`);
  }
  const json = (await res.json()) as { data: AnalyticsRawPayload };
  return json.data;
}

/**
 * Shared hook. Returns the raw `data` payload typed as
 * `AnalyticsRawPayload`. Consumers can narrow at the call site (e.g.
 * `const summaries = query.data?.summaries;`).
 */
export function useAnalyticsQuery(
  options: UseAnalyticsQueryOptions = {},
): UseQueryResult<AnalyticsRawPayload, Error> {
  const { isAuthenticated } = useAuth();
  const slice = options.slice;
  const enabled =
    options.enabled !== undefined ? options.enabled : isAuthenticated;

  return useQuery({
    queryKey: queryKeys.analytics(slice),
    queryFn: () => fetchAnalytics(slice),
    enabled,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
}
