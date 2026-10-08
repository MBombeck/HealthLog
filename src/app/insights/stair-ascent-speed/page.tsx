"use client";

import { Gauge } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.10.0 — `/insights/stair-ascent-speed`.
 *
 * STAIR_ASCENT_SPEED sub-page. Gait speed measured while climbing stairs;
 * a faster pace is the fitter signal. The series arrives from Apple Health
 * sync — no manual-entry CTA.
 */
export default function InsightsStairAscentSpeedPage() {
  return (
    <HealthKitMetricPage
      measurementType="STAIR_ASCENT_SPEED"
      statusMetric="STAIR_ASCENT_SPEED"
      insightMetric="STAIR_ASCENT_SPEED"
      chartKey="stairAscentSpeed"
      i18nPrefix="insights.stairAscentSpeed"
      explainerMetric="stairAscentSpeed"
      color="var(--chart-2)"
      unit="m/s"
      yAxisUnit="m/s"
      emptyStateIcon={<Gauge className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any stair-ascent-speed data yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
