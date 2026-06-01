"use client";

import { Bone } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/bone-mass`.
 *
 * BONE_MASS sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsKnochenmassePage() {
  return (
    <HealthKitMetricPage
      measurementType="BONE_MASS"
      insightMetric="BONE_MASS"
      chartKey="boneMass"
      i18nPrefix="insights.boneMass"
      explainerMetric="boneMass"
      color="#ffb86c"
      unit="kg"
      yAxisUnit="kg"
      emptyStateIcon={<Bone className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any bone mass yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
