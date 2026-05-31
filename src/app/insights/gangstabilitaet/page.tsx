"use client";

import { Gauge } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.7.0 — `/insights/gangstabilitaet`.
 *
 * WALKING_STEADINESS sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 */
export default function InsightsGangstabilitaetPage() {
  return (
    <HealthKitMetricPage
      measurementType="WALKING_STEADINESS"
      insightMetric="WALKING_STEADINESS"
      chartKey="walkingSteadiness"
      i18nPrefix="insights.walkingSteadiness"
      color="#50fa7b"
      unit="%"
      yAxisUnit="%"
      emptyStateIcon={<Gauge className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any walking steadiness yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
