"use client";

import { HeartPulse } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/gefaessalter`.
 *
 * VASCULAR_AGE sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsGefaessalterPage() {
  return (
    <HealthKitMetricPage
      measurementType="VASCULAR_AGE"
      insightMetric="VASCULAR_AGE"
      chartKey="vascularAge"
      i18nPrefix="insights.vascularAge"
      color="#ff79c6"
      unit="years"
      yAxisUnit="years"
      emptyStateIcon={<HeartPulse className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any vascular age yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
