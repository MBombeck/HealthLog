"use client";

import { Activity } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.4.32 — `/insights/hrv`.
 *
 * Heart-rate variability sub-page. Pairs with the iOS HKQuantityType
 * `heartRateVariabilitySDNN` ingest path; the user typically logs one
 * sample per night during sleep, so the chart is sparse but the
 * weekly trend is the load-bearing signal. Stored as millisecond
 * `HEART_RATE_VARIABILITY` rows by every existing ingest path.
 */
export default function InsightsHrvPage() {
  return (
    <HealthKitMetricPage
      measurementType="HEART_RATE_VARIABILITY"
      insightMetric="HEART_RATE_VARIABILITY"
      chartKey="hrv"
      i18nPrefix="insights.hrv"
      explainerMetric="hrv"
      color="#bd93f9"
      unit="ms"
      yAxisUnit="ms"
      emptyStateIcon={<Activity className="size-6" />}
      emptyStateCtaType={null}
      coachPrefill="I haven't logged any HRV data yet — what does heart-rate variability tell me, and how do I capture it?"
    />
  );
}
