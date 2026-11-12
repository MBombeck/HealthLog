"use client";

import { Thermometer } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.32 — `/insights/body-temperature`.
 *
 * Body-temperature sub-page. Canonical storage is Celsius. Distinct
 * from skin temperature (Withings ScanWatch dermal reading) — surface
 * temps run ~32 °C, core ~37 °C, so the schema deliberately keeps
 * them on separate enum values per the v1.4.30 categorisation overlay.
 */
export default function InsightsBodyTemperaturePage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="BODY_TEMPERATURE"
      statusMetric="BODY_TEMPERATURE"
      insightMetric="BODY_TEMPERATURE"
      chartKey="bodyTemperature"
      i18nPrefix="insights.bodyTemperature"
      explainerMetric="bodyTemperature"
      color="var(--chart-3)"
      emptyStateIcon={<Thermometer className="size-6" />}
      emptyStateCtaType="BODY_TEMPERATURE"
      coachPrefill={t("insights.bodyTemperature.coachPrefill")}
    />
  );
}
