"use client";

import { Thermometer } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/skin-temperature`.
 *
 * SKIN_TEMPERATURE sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsHauttemperaturPage() {
  return (
    <HealthKitMetricPage
      measurementType="SKIN_TEMPERATURE"
      insightMetric="SKIN_TEMPERATURE"
      chartKey="skinTemperature"
      i18nPrefix="insights.skinTemperature"
      explainerMetric="skinTemperature"
      color="#ffb86c"
      unit="°C"
      yAxisUnit="°C"
      emptyStateIcon={<Thermometer className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any skin temperature yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
