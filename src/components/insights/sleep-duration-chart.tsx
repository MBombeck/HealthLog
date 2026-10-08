"use client";

import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { useTranslations } from "@/lib/i18n/context";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";

/**
 * v1.4.25 W4c — nightly TIME-ASLEEP over time.
 *
 * Thin wrapper around `<HealthChartDynamic>` so the sleep sub-page gets
 * the same chart-cog parity (`chartKey="sleep"`) as the dashboard chart
 * surfaces.
 *
 * Data path: SLEEP_DURATION rows are stored per-stage (one row per stage
 * per night, in MINUTES). `<HealthChart>` special-cases SLEEP_DURATION to
 * read `/api/measurements/series?kind=sleep`, which reconstructs ONE point
 * per night carrying the night's TIME-ASLEEP in HOURS (CORE + DEEP + REM,
 * bare-ASLEEP only when no granular stage exists, IN_BED + AWAKE excluded,
 * dual-source nights collapsed to one source). The chart therefore renders
 * a nightly trend in hours that matches every other sleep surface.
 *
 * Unit semantics: the chart plots HOURS — the same unit the series adapter
 * returns and the `<SleepOverview>` headline shows — so the axis reads e.g.
 * "8 h", not the inflated per-stage minutes the legacy path surfaced.
 *
 * v1.4.28 R3d (BK-F-M2) — the inline `dynamic()` call site was retired
 * in favour of the shared `<HealthChartDynamic>` re-export so the
 * `<ChartSkeleton>` + `ssr: false` configuration stays in one place.
 */
export interface SleepDurationChartProps {
  compareBaseline?: ComparisonBaseline;
  userTimezone?: string;
}

export function SleepDurationChart({
  compareBaseline,
  userTimezone,
}: SleepDurationChartProps) {
  const { t } = useTranslations();
  return (
    <HealthChartDynamic
      chartKey="sleep"
      types={["SLEEP_DURATION"]}
      title={t("charts.sleep")}
      colors={["var(--info)"]}
      unit="h"
      yAxisUnit="h"
      compareBaseline={compareBaseline}
      userTimezone={userTimezone}
      // v1.42 — the same doors to the day every metric page's chart has.
      showDataTable
      dayLinks
    />
  );
}
