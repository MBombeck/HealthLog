"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  computeLocalBatchWindow,
  deriveBatchChartTypes,
  type BatchWindow,
} from "@/lib/dashboard/batch-chart-types";
import { resolveDashboardLayout } from "@/lib/dashboard-layout";
import { useDailyDigest } from "@/lib/queries/use-daily-digest";
import { useDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";
import { queryKeys } from "@/lib/query-keys";
import type { DashboardAnalyticsData as AnalyticsData } from "@/types/analytics";

/** One day of the batched series the dashboard charts read their slice from. */
export interface BatchedSeriesRow {
  value: number;
  measuredAt: string;
  count?: number;
  minValue?: number | null;
  maxValue?: number | null;
}

export interface DashboardMoodData {
  entries: Array<{ date: string; score: number; samples: number }>;
  summary: DataSummary;
}

/**
 * The tiles' `AnalyticsData` from the snapshot. `extras` is null on a
 * rollup-coverage miss (two-phase contract), so the BP-in-target and glucose
 * fields stay undefined and those tiles shimmer while the rest of the strip
 * paints.
 */
function assembleDashboardAnalytics(
  snap: ReturnType<typeof useDashboardSnapshot>["data"],
): AnalyticsData | undefined {
  if (!snap) return undefined;
  return {
    summaries: snap.tiles.summaries,
    lastSeenByType: snap.tiles.lastSeenByType,
    // Optional on the snapshot (additive contract).
    sleepSourceDiscrepancy: snap.tiles.sleepSourceDiscrepancy ?? null,
    bpInTargetPct: snap.extras?.bpInTargetPct ?? null,
    bpInTargetPct7d: snap.extras?.bpInTargetPct7d ?? null,
    bpInTargetPct30d: snap.extras?.bpInTargetPct30d ?? null,
    bpInTargetPctAllTime: snap.extras?.bpInTargetPctAllTime ?? null,
    bpInTargetPctPriorMonth: snap.extras?.bpInTargetPctPriorMonth ?? null,
    bpInTargetPctPriorYear: snap.extras?.bpInTargetPctPriorYear ?? null,
    bpInTargetCount90: snap.extras?.bpInTargetCount90 ?? null,
    bpInTargetSpanDays90: snap.extras?.bpInTargetSpanDays90 ?? null,
    glucoseByContext: snap.extras?.glucoseByContext as
      Record<string, DataSummary> | undefined,
  };
}

/**
 * Every read the dashboard's tiles and charts paint from.
 *
 * The tiles hydrate from ONE un-gated `/api/dashboard/snapshot` cell, so the
 * whole strip shares one completion moment and `/api/auth/me` leaves the cold
 * critical path.
 *
 * The Today hero's digest is read here too, in its original place in the read
 * order: it is the day's data, so no module owns it, and it is gated on auth
 * only.
 */
export function useDashboardData({
  isAuthenticated,
  mounted,
  batchWindowProp,
}: {
  isAuthenticated: boolean;
  mounted: boolean;
  /**
   * The batched-series window the RSC prefetch computed from the profile
   * time zone. Adopted verbatim so the `chartSeriesBatch` key matches the key
   * the server dehydrated under; absent when the prefetch is off, where the
   * browser-local window stands in.
   */
  batchWindowProp?: BatchWindow;
}) {
  const snapshotQuery = useDashboardSnapshot();
  const digestQuery = useDailyDigest(isAuthenticated);
  const data = useMemo(
    () => assembleDashboardAnalytics(snapshotQuery.data),
    [snapshotQuery.data],
  );
  // The snapshot publishes its layout with switched-off modules' widgets
  // already hidden.
  const layoutData = snapshotQuery.data?.layout;
  const moodData: DashboardMoodData | undefined = snapshotQuery.data
    ? {
        entries: snapshotQuery.data.tiles.mood.entries,
        summary: (snapshotQuery.data.tiles.mood.summary ??
          undefined) as DataSummary,
      }
    : undefined;

  // Visibility and order of every widget.
  const layout = resolveDashboardLayout(layoutData);

  // ONE batched fetch for every visible non-sleep chart series; each chart
  // reads its slice through `preloadedSeries` instead of self-fetching. Sleep
  // stays on its per-night `/series` adapter and is never batched. The type
  // set is the shared `deriveBatchChartTypes`, the same function the RSC
  // prefetch runs over the same snapshot fields, so the cache key is
  // byte-identical on both sides.
  const batchChartTypes = deriveBatchChartTypes(layout, data?.summaries);

  // A day-bucketed window, computed once per mount (lazy state) so a
  // re-render never re-keys the batch. The server-computed window wins when
  // present; lazy state with a prop-derived initial value is deterministic
  // across the SSR / CSR pair.
  const [batchWindow] = useState(
    () => batchWindowProp ?? computeLocalBatchWindow(),
  );

  const { data: batchedSeries } = useQuery({
    queryKey: queryKeys.chartSeriesBatch(
      batchChartTypes.join(","),
      batchWindow.from,
      batchWindow.to,
    ),
    enabled: isAuthenticated && mounted && batchChartTypes.length > 0,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const sp = new URLSearchParams();
      sp.set("types", batchChartTypes.join(","));
      sp.set("from", batchWindow.from);
      sp.set("to", batchWindow.to);
      const res = await apiGet<{
        series: Record<string, BatchedSeriesRow[]>;
      }>(`/api/measurements/series-batch?${sp}`);
      return res.series;
    },
  });

  // `!mounted` pins the SSR pass and the hydration render to the skeleton
  // branch (server-side the data queries are disabled, and a late hydrating
  // boundary would otherwise render the skeleton where the server rendered
  // the empty state: React #418). The hero band and the strip share this one
  // gate so both swap to content in the same render pass.
  const primaryLoading = !mounted || snapshotQuery.isLoading;

  return {
    snapshot: snapshotQuery.data,
    digestQuery,
    data,
    layoutData,
    layout,
    moodData,
    preloadedSeries: batchedSeries,
    primaryLoading,
  };
}

export type DashboardData = ReturnType<typeof useDashboardData>;
