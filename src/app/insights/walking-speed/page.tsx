"use client";

import { Gauge } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/walking-speed`.
 *
 * WALKING_SPEED sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsGehgeschwindigkeitPage() {
  return (
    <HealthKitMetricPage
      measurementType="WALKING_SPEED"
      insightMetric="WALKING_SPEED"
      chartKey="walkingSpeed"
      i18nPrefix="insights.walkingSpeed"
      explainerMetric="walkingSpeed"
      color="#50fa7b"
      unit="km/h"
      yAxisUnit="km/h"
      valueScale={3.6}
      emptyStateIcon={<Gauge className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any walking speed yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
