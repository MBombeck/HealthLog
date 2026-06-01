"use client";

import { Thermometer } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.4.32 — `/insights/body-temperature`.
 *
 * Body-temperature sub-page. Canonical storage is Celsius. Distinct
 * from skin temperature (Withings ScanWatch dermal reading) — surface
 * temps run ~32 °C, core ~37 °C, so the schema deliberately keeps
 * them on separate enum values per the v1.4.30 categorisation overlay.
 */
export default function InsightsBodyTemperaturePage() {
  return (
    <HealthKitMetricPage
      measurementType="BODY_TEMPERATURE"
      insightMetric="BODY_TEMPERATURE"
      chartKey="bodyTemperature"
      i18nPrefix="insights.bodyTemperature"
      explainerMetric="bodyTemperature"
      color="#ff79c6"
      unit="°C"
      yAxisUnit="°C"
      emptyStateIcon={<Thermometer className="size-6" />}
      emptyStateCtaType="BODY_TEMPERATURE"
      coachPrefill="I haven't logged any body temperature yet — what's the healthy range, and what should I do if it drifts?"
    />
  );
}
