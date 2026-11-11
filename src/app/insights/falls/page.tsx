"use client";

import { PersonStanding } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.10.0 — `/insights/falls`.
 *
 * FALL_COUNT sub-page. Hard-fall detections, summed per day; fewer is
 * better. The series arrives from Apple Health sync — no manual-entry CTA.
 */
export default function InsightsFallsPage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="FALL_COUNT"
      statusMetric="FALL_COUNT"
      insightMetric="FALL_COUNT"
      chartKey="fallCount"
      i18nPrefix="insights.falls"
      explainerMetric="falls"
      color="var(--chart-3)"
      unitKey="insights.units.falls"
      emptyStateIcon={<PersonStanding className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill={t("insights.falls.coachPrefill")}
    />
  );
}
