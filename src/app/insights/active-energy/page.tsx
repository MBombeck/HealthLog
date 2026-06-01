"use client";

import { Flame } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

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
  return (
    <HealthKitMetricPage
      measurementType="ACTIVE_ENERGY_BURNED"
      insightMetric="ACTIVE_ENERGY_BURNED"
      chartKey="activeEnergy"
      i18nPrefix="insights.activeEnergy"
      explainerMetric="activeEnergy"
      color="#ffb86c"
      unit="kcal"
      yAxisUnit="kcal"
      emptyStateIcon={<Flame className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any active energy yet — what's a reasonable daily target, and how does it compare to total calories?"
    />
  );
}
