"use client";

import { Percent } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";

/**
 * `/insights/body-fat`.
 *
 * BODY_FAT sub-page on the generic HealthKitMetricPage scaffold, like its
 * body-composition siblings. The dashboard tile and chart for body fat
 * predate the sub-pages; this is the page the tile opens. Readings arrive
 * from a body-composition scale or by hand, so the empty state offers
 * manual entry.
 */
export default function InsightsBodyFatPage() {
  return (
    <HealthKitMetricPage
      measurementType="BODY_FAT"
      insightMetric="BODY_FAT"
      chartKey="bodyFat"
      i18nPrefix="insights.bodyFat"
      explainerMetric="bodyFat"
      color="var(--chart-5)"
      unit="%"
      statIcon={Percent}
      emptyStateIcon={<Percent className="size-6" />}
      emptyStateCtaType="BODY_FAT"
    />
  );
}
