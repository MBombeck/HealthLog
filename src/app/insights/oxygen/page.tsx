"use client";

import { Wind } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useTranslations } from "@/lib/i18n/context";
import { buildOxygenSaturationBands } from "@/lib/analytics/value-bands";
import { useOwnTargetRange } from "@/lib/queries/use-own-target-range";

/**
 * v1.4.32 — `/insights/oxygen`.
 *
 * Oxygen-saturation (SpO₂) sub-page. Canonical storage is percent
 * (0..100); the chart axis runs 85..100 because clinical normal is
 * 95..100 and the 85 floor leaves room for nightly dips without
 * compressing the trend. Withings ScanWatch + Apple Watch both
 * report SpO₂; the v1.4.25 source-priority picker keeps the surface
 * deduped.
 *
 * The shaded zone follows the person's own SpO₂ target when they set one on
 * `/targets`, and the clinical bands otherwise.
 */
export default function InsightsOxygenSaturationPage() {
  const { t } = useTranslations();
  const ownRange = useOwnTargetRange("OXYGEN_SATURATION");
  return (
    <HealthKitMetricPage
      measurementType="OXYGEN_SATURATION"
      statusMetric="OXYGEN_SATURATION"
      insightMetric="OXYGEN_SATURATION"
      chartKey="oxygenSaturation"
      i18nPrefix="insights.oxygenSaturation"
      explainerMetric="oxygenSaturation"
      color="var(--chart-4)"
      unit="%"
      yAxisUnit="%"
      // The clinical shading (hypoxia floor < 90 %, watch zone to 95 %,
      // normal above), or the person's own band when they set one.
      valueBands={buildOxygenSaturationBands(ownRange)}
      emptyStateIcon={<Wind className="size-6" />}
      emptyStateCtaType={null}
      captureType="OXYGEN_SATURATION"
      coachPrefill={t("insights.oxygenSaturation.coachPrefill")}
    />
  );
}
