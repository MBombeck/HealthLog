"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/**
 * Shape returned by every `/api/insights/<metric>-status` endpoint.
 *
 * - `hasProvider` — whether the user has configured an AI provider; the
 *   sub-page hides the status card entirely when false.
 * - `text` — the rendered status string; null when the provider has
 *   not yet produced one.
 * - `cached` — whether the payload came from the per-locale cache or a
 *   fresh provider round-trip.
 * - `updatedAt` — ISO timestamp of the cached payload's creation, or
 *   null when the route has never produced a value.
 */
export interface InsightStatusData {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  /**
   * v1.8.3 — the route is read-only: a cache miss enqueues an out-of-band
   * generation and returns `preparing: true` with `text: null`. The card
   * shows a preparing state and the hook polls (bounded) until the worker
   * warms the cache. Absent / false means the payload is terminal.
   */
  preparing?: boolean;
}

/**
 * v1.8.3 — client-side ceiling on the status GET. The route is now
 * read-only (sub-second cache read), so a slow response means the network
 * itself is degraded, not the LLM. Mirror the advisor hook's 8 s
 * `ADVISOR_TIMEOUT_MS`: abort and surface the empty / preparing state
 * rather than letting a hung request pin the navigation. No user
 * navigation may ever await an uncapped round-trip.
 */
const STATUS_TIMEOUT_MS = 8_000;

/**
 * Poll interval while a card is `preparing`. Bounded by `staleTime` so a
 * settled (terminal) payload never re-fetches on a timer; only the
 * preparing state keeps polling, and it stops as soon as text lands.
 */
const STATUS_POLL_MS = 4_000;

/**
 * Metric slugs the sub-pages render. Each slug is paired with the
 * Insights-status endpoint and the matching `queryKeys.*` factory so
 * the cache keys stay aligned across the whole app — a hard-coded
 * `["insights", "weight-status", locale]` array typoed once is exactly
 * the class of bug `queryKeys` was introduced to defend against.
 */
type InsightStatusMetric =
  | "blood-pressure"
  | "weight"
  | "pulse"
  | "bmi"
  | "mood"
  | "medication-compliance";

const QUERY_KEY_FACTORY: Record<
  InsightStatusMetric,
  (locale: string) => readonly unknown[]
> = {
  "blood-pressure": queryKeys.insightsBpStatus,
  weight: queryKeys.insightsWeightStatus,
  pulse: queryKeys.insightsPulseStatus,
  bmi: queryKeys.insightsBmiStatus,
  mood: queryKeys.insightsMoodStatus,
  "medication-compliance": queryKeys.insightsMedicationComplianceStatus,
};

/**
 * Shared loader for the insight-status payload backing
 * `/insights/<metric>` sub-pages. Five sub-pages previously copy-pasted
 * the same 13-line useQuery block plus an identical `XxxStatusData`
 * interface; the hook collapses them onto one helper plus the existing
 * `queryKeys` factory so the next "add a metric" PR touches one map
 * entry instead of an entire page module.
 *
 * Returns the `useQuery` result narrowed to the `InsightStatusData`
 * payload — callers stay free to use `data` / `isLoading` / refetch
 * helpers without an extra unwrap.
 */
export function useInsightStatus(metric: InsightStatusMetric) {
  const { isAuthenticated } = useAuth();
  const { locale } = useTranslations();

  return useQuery({
    queryKey: QUERY_KEY_FACTORY[metric](locale),
    queryFn: async (): Promise<InsightStatusData> => {
      // v1.8.3 — bound the fetch on the client. AbortController + 8 s
      // timeout so a degraded network can't pin the navigation thread.
      // The card surfaces its preparing / empty state on abort exactly as
      // it does for a `preparing` payload, and the bounded poll retries.
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        STATUS_TIMEOUT_MS,
      );
      try {
        const res = await fetch(
          `/api/insights/${metric}-status?locale=${locale}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error("Failed");
        const json = (await res.json()) as { data: InsightStatusData };
        return json.data;
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
    // v1.4.28 FB-D2 — the status route returns a deterministic envelope on
    // a miss/timeout. Retrying inline re-fires work and lengthens the
    // perceived hang; the bounded `preparing` poll below covers the warm-up.
    retry: 0,
    // v1.8.3 — poll only while the worker is preparing the assessment.
    // Returns false (no timer) for any terminal payload so a settled card
    // never re-fetches on an interval.
    refetchInterval: (query) =>
      query.state.data?.preparing ? STATUS_POLL_MS : false,
  });
}
