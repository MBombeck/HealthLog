"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type DashboardLayout } from "@/lib/dashboard-layout";
import {
  DEFAULT_CHART_OVERLAY_PREFS,
  type ChartOverlayKey,
  type ChartOverlayPrefs,
  type ChartOverlayPrefsMap,
} from "@/lib/dashboard/chart-overlay-prefs";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiPut } from "@/lib/api/api-fetch";

/**
 * v1.4.18 — TanStack Query hook that returns a single chart's overlay
 * prefs and a setter that persists them via the new
 * `PUT /api/dashboard/chart-overlay-prefs` endpoint.
 *
 * Reads from the existing dashboard-widgets cache so a chart on the
 * dashboard doesn't fire a second network request — the layout
 * already lands once on initial dashboard render.
 *
 * v1.4.29 — share the same `queryKeys.dashboardWidgets()` slot
 * the dashboard page + Settings → Dashboard already consume.
 * Pre-fix the hook keyed under `["dashboard-layout"]`, splitting the
 * cache into two slots for the same endpoint and firing
 * `/api/dashboard/widgets` twice on dashboard mount.
 *
 * The mutation is optimistic: we update the cached layout immediately
 * so the chart re-renders with the new toggle state before the network
 * round-trip resolves. On error the cache is rolled back to its
 * previous value.
 */
export function useChartOverlayPrefs(
  chartKey: ChartOverlayKey | null | undefined,
): {
  prefs: ChartOverlayPrefs;
  setPrefs: (next: ChartOverlayPrefs) => void;
  isSaving: boolean;
} {
  const queryClient = useQueryClient();

  const { data: layout } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async (): Promise<DashboardLayout> =>
      apiGet<DashboardLayout>("/api/dashboard/widgets"),
    // Keep the cache warm — the dashboard page mounts a query against
    // the same key on first paint, so this hook just piggy-backs.
    staleTime: 60_000,
    // Skip the fetch entirely when the caller doesn't pass a chartKey
    // (mini-mode / ad-hoc chart usage). Saves a wasted GET on pages like
    // /insights that mount charts without per-chart persistence.
    enabled: Boolean(chartKey),
  });

  const prefs = useMemo<ChartOverlayPrefs>(() => {
    if (!chartKey) return DEFAULT_CHART_OVERLAY_PREFS;
    return layout?.chartOverlayPrefs?.[chartKey] ?? DEFAULT_CHART_OVERLAY_PREFS;
  }, [layout, chartKey]);

  const mutation = useMutation({
    mutationFn: async (next: ChartOverlayPrefs): Promise<void> => {
      // No-op when no chartKey — the setter is wired up but the hook
      // is in "ad-hoc render" mode where overlays don't persist.
      if (!chartKey) return;
      await apiPut("/api/dashboard/chart-overlay-prefs", {
        chartKey,
        prefs: next,
      });
    },
    onMutate: async (next) => {
      if (!chartKey) return { previous: undefined };
      await queryClient.cancelQueries({
        queryKey: queryKeys.dashboardWidgets(),
      });
      const previous = queryClient.getQueryData<DashboardLayout>(
        queryKeys.dashboardWidgets(),
      );
      if (previous) {
        const nextLayout: DashboardLayout = {
          ...previous,
          chartOverlayPrefs: {
            ...(previous.chartOverlayPrefs ?? {}),
            [chartKey]: next,
          } as ChartOverlayPrefsMap,
        };
        queryClient.setQueryData(queryKeys.dashboardWidgets(), nextLayout);
      }
      return { previous };
    },
    onError: (_err, _next, ctx) => {
      const context = ctx as { previous?: DashboardLayout } | undefined;
      if (context?.previous) {
        queryClient.setQueryData(
          queryKeys.dashboardWidgets(),
          context.previous,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardWidgets(),
      });
    },
  });

  const setPrefs = useCallback(
    (next: ChartOverlayPrefs): void => {
      mutation.mutate(next);
    },
    [mutation],
  );

  return {
    prefs,
    setPrefs,
    isSaving: mutation.isPending,
  };
}
