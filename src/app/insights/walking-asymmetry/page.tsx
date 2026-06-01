"use client";

import { Footprints } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/walking-asymmetry`.
 *
 * WALKING_ASYMMETRY sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsGangasymmetriePage() {
  return (
    <HealthKitMetricPage
      measurementType="WALKING_ASYMMETRY"
      insightMetric="WALKING_ASYMMETRY"
      chartKey="walkingAsymmetry"
      i18nPrefix="insights.walkingAsymmetry"
      explainerMetric="walkingAsymmetry"
      color="#50fa7b"
      unit="%"
      yAxisUnit="%"
      emptyStateIcon={<Footprints className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any walking asymmetry yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
