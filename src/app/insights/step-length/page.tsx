"use client";

import { Footprints } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/step-length`.
 *
 * WALKING_STEP_LENGTH sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsSchrittlaengePage() {
  return (
    <HealthKitMetricPage
      measurementType="WALKING_STEP_LENGTH"
      insightMetric="WALKING_STEP_LENGTH"
      chartKey="walkingStepLength"
      i18nPrefix="insights.walkingStepLength"
      explainerMetric="stepLength"
      color="#50fa7b"
      unit="m"
      yAxisUnit="m"
      emptyStateIcon={<Footprints className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any walking step length yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
