"use client";

import { Scale } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/fat-free-mass`.
 *
 * FAT_FREE_MASS sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsFettfreieMassePage() {
  return (
    <HealthKitMetricPage
      measurementType="FAT_FREE_MASS"
      insightMetric="FAT_FREE_MASS"
      chartKey="fatFreeMass"
      i18nPrefix="insights.fatFreeMass"
      explainerMetric="fatFreeMass"
      color="#bd93f9"
      unit="kg"
      yAxisUnit="kg"
      emptyStateIcon={<Scale className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any fat-free mass yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
