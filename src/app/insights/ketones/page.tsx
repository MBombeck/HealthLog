"use client";

import { Droplet } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { GkiCard } from "@/components/insights/ketones/gki-card";
import { getUnitForType } from "@/lib/measurements/unit-map";

/** mmol/L, from the one canonical unit table; ketones have no unit choice. */
const KETONE_UNIT = getUnitForType("BLOOD_KETONES");

/**
 * `/insights/ketones` (#1367).
 *
 * Blood ketones (beta-hydroxybutyrate, mmol/L) on the generic metric
 * scaffold, with the glucose-ketone index beneath the chart. Readings are
 * typed off a meter, alone or together with the glucose from the same
 * fingerstick, so the empty state offers manual entry. No band and no
 * assessment card: what a ketone reading should be follows the plan a
 * clinician sets, and the page shows the readings as recorded.
 */
export default function InsightsKetonesPage() {
  return (
    <HealthKitMetricPage
      measurementType="BLOOD_KETONES"
      insightMetric="BLOOD_KETONES"
      chartKey="bloodKetones"
      i18nPrefix="insights.bloodKetones"
      color="var(--chart-3)"
      unit={KETONE_UNIT}
      yAxisUnit={KETONE_UNIT}
      statFractionDigits={1}
      emptyStateIcon={<Droplet className="size-6" />}
      emptyStateCtaType="BLOOD_KETONES"
      captureType="BLOOD_KETONES"
      afterChart={<GkiCard />}
    />
  );
}
