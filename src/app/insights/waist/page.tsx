"use client";

import { Ruler } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.25 — `/insights/waist`.
 *
 * Waist-circumference sub-page. Rides the generic metric template; the
 * assessment threads the sex-aware WHO cut-off (men 94 / women 80 cm) via the
 * `norms.ts` table.
 */
export default function InsightsWaistPage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="WAIST_CIRCUMFERENCE"
      statusMetric="WAIST_CIRCUMFERENCE"
      insightMetric="WAIST_CIRCUMFERENCE"
      chartKey="waistCircumference"
      i18nPrefix="insights.waist"
      color="var(--chart-4)"
      statIcon={Ruler}
      emptyStateIcon={<Ruler className="size-6" />}
      emptyStateCtaType="WAIST_CIRCUMFERENCE"
      coachPrefill={t("insights.waist.coachPrefill")}
    />
  );
}
