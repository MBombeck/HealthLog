"use client";

import { Dumbbell } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.25 — `/insights/grip-strength`.
 *
 * Grip-strength sub-page. Rides the generic HealthKit metric template so the
 * signal gets the same detail spine as every other metric (chart, stat strip,
 * Coach-read strip, assessment card). The assessment threads the sex-aware
 * EWGSOP2 cut-off (men 27 / women 16 kg) via the `norms.ts` table.
 */
export default function InsightsGripStrengthPage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="GRIP_STRENGTH"
      statusMetric="GRIP_STRENGTH"
      insightMetric="GRIP_STRENGTH"
      chartKey="gripStrength"
      i18nPrefix="insights.gripStrength"
      color="var(--chart-2)"
      statIcon={Dumbbell}
      emptyStateIcon={<Dumbbell className="size-6" />}
      emptyStateCtaType="GRIP_STRENGTH"
      coachPrefill={t("insights.gripStrength.coachPrefill")}
    />
  );
}
