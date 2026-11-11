"use client";

import { CalendarDays, Footprints } from "lucide-react";

import { CrossLinkCard } from "@/components/insights/cross-link-card";
import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useSurfaceVisible } from "@/hooks/use-surface-visible";
import { useTranslations } from "@/lib/i18n/context";

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
 *
 * v1.44 — links across to the activity calendar on the workouts page, which
 * shows the same day totals as a week or month against the person's usual.
 * The link follows the Workouts module: switched off, it is not offered.
 */
export default function InsightsStepsPage() {
  const { t } = useTranslations();
  const calendarVisible = useSurfaceVisible("insights-page:workouts");
  return (
    <HealthKitMetricPage
      measurementType="ACTIVITY_STEPS"
      statusMetric="STEPS"
      insightMetric="ACTIVITY_STEPS"
      chartKey="steps"
      i18nPrefix="insights.steps"
      explainerMetric="steps"
      statIcon={Footprints}
      color="var(--chart-2)"
      unitKey="insights.units.steps"
      emptyStateIcon={<Footprints className="size-6" />}
      emptyStateCtaType={null}
      captureType="ACTIVITY_STEPS"
      coachPrefill={t("insights.steps.coachPrefill")}
      afterChart={
        calendarVisible ? (
          <CrossLinkCard
            href="/insights/workouts#activity-calendar"
            slot="steps-activity-calendar-link"
            icon={CalendarDays}
            title={t("activityCalendar.crossLink.title")}
            body={t("activityCalendar.crossLink.body")}
            cta={t("activityCalendar.crossLink.cta")}
          />
        ) : null
      }
    />
  );
}
