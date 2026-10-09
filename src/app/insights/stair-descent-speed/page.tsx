"use client";

import { Gauge } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.10.0 — `/insights/stair-descent-speed`.
 *
 * STAIR_DESCENT_SPEED sub-page. Gait speed measured while descending
 * stairs; the companion to ascent speed. The series arrives from Apple
 * Health sync — no manual-entry CTA.
 */
export default function InsightsStairDescentSpeedPage() {
  return (
    <HealthKitMetricPage
      measurementType="STAIR_DESCENT_SPEED"
      statusMetric="STAIR_DESCENT_SPEED"
      insightMetric="STAIR_DESCENT_SPEED"
      chartKey="stairDescentSpeed"
      i18nPrefix="insights.stairDescentSpeed"
      explainerMetric="stairDescentSpeed"
      color="var(--chart-2)"
      unit="m/s"
      yAxisUnit="m/s"
      emptyStateIcon={<Gauge className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any stair-descent-speed data yet. What does this metric tell me about my health, and how do I improve it?"
    />
  );
}
