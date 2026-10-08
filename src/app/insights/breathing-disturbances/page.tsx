"use client";

import { Wind } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.10.0 — `/insights/breathing-disturbances`.
 *
 * BREATHING_DISTURBANCES sub-page. Apple's per-night sleep-breathing
 * index (iOS 18+), classified as NotElevated / Elevated; fewer is better.
 * The series arrives from Apple Health sync — no manual-entry CTA.
 */
export default function InsightsBreathingDisturbancesPage() {
  return (
    <HealthKitMetricPage
      measurementType="BREATHING_DISTURBANCES"
      statusMetric="BREATHING_DISTURBANCES"
      insightMetric="BREATHING_DISTURBANCES"
      chartKey="breathingDisturbances"
      i18nPrefix="insights.breathingDisturbances"
      explainerMetric="breathingDisturbances"
      color="var(--chart-4)"
      unitKey="insights.units.breathingEvents"
      emptyStateIcon={<Wind className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any sleep-breathing-disturbance data yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
