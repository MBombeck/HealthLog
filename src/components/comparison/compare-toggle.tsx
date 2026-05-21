"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import {
  COMPARISON_BASELINES,
  resolveDashboardLayout,
  type ComparisonBaseline,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

/**
 * v1.4.16 phase D reconcile (CRITICAL C3) — on-surface comparison
 * toggle. Replaces the Settings-only Select buried 3 clicks deep with
 * a 3-segment control mounted next to the dashboard greeting and the
 * insights page hero. Persists via the same `/api/dashboard/widgets`
 * PUT the Settings page uses, so a flip on either surface updates the
 * other on next refetch.
 *
 * Hit area: each segment is `min-h-11` (44 px) per WCAG 2.5.5; pressed
 * state is the `default` button variant, idle is `outline`.
 */
export function CompareToggle({ className }: { className?: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data: layoutData } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      const res = await fetch("/api/dashboard/widgets");
      if (!res.ok) throw new Error("failed");
      const json = await res.json();
      return json.data as DashboardLayout;
    },
  });

  const layout = layoutData ? resolveDashboardLayout(layoutData) : null;
  const value: ComparisonBaseline = layout?.comparisonBaseline ?? "none";

  const mutation = useMutation({
    mutationFn: async (next: ComparisonBaseline) => {
      if (!layout) throw new Error("layout-not-loaded");
      const body: DashboardLayout = { ...layout, comparisonBaseline: next };
      const res = await fetch("/api/dashboard/widgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("save-failed");
      return (await res.json()).data as DashboardLayout;
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.dashboardWidgets(),
      });
      const prev = queryClient.getQueryData<DashboardLayout>(
        queryKeys.dashboardWidgets(),
      );
      if (prev) {
        queryClient.setQueryData<DashboardLayout>(
          queryKeys.dashboardWidgets(),
          { ...prev, comparisonBaseline: next },
        );
      }
      return { prev };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(queryKeys.dashboardWidgets(), ctx.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardWidgets(),
      });
    },
  });

  return (
    <div
      role="group"
      aria-label={t("comparison.toggleLabel")}
      data-slot="compare-toggle"
      className={cn(
        "border-border bg-background inline-flex flex-wrap items-center gap-0.5 rounded-md border p-0.5",
        className,
      )}
    >
      {COMPARISON_BASELINES.map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            data-slot={`compare-toggle-option-${option}`}
            data-active={active ? "true" : undefined}
            aria-pressed={active}
            disabled={mutation.isPending || !layout}
            onClick={() => {
              if (!active) mutation.mutate(option);
            }}
            className={cn(
              "min-h-11 rounded px-3 text-xs font-medium transition-colors",
              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent",
              mutation.isPending && "cursor-progress",
            )}
          >
            {t(`comparison.baseline.${option}`)}
          </button>
        );
      })}
    </div>
  );
}
