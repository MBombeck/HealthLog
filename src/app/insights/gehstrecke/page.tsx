"use client";

import { Footprints } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/gehstrecke`.
 *
 * WALKING_RUNNING_DISTANCE sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsGehstreckePage() {
  return (
    <HealthKitMetricPage
      measurementType="WALKING_RUNNING_DISTANCE"
      insightMetric="WALKING_RUNNING_DISTANCE"
      chartKey="walkingRunningDistance"
      i18nPrefix="insights.walkingRunningDistance"
      color="#50fa7b"
      unit="km"
      yAxisUnit="km"
      // Stored in metres; display daily totals in km (1 m = 0.001 km).
      valueScale={0.001}
      emptyStateIcon={<Footprints className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any walking and running distance yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
