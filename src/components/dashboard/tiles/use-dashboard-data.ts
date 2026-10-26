"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { AuthUser } from "@/hooks/use-auth";
import { useSurfaceVisible } from "@/hooks/use-surface-visible";
import { apiGet } from "@/lib/api/api-fetch";
import { mergeSlimAndThickAnalytics } from "@/lib/analytics/merge-slim-thick";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  computeLocalBatchWindow,
  deriveBatchChartTypes,
  type BatchWindow,
} from "@/lib/dashboard/batch-chart-types";
import { isDashboardSnapshotEnabled } from "@/lib/dashboard/snapshot-flag";
import { hideModuleWidgets } from "@/lib/dashboard/widget-modules";
import {
  resolveDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useDailyDigest } from "@/lib/queries/use-daily-digest";
import { useDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";
import { queryKeys } from "@/lib/query-keys";
import type { DashboardAnalyticsData as AnalyticsData } from "@/types/analytics";

/**
 * Module scope so the option object is a stable reference across renders.
 *
 * Refetch on window focus: the dashboard is the surface a person leaves open
 * in a background tab while changing its tile selection elsewhere; without it
 * the stale layout sat visible for up to the poll interval ("saved but nothing
 * changed"). `staleTime` bounds the cost to one refetch a minute, and the
 * server side is SWR-cached, so a focus flick is a cheap cache hit.
 */
const DASHBOARD_QUERY_OPTS = {
  staleTime: 60_000,
  refetchOnWindowFocus: true,
} as const;

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
 * The tiles' `AnalyticsData` from whichever path feeds them. Snapshot path:
 * the one cell, where `extras` is null on a rollup-coverage miss (two-phase
 * contract), so the BP-in-target and glucose fields stay undefined and those
 * tiles shimmer while the rest of the strip paints. Legacy path: the two
 * analytics slices merged.
 */
function assembleDashboardAnalytics(
  snapshotEnabled: boolean,
  snapshot: ReturnType<typeof useDashboardSnapshot>["data"],
  slim: Parameters<typeof mergeSlimAndThickAnalytics>[0],
  thick: Parameters<typeof mergeSlimAndThickAnalytics>[1],
): AnalyticsData | undefined {
  if (snapshotEnabled) {
    const snap = snapshot;
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
  // `mergeSlimAndThickAnalytics` falls back to the thick slice when the
  // slim one resolves with no content, and otherwise lets slim paint first.
  const merged = mergeSlimAndThickAnalytics(slim, thick);
  if (!merged) return undefined;
  return {
    summaries: merged.summaries,
    lastSeenByType: merged.lastSeenByType,
    sleepSourceDiscrepancy: merged.sleepSourceDiscrepancy,
    bpInTargetPct: merged.bpInTargetPct,
    bpInTargetPct7d: merged.bpInTargetPct7d,
    bpInTargetPct30d: merged.bpInTargetPct30d,
    bpInTargetPctAllTime: merged.bpInTargetPctAllTime,
    bpInTargetPctPriorMonth: merged.bpInTargetPctPriorMonth,
    bpInTargetPctPriorYear: merged.bpInTargetPctPriorYear,
    bpInTargetCount90: merged.bpInTargetCount90,
    bpInTargetSpanDays90: merged.bpInTargetSpanDays90,
    glucoseByContext: merged.glucoseByContext as
      Record<string, DataSummary> | undefined,
  };
}

/**
 * Every read the dashboard's tiles and charts paint from.
 *
 * The tiles hydrate from ONE un-gated `/api/dashboard/snapshot` cell, so the
 * whole strip shares one completion moment and `/api/auth/me` leaves the cold
 * critical path. `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false` falls back to the
 * legacy independent cells (two analytics slices, the widget layout, the mood
 * analytics and the user's own thresholds); either way the same
 * `AnalyticsData` shape comes out, so no tile knows which path fed it.
 *
 * The Today hero's digest is read here too, in its original place in the read
 * order: it is the day's data, so no module owns it, and it is gated on auth
 * only.
 */
export function useDashboardData({
  isAuthenticated,
  mounted,
  user,
  batchWindowProp,
}: {
  isAuthenticated: boolean;
  mounted: boolean;
  user: AuthUser | null;
  /**
   * The batched-series window the RSC prefetch computed from the profile
   * time zone. Adopted verbatim so the `chartSeriesBatch` key matches the key
   * the server dehydrated under; absent on the prefetch-off and legacy paths,
   * where the browser-local window stands in.
   */
  batchWindowProp?: BatchWindow;
}) {
  const snapshotEnabled = isDashboardSnapshotEnabled();
  const snapshotQuery = useDashboardSnapshot(snapshotEnabled);
  const digestQuery = useDailyDigest(isAuthenticated);

  // Legacy path: the slim slice (`?slice=summaries`) paints every per-type
  // tile; the thick slice streams the BP-in-target and glucose fields in
  // afterwards. Both share `caches.analytics` server-side.
  const analyticsSlimQuery = useAnalyticsQuery({
    slice: "summaries",
    enabled: !snapshotEnabled && isAuthenticated,
  });
  const analyticsThickQuery = useAnalyticsQuery({
    enabled: !snapshotEnabled && isAuthenticated,
  });
  const data = useMemo(
    () =>
      assembleDashboardAnalytics(
        snapshotEnabled,
        snapshotQuery.data,
        analyticsSlimQuery.data,
        analyticsThickQuery.data,
      ),
    [
      snapshotEnabled,
      snapshotQuery.data,
      analyticsSlimQuery.data,
      analyticsThickQuery.data,
    ],
  );

  // The user's own targets, for the legacy (snapshot-disabled) band fallback
  // only. In snapshot mode the server resolves the same overrides into
  // `targetBands` and this query never fires.
  const { data: thresholdsData } = useQuery({
    queryKey: queryKeys.userThresholds(),
    queryFn: async () => {
      return apiGet<{
        overrides: Record<string, { min: number; max: number }>;
      }>("/api/user/thresholds");
    },
    enabled: !snapshotEnabled && isAuthenticated,
    ...DASHBOARD_QUERY_OPTS,
  });

  const { data: layoutDataLegacy } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      return apiGet<DashboardLayout>("/api/dashboard/widgets");
    },
    enabled: !snapshotEnabled && isAuthenticated,
    ...DASHBOARD_QUERY_OPTS,
  });
  // The snapshot publishes its layout with switched-off modules' widgets
  // already hidden. The legacy feed is the stored layout as saved (Settings
  // edits that exact value), so the same mask is applied here, from the same
  // surface map, before anything paints.
  const layoutData = snapshotEnabled
    ? snapshotQuery.data?.layout
    : layoutDataLegacy && hideModuleWidgets(layoutDataLegacy, user?.modules);
  const moodWidgetVisible = useSurfaceVisible("widget:mood");

  const { data: moodDataLegacy } = useQuery({
    queryKey: queryKeys.moodAnalytics(),
    queryFn: async () => {
      return apiGet<DashboardMoodData>("/api/mood/analytics");
    },
    // The route refuses with the mood module off; do not ask.
    enabled: !snapshotEnabled && isAuthenticated && moodWidgetVisible,
    ...DASHBOARD_QUERY_OPTS,
  });
  const moodData: DashboardMoodData | undefined = snapshotEnabled
    ? snapshotQuery.data
      ? {
          entries: snapshotQuery.data.tiles.mood.entries,
          summary: (snapshotQuery.data.tiles.mood.summary ??
            undefined) as DataSummary,
        }
      : undefined
    : moodDataLegacy;

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

  // The loading flag follows whichever query actually drives the tiles: in
  // snapshot mode the slim query is disabled and reports `isLoading: false`
  // forever, which would select the empty state for the whole snapshot
  // fetch. `!mounted` pins the SSR pass and the hydration render to the
  // skeleton branch (server-side the data queries are disabled, and a late
  // hydrating boundary would otherwise render the skeleton where the server
  // rendered the empty state: React #418). The hero band and the strip share
  // this one gate so both swap to content in the same render pass.
  const primaryLoading =
    !mounted ||
    (snapshotEnabled ? snapshotQuery.isLoading : analyticsSlimQuery.isLoading);

  return {
    snapshotEnabled,
    snapshot: snapshotQuery.data,
    digestQuery,
    data,
    thresholdsData,
    layoutData,
    layout,
    moodData,
    preloadedSeries: batchedSeries,
    primaryLoading,
  };
}

export type DashboardData = ReturnType<typeof useDashboardData>;
