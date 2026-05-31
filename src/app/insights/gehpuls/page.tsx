"use client";

import { HeartPulse } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/gehpuls`.
 *
 * WALKING_HEART_RATE_AVERAGE sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsGehpulsPage() {
  return (
    <HealthKitMetricPage
      measurementType="WALKING_HEART_RATE_AVERAGE"
      insightMetric="WALKING_HEART_RATE_AVERAGE"
      chartKey="walkingHeartRateAverage"
      i18nPrefix="insights.walkingHeartRateAverage"
      color="#ff5555"
      unit="bpm"
      yAxisUnit="bpm"
      emptyStateIcon={<HeartPulse className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any walking heart rate average yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
