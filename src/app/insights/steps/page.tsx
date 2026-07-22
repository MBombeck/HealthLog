"use client";

import { Footprints } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * v1.12 — `/insights/steps`.
 *
 * Daily step-count sub-page. Steps are stored as `ACTIVITY_STEPS`
 * (cumulative per day; the server-side daily-stats helper collapses
 * per-sample iOS posts into a single daily row). The metric already had
 * a dashboard tile but was never listed in `sub-page-metric.ts`, so it
 * never surfaced in the Insights tab strip / sub-page nav despite the
 * user having step data. Reuses the generic HealthKitMetricPage scaffold;
 * empty-state carries no manual-entry CTA — the series arrives from Apple
 * Health or Withings sync.
 */
export default function InsightsStepsPage() {
  return (
    <HealthKitMetricPage
      measurementType="ACTIVITY_STEPS"
      statusMetric="STEPS"
      insightMetric="ACTIVITY_STEPS"
      chartKey="steps"
      i18nPrefix="insights.steps"
      explainerMetric="steps"
      statIcon={Footprints}
      color="var(--success)"
      unit="steps"
      yAxisUnit="steps"
      emptyStateIcon={<Footprints className="size-6" />}
      emptyStateCtaType={null}
      captureType="ACTIVITY_STEPS"
      coachPrefill="I haven't logged any steps yet — what's a reasonable daily step target, and how does walking more help my health?"
    />
  );
}
