"use client";

import type { ComponentType } from "react";

import { TileHeader } from "@/components/insights/tile-header";
import type { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import type {
  ChartRangePoints,
  ComparisonBaseline,
} from "@/lib/dashboard-layout";
import { useTranslations } from "@/lib/i18n/context";

import { ChartOverlayControls } from "../chart-overlay-controls";
import { ChartRangeTabs } from "../chart-range-tabs";

/**
 * The chart card's header. Mobile first: the title and its chips on one row,
 * the range tabs and the overlay cog right-aligned on a second; the bucket
 * and comparison chips hide below `sm` (the range tabs already say which
 * window is shown, and the cog still reaches the overlays). From `sm` up
 * everything sits on one row.
 */
export function HealthChartHeader({
  title,
  titleIcon,
  bucketCaption,
  compareBaseline,
  hasComparisonData,
  rangePoints,
  onRangeChange,
  overlayPrefs,
  showOverlayControls,
}: {
  title: string;
  titleIcon?: ComponentType<{ className?: string }>;
  bucketCaption: string | null;
  compareBaseline: ComparisonBaseline;
  hasComparisonData: boolean;
  rangePoints: number;
  onRangeChange: (days: ChartRangePoints) => void;
  overlayPrefs: ReturnType<typeof useChartOverlayPrefs>;
  showOverlayControls: boolean;
}) {
  const { t } = useTranslations();
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        {/* With a `titleIcon` (every metric page) the card leads with the
            canonical `<TileHeader>`; the dashboard and ad-hoc mounts keep the
            compact heading. That heading is an `<h2>`: the card is a sibling
            of the other cards in its grid, which name themselves at the
            second level, and one level lower skipped a level under the page
            `<h1>`. */}
        {titleIcon ? (
          <TileHeader icon={titleIcon} title={title} />
        ) : (
          <h2 className="text-sm font-semibold">{title}</h2>
        )}
        {bucketCaption && (
          <span
            data-slot="chart-bucket-caption"
            className="bg-muted/40 text-muted-foreground text-2xs hidden rounded-md px-1.5 py-0.5 font-medium tracking-wide uppercase sm:inline-flex"
          >
            {t(bucketCaption)}
          </span>
        )}
        {/* The comparison caption sits beside the bucket chip: "which window"
            and "which overlay" in one glance. The unavailable fallback is
            muted so it does not read as an error. */}
        {compareBaseline !== "none" && hasComparisonData && (
          <span
            className="text-dose-accent bg-dose-accent/10 text-2xs hidden rounded-md border border-current/30 px-1.5 py-0.5 font-medium tracking-wide uppercase sm:inline-flex"
            data-slot="chart-compare-caption"
          >
            {t(
              compareBaseline === "lastMonth"
                ? "comparison.captionLastMonth"
                : "comparison.captionLastYear",
            )}
          </span>
        )}
        {compareBaseline !== "none" && !hasComparisonData && (
          <span
            className="text-muted-foreground bg-muted/40 text-2xs hidden rounded-md px-1.5 py-0.5 font-medium tracking-wide sm:inline-flex"
            data-slot="chart-compare-unavailable"
          >
            {t(
              compareBaseline === "lastMonth"
                ? "comparison.unavailable.lastMonth"
                : "comparison.unavailable.lastYear",
            )}
          </span>
        )}
        {/* The page-level target control owns "adjust targets"; the chart
            card stays a read surface. */}
      </div>
      <div
        className="flex flex-nowrap items-center justify-end gap-1 self-end sm:self-auto"
        data-slot="chart-header-controls"
      >
        <ChartRangeTabs value={rangePoints} onChange={onRangeChange} />
        {/* Only a chart bound to a persistent key offers the overlay
            controls; ad-hoc charts keep the clean line. */}
        {showOverlayControls ? (
          <ChartOverlayControls
            prefs={overlayPrefs.prefs}
            onChange={overlayPrefs.setPrefs}
            hasComparisonData={hasComparisonData}
          />
        ) : null}
      </div>
    </div>
  );
}
