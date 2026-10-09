"use client";

import { Headphones } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/headphone-audio`.
 *
 * AUDIO_EXPOSURE_HEADPHONE sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsKopfhoererpegelPage() {
  return (
    <HealthKitMetricPage
      measurementType="AUDIO_EXPOSURE_HEADPHONE"
      statusMetric="AUDIO_EXPOSURE_HEADPHONE"
      insightMetric="AUDIO_EXPOSURE_HEADPHONE"
      chartKey="audioExposureHeadphone"
      i18nPrefix="insights.audioExposureHeadphone"
      explainerMetric="headphoneAudio"
      color="var(--chart-3)"
      unit="dBA"
      yAxisUnit="dBA"
      emptyStateIcon={<Headphones className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any headphone audio exposure yet. What does this metric tell me about my health, and how do I improve it?"
    />
  );
}
