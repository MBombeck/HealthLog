"use client";

import { Dumbbell } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/muscle-mass`.
 *
 * MUSCLE_MASS sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsMuskelmassePage() {
  return (
    <HealthKitMetricPage
      measurementType="MUSCLE_MASS"
      insightMetric="MUSCLE_MASS"
      chartKey="muscleMass"
      i18nPrefix="insights.muscleMass"
      explainerMetric="muscleMass"
      color="#bd93f9"
      unit="kg"
      yAxisUnit="kg"
      emptyStateIcon={<Dumbbell className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any muscle mass yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
