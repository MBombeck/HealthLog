"use client";

import { Wind } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/respiratory-rate`.
 *
 * RESPIRATORY_RATE sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsAtemfrequenzPage() {
  return (
    <HealthKitMetricPage
      measurementType="RESPIRATORY_RATE"
      insightMetric="RESPIRATORY_RATE"
      chartKey="respiratoryRate"
      i18nPrefix="insights.respiratoryRate"
      explainerMetric="respiratoryRate"
      color="#8be9fd"
      unit="breaths/min"
      yAxisUnit="breaths/min"
      emptyStateIcon={<Wind className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any respiratory rate yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
