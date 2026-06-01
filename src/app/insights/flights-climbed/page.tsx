"use client";

import { TrendingUp } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/flights-climbed`.
 *
 * FLIGHTS_CLIMBED sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsStockwerkePage() {
  return (
    <HealthKitMetricPage
      measurementType="FLIGHTS_CLIMBED"
      insightMetric="FLIGHTS_CLIMBED"
      chartKey="flightsClimbed"
      i18nPrefix="insights.flightsClimbed"
      explainerMetric="flightsClimbed"
      color="#50fa7b"
      unit="flights"
      yAxisUnit="flights"
      emptyStateIcon={<TrendingUp className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any flights climbed yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
