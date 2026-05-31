"use client";

import { Droplet } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/blutzucker`.
 *
 * BLOOD_GLUCOSE sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsBlutzuckerPage() {
  return (
    <HealthKitMetricPage
      measurementType="BLOOD_GLUCOSE"
      insightMetric="BLOOD_GLUCOSE"
      chartKey="bloodGlucose"
      i18nPrefix="insights.bloodGlucose"
      color="#ff79c6"
      unit="mg/dL"
      yAxisUnit="mg/dL"
      emptyStateIcon={<Droplet className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any blood glucose yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
