"use client";

import { Volume2 } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/audio-events`.
 *
 * AUDIO_EXPOSURE_EVENT sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsLaermereignissePage() {
  return (
    <HealthKitMetricPage
      measurementType="AUDIO_EXPOSURE_EVENT"
      insightMetric="AUDIO_EXPOSURE_EVENT"
      chartKey="audioExposureEvent"
      i18nPrefix="insights.audioExposureEvent"
      explainerMetric="audioEvents"
      color="#ff79c6"
      unit=""
      yAxisUnit=""
      emptyStateIcon={<Volume2 className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any loud-environment events yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
