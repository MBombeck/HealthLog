"use client";

import { Gauge } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.10.0 — `/insights/cardio-fitness`.
 *
 * VO2_MAX sub-page. VO₂ max previously rode as a bare chart-row on the
 * pulse page with no plain-language assessment; this dedicated page gives
 * it the generic metric-status assessment treatment alongside the chart.
 * The series arrives from Apple Health sync — no manual-entry CTA.
 */
export default function InsightsCardioFitnessPage() {
  return (
    <HealthKitMetricPage
      measurementType="VO2_MAX"
      statusMetric="VO2_MAX"
      insightMetric="VO2_MAX"
      chartKey="vo2Max"
      i18nPrefix="insights.cardioFitness"
      explainerMetric="cardioFitness"
      color="var(--chart-1)"
      unit="mL/(kg·min)"
      yAxisUnit="mL/(kg·min)"
      statIcon={Gauge}
      emptyStateIcon={<Gauge className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any cardio-fitness (VO₂ max) data yet. What does this metric tell me about my health, and how do I improve it?"
    />
  );
}
