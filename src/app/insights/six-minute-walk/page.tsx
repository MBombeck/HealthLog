"use client";

import { Footprints } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.10.0 — `/insights/six-minute-walk`.
 *
 * SIX_MINUTE_WALK_DISTANCE sub-page. Apple's estimated six-minute-walk-test
 * distance; a mobility + cardiopulmonary endurance signal, higher-better.
 * The series arrives from Apple Health sync — no manual-entry CTA.
 */
export default function InsightsSixMinuteWalkPage() {
  return (
    <HealthKitMetricPage
      measurementType="SIX_MINUTE_WALK_DISTANCE"
      statusMetric="SIX_MINUTE_WALK_DISTANCE"
      insightMetric="SIX_MINUTE_WALK_DISTANCE"
      chartKey="sixMinuteWalkDistance"
      i18nPrefix="insights.sixMinuteWalk"
      explainerMetric="sixMinuteWalk"
      color="var(--chart-2)"
      unit="m"
      yAxisUnit="m"
      emptyStateIcon={<Footprints className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any six-minute-walk data yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
