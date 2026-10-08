"use client";

import { Activity } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.25 — `/insights/pain`.
 *
 * Pain (0–10 NRS) sub-page. Patient-reported pain intensity on the validated
 * numeric rating scale; rides the generic metric template for its detail
 * spine + assessment (no-pain / mild band at 0–3).
 */
export default function InsightsPainPage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="PAIN_NRS"
      statusMetric="PAIN_NRS"
      insightMetric="PAIN_NRS"
      chartKey="painNrs"
      i18nPrefix="insights.pain"
      color="var(--chart-5)"
      unit=""
      yAxisUnit="/10"
      statIcon={Activity}
      emptyStateIcon={<Activity className="size-6" />}
      emptyStateCtaType="PAIN_NRS"
      coachPrefill={t("insights.pain.coachPrefill")}
    />
  );
}
