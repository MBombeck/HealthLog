"use client";

import { useCallback } from "react";

import {
  rangeWindowDays,
  DEFAULT_CHART_RANGE,
} from "@/components/charts/chart-range-tabs";
import { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import {
  BP_PARTS_OF_DAY,
  type BpPartOfDay,
} from "@/lib/analytics/bp-time-of-day";
import { useUrlSearch, writeUrlState } from "@/lib/url-state";

/** The chart's part of the day, or the whole day. */
export type BpChartPart = BpPartOfDay | "all";

/** `?partOfDay=` as a part of the day; anything else is the whole day. */
export function parseBpChartPart(
  params: URLSearchParams,
): BpPartOfDay | undefined {
  const raw = params.get("partOfDay");
  return BP_PARTS_OF_DAY.find((part) => part === raw);
}

const CHART_TITLE_KEYS: Record<BpPartOfDay, string> = {
  morning: "insights.bpTimeOfDay.chartTitle.morning",
  midday: "insights.bpTimeOfDay.chartTitle.midday",
  evening: "insights.bpTimeOfDay.chartTitle.evening",
};

/**
 * The blood-pressure page's time-of-day state (#1331).
 *
 * The part of the day the chart is narrowed to lives in the URL
 * (`?partOfDay=`), so a narrowed view survives a reload, Back and a shared
 * link; the whole day keeps a bare URL. A change is a discrete facet, so it
 * pushes a history entry. `days` is the chart's own range tab (the persisted
 * pick, the default before it loads), so the averages read the window the
 * chart draws.
 */
export function useBpTimeOfDayState(): {
  partOfDay: BpPartOfDay | undefined;
  /** The chart title's message key while narrowed; undefined for the whole day. */
  chartTitleKey: string | undefined;
  setChartPart: (next: BpChartPart) => void;
  days: number;
} {
  const partOfDay = parseBpChartPart(useUrlSearch());
  const setChartPart = useCallback((next: BpChartPart) => {
    writeUrlState(
      (params) => {
        if (next === "all") params.delete("partOfDay");
        else params.set("partOfDay", next);
      },
      { mode: "push" },
    );
  }, []);
  const range =
    useChartOverlayPrefs("bp").prefs.rangePoints ?? DEFAULT_CHART_RANGE;
  return {
    partOfDay,
    chartTitleKey: partOfDay ? CHART_TITLE_KEYS[partOfDay] : undefined,
    setChartPart,
    days: rangeWindowDays(range),
  };
}
