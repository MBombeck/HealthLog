"use client";

import { Flame } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.32 — `/insights/active-energy`.
 *
 * Active-energy-burned sub-page. The MeasurementType is cumulative
 * (kcal per day, per R-A Option A); the v1.4.30 server-side daily-
 * stats helper collapses per-sample iOS posts to a single daily row.
 * The chart shows that one-row-per-day shape — long-tail back-fill
 * imports collapse cleanly via the v1.4.30 drain script.
 */
export default function InsightsActiveEnergyPage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="ACTIVE_ENERGY_BURNED"
      statusMetric="ACTIVE_ENERGY"
      insightMetric="ACTIVE_ENERGY_BURNED"
      chartKey="activeEnergy"
      i18nPrefix="insights.activeEnergy"
      explainerMetric="activeEnergy"
      color="var(--chart-5)"
      unit="kcal"
      yAxisUnit="kcal"
      emptyStateIcon={<Flame className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill={t("insights.activeEnergy.coachPrefill")}
    />
  );
}
