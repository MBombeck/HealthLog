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
}

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
      const res = await fetch(`/api/insights/${metric}-status?locale=${locale}`);
      if (!res.ok) throw new Error("Failed");
      const json = (await res.json()) as { data: InsightStatusData };
      return json.data;
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });
}
