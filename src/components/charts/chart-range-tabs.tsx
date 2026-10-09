"use client";

import { Button } from "@/components/ui/button";
import type { ChartRangePoints } from "@/lib/dashboard-layout";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The range tabs every chart drawn in days carries: 7 / 30 / 90 days and
 * All. One component, so the metric charts and the score histories offer
 * the same choice in the same place and look the same doing it.
 *
 * The tabs select a CALENDAR-DAY window ending now — `days: 7` is "the last
 * 7 days", not "the last 7 readings". The persisted preference field keeps
 * its historical name `rangePoints` (it crosses the chart-overlay-prefs
 * wire), but its value has always been days. `0` is "All".
 */
export const CHART_RANGE_TABS = [
  { labelKey: "charts.days7Label", days: 7, titleKey: "charts.days7Title" },
  { labelKey: "charts.days30Label", days: 30, titleKey: "charts.days30Title" },
  { labelKey: "charts.days90Label", days: 90, titleKey: "charts.days90Title" },
  { labelKey: "charts.daysAllLabel", days: 0, titleKey: "charts.daysAllTitle" },
] as const satisfies ReadonlyArray<{
  labelKey: string;
  days: ChartRangePoints;
  titleKey: string;
}>;

/** The tab a chart opens on before anything was chosen. */
export const DEFAULT_CHART_RANGE: ChartRangePoints = 30;

/**
 * v1.19.0 — day-span the "All" tab (`0`) fetches. A generous fixed bound
 * (~10 years) that is clearly larger than any other tab, so "All" means "all
 * of my history" rather than a silent one-year truncation. Fixed (not per
 * account) so the fetch-window cache key stays stable across the session.
 */
export const ALL_RANGE_DAYS = 3650;

/** The day window a tab asks the server for. */
export function rangeWindowDays(range: number): number {
  return range > 0 ? range : ALL_RANGE_DAYS;
}

export function ChartRangeTabs({
  value,
  onChange,
}: {
  value: number;
  onChange: (days: ChartRangePoints) => void;
}) {
  const { t } = useTranslations();
  return (
    <>
      {CHART_RANGE_TABS.map((r) => (
        <Button
          key={r.labelKey}
          variant={value === r.days ? "default" : "ghost"}
          aria-pressed={value === r.days}
          size="sm"
          className="min-h-11 px-2 text-xs sm:px-3"
          onClick={() => onChange(r.days)}
          title={t(r.titleKey)}
          data-slot="chart-range-tab"
          data-range={r.days}
        >
          {t(r.labelKey)}
        </Button>
      ))}
    </>
  );
}
