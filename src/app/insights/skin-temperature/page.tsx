"use client";

import { Thermometer, ThermometerSnowflake } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { ConnectedDeviceScoreTile } from "@/components/insights/device-score-tile";

/**
 * v1.7.0 — `/insights/skin-temperature`.
 *
 * SKIN_TEMPERATURE sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 *
 * v1.17.1 — the Oura overnight body-temperature DEVIATION (a signed delta from
 * the personal baseline, an illness / cycle signal) joins this metabolic page
 * as a gated tile beneath the chart. It only mounts when the Oura series has
 * data, so a non-Oura account renders the page byte-identically.
 */
export default function InsightsHauttemperaturPage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="SKIN_TEMPERATURE"
      statusMetric="SKIN_TEMPERATURE"
      insightMetric="SKIN_TEMPERATURE"
      chartKey="skinTemperature"
      i18nPrefix="insights.skinTemperature"
      explainerMetric="skinTemperature"
      color="var(--chart-5)"
      emptyStateIcon={<Thermometer className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any skin temperature yet — what does this metric tell me about my health, and how do I improve it?"
      afterChart={
        <ConnectedDeviceScoreTile
          type="BODY_TEMPERATURE_DEVIATION"
          title={t("measurements.typeBodyTemperatureDeviation")}
          icon={ThermometerSnowflake}
          color="var(--chart-4)"
          fractionDigits={2}
          sectionTitle={t("insights.bodyTempDeviation.title")}
          sectionIcon={ThermometerSnowflake}
          sectionSubtitle={t("insights.bodyTempDeviation.subtitle")}
        />
      }
    />
  );
}
