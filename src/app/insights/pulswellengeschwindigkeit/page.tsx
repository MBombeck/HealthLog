"use client";

import { Activity } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/pulswellengeschwindigkeit`.
 *
 * PULSE_WAVE_VELOCITY sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsPulswellengeschwindigkeitPage() {
  return (
    <HealthKitMetricPage
      measurementType="PULSE_WAVE_VELOCITY"
      insightMetric="PULSE_WAVE_VELOCITY"
      chartKey="pulseWaveVelocity"
      i18nPrefix="insights.pulseWaveVelocity"
      color="#ff5555"
      unit="m/s"
      yAxisUnit="m/s"
      emptyStateIcon={<Activity className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any pulse wave velocity yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
