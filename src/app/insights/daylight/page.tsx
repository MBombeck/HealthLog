"use client";

import { Sun } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/daylight`.
 *
 * TIME_IN_DAYLIGHT sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsTageslichtPage() {
  return (
    <HealthKitMetricPage
      measurementType="TIME_IN_DAYLIGHT"
      insightMetric="TIME_IN_DAYLIGHT"
      chartKey="timeInDaylight"
      i18nPrefix="insights.timeInDaylight"
      explainerMetric="daylight"
      color="#50fa7b"
      unit="min"
      yAxisUnit="min"
      emptyStateIcon={<Sun className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any time spent in daylight yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
