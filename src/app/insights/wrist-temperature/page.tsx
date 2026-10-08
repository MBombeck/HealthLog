"use client";

import { Thermometer } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.10.0 — `/insights/wrist-temperature`.
 *
 * WRIST_TEMPERATURE sub-page. Overnight wrist temperature; Apple frames
 * it as a deviation from a personal baseline, so the assessment leans on
 * the user's own trend rather than a fixed band. The series arrives from
 * Apple Health sync — no manual-entry CTA.
 */
export default function InsightsWristTemperaturePage() {
  return (
    <HealthKitMetricPage
      measurementType="WRIST_TEMPERATURE"
      statusMetric="WRIST_TEMPERATURE"
      insightMetric="WRIST_TEMPERATURE"
      chartKey="wristTemperature"
      i18nPrefix="insights.wristTemperature"
      explainerMetric="wristTemperature"
      color="var(--chart-5)"
      emptyStateIcon={<Thermometer className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any wrist-temperature data yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
