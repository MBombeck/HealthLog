"use client";

import { Heart } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.4.32 — `/insights/resting-pulse`.
 *
 * Resting-heart-rate sub-page. Distinct from `/insights/pulse` — Apple
 * Health splits the steady-state daily `restingHeartRate` value from
 * the spot `PULSE` samples logged manually or by Withings. The split
 * here mirrors that distinction so the user has a "daily floor"
 * trend that's not muddied by mid-walk readings.
 */
export default function InsightsRestingHrPage() {
  return (
    <HealthKitMetricPage
      measurementType="RESTING_HEART_RATE"
      insightMetric="RESTING_HEART_RATE"
      chartKey="restingHr"
      i18nPrefix="insights.restingHr"
      explainerMetric="restingHr"
      color="#ff5555"
      unit="bpm"
      yAxisUnit="bpm"
      emptyStateIcon={<Heart className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any resting heart rate yet — why is the daily resting value different from a spot pulse, and how do I improve it?"
    />
  );
}
