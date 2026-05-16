"use client";

import { useAuth } from "@/hooks/use-auth";
import { hasMetricData, type InsightMetric } from "@/lib/insights/metric-availability";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import type { SubPageAnalyticsData } from "@/types/analytics";

/**
 * v1.4.28 R3d (BK-F-H1) — shared React-Query wrapper for the analytics
 * payload behind every insights sub-page.
 *
 * The five hard-data sub-pages (`puls`, `blutdruck`, `gewicht`, `bmi`,
 * `schlaf`) each used to declare:
 *
 *   - a private `AnalyticsData` interface,
 *   - a `useQuery({ queryKey: ["analytics"], staleTime: 60_000 })` block,
 *   - an `if (isAuthenticated && analytics && !hasMetricData(...)) { … }`
 *     short-circuit that rendered a sub-page-specific empty state.
 *
 * Those three are now collapsed onto this hook:
 *
 *   - the query reuses the same `["analytics"]` cache key as the
 *     dashboard + the insights mother page, so navigating between
 *     surfaces is a free cache hit;
 *   - `isEmpty` runs `hasMetricData()` with the caller's metric so
 *     each sub-page checks the right gate without re-importing the
 *     helper;
 *   - the typed result keeps the existing `data` slot so any caller
 *     that still needs a richer field (today: none — the sub-pages
 *     only read `summaries`) can fall back to direct access.
 *
 * The mood and medication sub-pages still need richer payloads
 * (`/api/insights/comprehensive`) so they don't consume this hook —
 * those keep their bespoke fetch but adopt the same `<MetricEmptyState>`
 * primitive for the empty-state render so the visual contract is one.
 */
export interface UseInsightsAnalyticsResult {
  data: SubPageAnalyticsData | undefined;
  isLoading: boolean;
  /**
   * True when the analytics payload arrived AND the metric has no
   * observations. Sub-pages render the empty-state primitive when this
   * flips true. False while the query is still in-flight (we don't
   * want to flash the empty state before the data lands).
   */
  isEmpty: boolean;
  error: Error | null;
}

export function useInsightsAnalytics(
  metric: InsightMetric,
): UseInsightsAnalyticsResult {
  const { isAuthenticated } = useAuth();
  // v1.4.33 IW2 — sub-pages only read `summaries[METRIC].count` for the
  // gating short-circuit, so they ride on the slim slice. The mother
  // page keeps the default thick slice for `correlations` /
  // `healthScore` / `bpInTargetPct*`; both consumers live in the same
  // queryKey tree (root `["analytics"]`) but the slim slice has its own
  // cache slot under `["analytics", "summaries"]`.
  const query = useAnalyticsQuery({ slice: "summaries" });
  const data = query.data as SubPageAnalyticsData | undefined;

  const isEmpty =
    Boolean(isAuthenticated) &&
    data !== undefined &&
    !hasMetricData(metric, {
      summaries: data.summaries,
      // Sub-pages that go through this hook are sensor-backed only
      // (PULSE / WEIGHT / BMI / BLOOD_PRESSURE_SYS / SLEEP_DURATION).
      // Mood + medication run their own gate.
      hasMood: false,
      hasMedication: false,
    });

  return {
    data,
    isLoading: query.isLoading,
    isEmpty,
    error: query.error as Error | null,
  };
}
