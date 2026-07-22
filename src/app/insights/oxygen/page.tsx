"use client";

import { Wind } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.4.32 — `/insights/oxygen`.
 *
 * Oxygen-saturation (SpO₂) sub-page. Canonical storage is percent
 * (0..100); the chart axis runs 85..100 because clinical normal is
 * 95..100 and the 85 floor leaves room for nightly dips without
 * compressing the trend. Withings ScanWatch + Apple Watch both
 * report SpO₂; the v1.4.25 source-priority picker keeps the surface
 * deduped.
 */
export default function InsightsOxygenSaturationPage() {
  return (
    <HealthKitMetricPage
      measurementType="OXYGEN_SATURATION"
      statusMetric="OXYGEN_SATURATION"
      insightMetric="OXYGEN_SATURATION"
      chartKey="oxygenSaturation"
      i18nPrefix="insights.oxygenSaturation"
      explainerMetric="oxygenSaturation"
      color="var(--info)"
      unit="%"
      yAxisUnit="%"
      valueBands={[
        // < 90 % — clinical hypoxia floor, paint the danger band.
        { min: 80, max: 90, color: "var(--destructive)", opacity: 0.18 },
        // 90 .. 95 % — watch zone.
        { min: 90, max: 95, color: "var(--warning)", opacity: 0.18 },
        // 95 .. 100 % — clinical normal.
        { min: 95, max: 100, color: "var(--success)", opacity: 0.18 },
      ]}
      emptyStateIcon={<Wind className="size-6" />}
      emptyStateCtaType={null}
      captureType="OXYGEN_SATURATION"
      coachPrefill="I haven't logged any oxygen-saturation data yet — what does SpO₂ tell me, and what range should I aim for?"
    />
  );
}
