"use client";

import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { useTranslations } from "@/lib/i18n/context";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";

/**
 * v1.4.25 W4c — total nightly sleep duration over time.
 *
 * Thin wrapper around `<HealthChartDynamic>` so the sleep sub-page gets
 * the same chart-cog parity (`chartKey="sleep"`) as the dashboard chart
 * surfaces. SLEEP_DURATION rows from Apple Health are per-stage (one
 * row per stage per night) — the analytics API aggregates per Berlin
 * day before summarising, and `HealthChart` itself relies on the
 * pre-aggregated `/api/measurements/series` payload, so we pass the
 * raw type through and let the existing chart wire do the day-rollup.
 *
 * Unit semantics: SLEEP_DURATION is canonically stored in MINUTES
 * (v1.4.23 schema note). The chart shows the raw minutes value with a
 * "min" unit suffix — the parent sub-page renders a separate
 * "X h Y min" headline above the chart for the human-friendly read.
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
      colors={["#8be9fd"]}
      unit="min"
      yAxisUnit="min"
      compareBaseline={compareBaseline}
      userTimezone={userTimezone}
    />
  );
}
