"use client";

import { useId, type ReactElement } from "react";
import { Settings2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import {
  COMPARISON_BASELINES,
  type ChartOverlayPrefs,
  type ComparisonBaseline,
} from "@/lib/dashboard-layout";

/**
 * v1.4.18 — per-chart overlay-controls popover.
 *
 * the maintainer rolled back B1a's always-on chart overlays (gradient fills,
 * personal-baseline reference line, target-zone shading) and asked for
 * a per-chart switch surface instead. Each dashboard chart card mounts
 * one of these in its top-right corner (a settings-cog dropdown) so the
 * user can flip the three overlays on or off for that chart only,
 * without affecting any other chart.
 *
 * Three toggles, each independent:
 *   - showTrendIndicator — the "7-day trend" overlay (moving average +
 *     numeric Δ chip in the header)
 *   - showTrendArrow      — the trend regression line + arrow direction
 *     hint + personal-baseline reference line. the maintainer's rule: the mean
 *     line only paints when a trend is being displayed, so we fold
 *     the baseline into this toggle.
 *   - showTargetRange     — the target-zone shading + reference lines
 *     (BP healthy band, BMI healthy band, medication 80 % / 100 %
 *     thresholds, etc.).
 *
 * Default state for every toggle is OFF — clean line is the new
 * default and overlays are user-opt-in.
 *
 * The component is controlled — the parent owns the state, a render
 * happens on every change. Persistence (TanStack Query → user-pref API
 * → User.dashboardWidgetsJson.chartOverlayPrefs) is wired up by the
 * chart wrapper that mounts this; the controls component itself is
 * pure UI.
 */

/**
 * Re-export the canonical type+default from `@/lib/dashboard-layout`
 * so chart-side callers can keep importing them from this module.
 * Single source of truth lives in dashboard-layout (the persistence
 * layer); this module is just the UI.
 */
export {
  DEFAULT_CHART_OVERLAY_PREFS,
  type ChartOverlayPrefs,
} from "@/lib/dashboard-layout";

export interface ChartOverlayControlsProps {
  prefs: ChartOverlayPrefs;
  onChange: (next: ChartOverlayPrefs) => void;
  /**
   * Optional CSS class for the trigger button — letting the chart
   * wrapper align the cog with its title row.
   */
  triggerClassName?: string;
}

export function ChartOverlayControls({
  prefs,
  onChange,
  triggerClassName,
}: ChartOverlayControlsProps): ReactElement {
  const { t } = useTranslations();
  const trendIndicatorId = useId();
  const trendArrowId = useId();
  const targetRangeId = useId();

  const setToggle = (
    key: "showTrendIndicator" | "showTrendArrow" | "showTargetRange",
    value: boolean,
  ): void => {
    onChange({ ...prefs, [key]: value });
  };

  const setComparisonBaseline = (value: ComparisonBaseline): void => {
    onChange({ ...prefs, comparisonBaseline: value });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`text-muted-foreground hover:text-foreground min-h-11 min-w-11 px-0 ${triggerClassName ?? ""}`.trim()}
          aria-label={t("chart.overlay.controls.tooltip.openSettings")}
          data-slot="chart-overlay-controls-trigger"
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-[240px] p-3"
        data-slot="chart-overlay-controls-content"
      >
        <DropdownMenuLabel className="text-xs font-medium tracking-wide uppercase">
          {t("chart.overlay.controls.title")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="flex flex-col gap-2.5 pt-1">
          <div className="flex items-center justify-between gap-3">
            <Label
              htmlFor={trendIndicatorId}
              className="cursor-pointer text-xs font-normal"
            >
              {t("chart.overlay.controls.trendIndicator")}
            </Label>
            <Switch
              id={trendIndicatorId}
              checked={prefs.showTrendIndicator}
              onCheckedChange={(value) =>
                setToggle("showTrendIndicator", Boolean(value))
              }
              data-slot="chart-overlay-toggle-trend-indicator"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label
              htmlFor={trendArrowId}
              className="cursor-pointer text-xs font-normal"
            >
              {t("chart.overlay.controls.trendArrow")}
            </Label>
            <Switch
              id={trendArrowId}
              checked={prefs.showTrendArrow}
              onCheckedChange={(value) =>
                setToggle("showTrendArrow", Boolean(value))
              }
              data-slot="chart-overlay-toggle-trend-arrow"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label
              htmlFor={targetRangeId}
              className="cursor-pointer text-xs font-normal"
            >
              {t("chart.overlay.controls.targetRange")}
            </Label>
            <Switch
              id={targetRangeId}
              checked={prefs.showTargetRange}
              onCheckedChange={(value) =>
                setToggle("showTargetRange", Boolean(value))
              }
              data-slot="chart-overlay-toggle-target-range"
            />
          </div>
        </div>
        <DropdownMenuSeparator />
        <div className="flex flex-col gap-1.5 pt-1">
          <Label className="text-muted-foreground text-xs font-medium">
            {t("chart.overlay.controls.comparisonBaseline")}
          </Label>
          <div
            className="grid grid-cols-3 gap-1"
            data-slot="chart-overlay-comparison-baseline"
          >
            {COMPARISON_BASELINES.map((value) => (
              <Button
                key={value}
                type="button"
                variant={
                  prefs.comparisonBaseline === value ? "default" : "outline"
                }
                size="sm"
                className="h-9 px-1 text-[11px]"
                onClick={() => setComparisonBaseline(value)}
                aria-pressed={prefs.comparisonBaseline === value}
                data-slot={`chart-overlay-comparison-${value}`}
              >
                {t(`comparison.baseline.${value}`)}
              </Button>
            ))}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
