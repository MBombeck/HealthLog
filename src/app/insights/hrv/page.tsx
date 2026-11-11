"use client";

import { Activity } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useTranslations } from "@/lib/i18n/context";
import { EcgCrossLink } from "@/components/insights/ecg-cross-link";

/**
 * v1.4.32 — `/insights/hrv`.
 *
 * Heart-rate variability sub-page. Pairs with the iOS HKQuantityType
 * `heartRateVariabilitySDNN` ingest path; the user typically logs one
 * sample per night during sleep, so the chart is sparse but the
 * weekly trend is the load-bearing signal. Apple Health and Health Connect
 * store SDNN as millisecond `HEART_RATE_VARIABILITY` rows; Oura / Polar /
 * WHOOP / Fitbit / Google Health store nightly RMSSD as `HRV_RMSSD`. The page renders SDNN when present
 * and falls back to the RMSSD series (labelled "RMSSD") otherwise, so a
 * ring / strap user's stored HRV always surfaces. Since iOS 27 an Apple
 * Watch writes both (#1110); with rows of both the page charts each on its
 * own, labelled, because the two are not one measure.
 */
export default function InsightsHrvPage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="HEART_RATE_VARIABILITY"
      fallbackMeasurementType="HRV_RMSSD"
      fallbackMeasureLabel="RMSSD"
      primaryMeasureLabel="SDNN"
      fallbackColor="var(--chart-2)"
      statusMetric="HEART_RATE_VARIABILITY"
      insightMetric="HEART_RATE_VARIABILITY"
      chartKey="hrv"
      i18nPrefix="insights.hrv"
      explainerMetric="hrv"
      color="var(--chart-1)"
      unit="ms"
      yAxisUnit="ms"
      emptyStateIcon={<Activity className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill={t("insights.hrv.coachPrefill")}
      // S10 / H1 — device-attributed pointer into the ECG viewer, in the
      // HRV / heart context. Self-gates to nothing without recordings.
      afterAssessment={<EcgCrossLink />}
    />
  );
}
