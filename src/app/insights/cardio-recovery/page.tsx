"use client";

import { HeartPulse } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.10.0 — `/insights/cardio-recovery`.
 *
 * CARDIO_RECOVERY sub-page. The heart-rate drop one minute after peak
 * exercise; a larger drop signals fitter autonomic recovery. The series
 * arrives from Apple Health sync after qualifying workouts — no
 * manual-entry CTA.
 */
export default function InsightsCardioRecoveryPage() {
  return (
    <HealthKitMetricPage
      measurementType="CARDIO_RECOVERY"
      statusMetric="CARDIO_RECOVERY"
      insightMetric="CARDIO_RECOVERY"
      chartKey="cardioRecovery"
      i18nPrefix="insights.cardioRecovery"
      explainerMetric="cardioRecovery"
      color="var(--chart-3)"
      unit="bpm"
      yAxisUnit="bpm"
      emptyStateIcon={<HeartPulse className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any cardio-recovery data yet. What does this metric tell me about my health, and how do I improve it?"
    />
  );
}
