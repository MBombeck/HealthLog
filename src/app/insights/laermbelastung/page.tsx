"use client";

import { Volume2 } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/laermbelastung`.
 *
 * AUDIO_EXPOSURE_ENV sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsLaermbelastungPage() {
  return (
    <HealthKitMetricPage
      measurementType="AUDIO_EXPOSURE_ENV"
      insightMetric="AUDIO_EXPOSURE_ENV"
      chartKey="audioExposureEnv"
      i18nPrefix="insights.audioExposureEnv"
      color="#ff79c6"
      unit="dBA"
      yAxisUnit="dBA"
      emptyStateIcon={<Volume2 className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any environmental sound exposure yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
