"use client";

import { Suspense } from "react";
import Link from "next/link";
import { Activity, Plus } from "lucide-react";

import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { TrendCardSkeleton } from "@/components/charts/trend-card-skeleton";
import { TrendHint } from "@/components/charts/trend-hint";
import { DashboardChartCell } from "@/components/dashboard/chart-reveal";
import {
  resolveChartRowPlaceholderCount,
  resolveConfiguredTileCount,
  resolveDashboardFirstPaintGate,
} from "@/components/dashboard/dashboard-gates";
import { dashboardTileHref } from "@/components/dashboard/tile-destinations";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { AuthUser } from "@/hooks/use-auth";
import type { DashboardLayout } from "@/lib/dashboard-layout";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import type { ChartEntry } from "./chart-tiles";
import type { StripEntry } from "./strip-tiles";

/**
 * The tile strip and the chart row, with the states around them: the
 * layout-stable silhouettes while the primary read is in flight, and the
 * empty state once it resolved with nothing to show.
 */
export function DashboardTiles({
  stripEntries,
  chartEntries,
  chartsRevealed,
  layout,
  primaryLoading,
  mounted,
  user,
  canAddMeasurement,
  onAddMeasurement,
}: {
  stripEntries: StripEntry[];
  chartEntries: ChartEntry[];
  chartsRevealed: boolean;
  layout: DashboardLayout;
  primaryLoading: boolean;
  mounted: boolean;
  user: AuthUser | null;
  canAddMeasurement: boolean;
  onAddMeasurement: () => void;
}) {
  const { t } = useTranslations();

  // The skeleton strip reserves the footprint of the tiles the layout
  // configures (tile-capable widgets only, two for blood pressure), so the
  // strip does not reshuffle when the data lands.
  const configuredTileCount = resolveConfiguredTileCount(layout);
  // While the snapshot is in flight the data-gated charts cannot exist yet;
  // silhouettes for the charts the layout expects hold the page near its
  // final height, and the landing snapshot swaps content instead of growing
  // the page. `mounted &&` pins the hydration render to the server output:
  // the shell's auth read can already carry a height when this boundary
  // replays its first render, and an extra BMI silhouette would mismatch
  // the server HTML (React #418).
  const chartRowPlaceholderCount = primaryLoading
    ? Math.max(
        0,
        resolveChartRowPlaceholderCount(layout, {
          hasHeightCm: mounted && Boolean(user?.heightCm),
        }) - chartEntries.length,
      )
    : 0;
  const { showTileStripSkeleton, showEmptyState } =
    resolveDashboardFirstPaintGate({
      trendCardCount: stripEntries.length,
      chartCount: chartEntries.length,
      configuredTileCount,
      primaryLoading,
    });

  // Nothing to show once the read resolved: one call to action into the
  // quick-entry sheet instead of an empty strip under the header.
  if (showEmptyState) {
    return (
      <EmptyState
        icon={<Activity className="size-6" />}
        title={t("dashboard.emptyTitle")}
        description={t("dashboard.emptyDescription")}
        action={
          canAddMeasurement ? (
            <Button size="sm" onClick={onAddMeasurement}>
              <Plus className="h-4 w-4" />
              {t("dashboard.emptyAddMeasurement")}
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <>
      {showTileStripSkeleton && (
        <div
          // Mirrors the real grid track, keyed off the configured tile count:
          // a strip trimmed to three tiles shows three silhouettes.
          aria-hidden="true"
          data-slot="dashboard-tile-strip-skeleton"
          className={cn(
            "grid auto-rows-fr gap-3",
            "[grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))]",
          )}
        >
          {Array.from({ length: configuredTileCount }).map((_, idx) => (
            <TrendCardSkeleton key={`tile-skeleton-${idx}`} />
          ))}
        </div>
      )}
      {stripEntries.length > 0 && (
        <div
          // One grid track for every breakpoint, never a second row of
          // scrolling: `auto-fit` with an 11 rem floor gives one column on a
          // 280 px fold, two on a phone, six at 1440 px and eight from
          // 1920 px, and `auto-rows-fr` keeps every row on one height so a
          // tile with a callout does not break the baseline. With every tile
          // switched off the strip is not rendered at all.
          className={cn(
            "grid auto-rows-fr gap-3",
            "[grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))]",
          )}
          data-slot="dashboard-tile-strip"
          data-tour-id="dashboard-tile-strip"
          data-tile-count={stripEntries.length}
        >
          {stripEntries.map((entry) => {
            // A layout-stable fallback per tile, so a tile slot that ever
            // suspends previews its shape instead of leaving the cell empty.
            const cell = (
              <Suspense fallback={<TrendCardSkeleton />}>{entry.node}</Suspense>
            );
            // A tile links to its Insights page (gated on that page's
            // module); the link fills the cell and rings on hover and focus.
            const href = dashboardTileHref(entry.id, user?.modules);
            return href ? (
              <Link
                key={entry.id}
                href={href}
                data-slot="dashboard-tile-link"
                data-tile-id={entry.id}
                className="group focus-visible:ring-ring/50 hover:ring-ring/30 flex min-w-0 rounded-xl transition-[box-shadow] hover:ring-2 focus-visible:ring-2 focus-visible:outline-none"
              >
                {cell}
              </Link>
            ) : (
              <div key={entry.id} className="flex min-w-0">
                {cell}
              </div>
            );
          })}
        </div>
      )}
      {chartEntries.map((entry) => (
        <div key={entry.id} className="space-y-2">
          {/* A boundary per chart, so each paints on its own instead of the
              row waiting for the slowest. A gated cell keeps its chart
              mounted (its query fires) but shows the skeleton until the
              shared reveal flips; the trend hint rides inside the cell so it
              appears with its chart. */}
          {entry.revealGated ? (
            <DashboardChartCell revealed={chartsRevealed}>
              <Suspense fallback={<ChartSkeleton />}>{entry.node}</Suspense>
              {entry.count != null ? <TrendHint count={entry.count} /> : null}
            </DashboardChartCell>
          ) : (
            <>
              <Suspense fallback={<ChartSkeleton />}>{entry.node}</Suspense>
              {entry.count != null ? <TrendHint count={entry.count} /> : null}
            </>
          )}
        </div>
      ))}
      {chartRowPlaceholderCount > 0 && (
        <div
          aria-hidden="true"
          data-slot="dashboard-chart-row-skeleton"
          className="space-y-6"
        >
          {Array.from({ length: chartRowPlaceholderCount }).map((_, idx) => (
            <ChartSkeleton key={`chart-row-skeleton-${idx}`} />
          ))}
        </div>
      )}
    </>
  );
}
