"use client";

import { Footprints } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/double-support-time`.
 *
 * WALKING_DOUBLE_SUPPORT sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsDoppelstandphasePage() {
  return (
    <HealthKitMetricPage
      measurementType="WALKING_DOUBLE_SUPPORT"
      insightMetric="WALKING_DOUBLE_SUPPORT"
      chartKey="walkingDoubleSupport"
      i18nPrefix="insights.walkingDoubleSupport"
      explainerMetric="doubleSupportTime"
      color="#50fa7b"
      unit="%"
      yAxisUnit="%"
      emptyStateIcon={<Footprints className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any double support time yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
