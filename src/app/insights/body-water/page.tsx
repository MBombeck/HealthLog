"use client";

import { Droplet } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/body-water`.
 *
 * TOTAL_BODY_WATER sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsKoerperwasserPage() {
  return (
    <HealthKitMetricPage
      measurementType="TOTAL_BODY_WATER"
      statusMetric="TOTAL_BODY_WATER"
      insightMetric="TOTAL_BODY_WATER"
      chartKey="totalBodyWater"
      i18nPrefix="insights.totalBodyWater"
      explainerMetric="bodyWater"
      color="var(--info)"
      unit="kg"
      yAxisUnit="kg"
      emptyStateIcon={<Droplet className="size-6" />}
      emptyStateCtaType={null}
      captureType="TOTAL_BODY_WATER"
      coachPrefill="I haven't logged any total body water yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
