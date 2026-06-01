"use client";

import { Droplets } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/visceral-fat`.
 *
 * VISCERAL_FAT sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsViszeralfettPage() {
  return (
    <HealthKitMetricPage
      measurementType="VISCERAL_FAT"
      insightMetric="VISCERAL_FAT"
      chartKey="visceralFat"
      i18nPrefix="insights.visceralFat"
      explainerMetric="visceralFat"
      color="#ffb86c"
      unit=""
      yAxisUnit=""
      emptyStateIcon={<Droplets className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any visceral fat yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
