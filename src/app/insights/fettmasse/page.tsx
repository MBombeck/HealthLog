"use client";

import { Droplets } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/fettmasse`.
 *
 * FAT_MASS sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsFettmassePage() {
  return (
    <HealthKitMetricPage
      measurementType="FAT_MASS"
      insightMetric="FAT_MASS"
      chartKey="fatMass"
      i18nPrefix="insights.fatMass"
      color="#ffb86c"
      unit="kg"
      yAxisUnit="kg"
      emptyStateIcon={<Droplets className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any fat mass yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
