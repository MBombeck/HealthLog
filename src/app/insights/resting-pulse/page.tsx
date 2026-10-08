"use client";

import { Heart } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { EcgCrossLink } from "@/components/insights/ecg-cross-link";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.32 — `/insights/resting-pulse`.
 *
 * Resting-heart-rate sub-page. Distinct from `/insights/pulse` — Apple
 * Health splits the steady-state daily `restingHeartRate` value from
 * the spot `PULSE` samples logged manually or by Withings. The split
 * here mirrors that distinction so the user has a "daily floor"
 * trend that's not muddied by mid-walk readings.
 */
export default function InsightsRestingHrPage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="RESTING_HEART_RATE"
      statusMetric="RESTING_HEART_RATE"
      insightMetric="RESTING_HEART_RATE"
      chartKey="restingHr"
      i18nPrefix="insights.restingHr"
      explainerMetric="restingHr"
      color="var(--chart-3)"
      unit="bpm"
      yAxisUnit="bpm"
      emptyStateIcon={<Heart className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill={t("insights.restingHr.coachPrefill")}
      // S10 / H1 — device-attributed pointer into the ECG viewer, in the
      // resting-HR context. Self-gates to nothing without recordings.
      afterAssessment={<EcgCrossLink />}
    />
  );
}
