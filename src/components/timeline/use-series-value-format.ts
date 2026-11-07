"use client";

import { useCallback, useMemo } from "react";

import { useDayValueFormat } from "@/components/day/use-day-value-format";
import {
  TIMELINE_SYMPTOM_SCALE,
  timelineSymptomDefinitionId,
} from "@/lib/day/contract";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import { plainSeriesFormat, type SeriesValueFormat } from "./series-format";

/** The mood score's series key (`MOOD_SERIES_KEY` on the server). */
const MOOD_SERIES_KEY = "MOOD";

/**
 * The timeline's value format: the day view's formatter for every
 * measurement series (unit preference, whole numbers for pressure and
 * pulse, sleep as a duration), one plain decimal for mood, which has no
 * measurement type behind it, and at most one decimal out of the scale's top
 * for a symptom ("6.5/10", "3/10", #981).
 */
export function useSeriesValueFormat(): SeriesValueFormat {
  const fmt = useFormatters();
  const { number, unitFor } = useDayValueFormat();
  return useMemo(() => {
    const plain = plainSeriesFormat(fmt);
    // At most one decimal, none for a whole intensity: "3/10", "6.5/10".
    const symptomNumber = (value: number) => {
      const rounded = Math.round(value * 10) / 10;
      return fmt.number(rounded, Number.isInteger(rounded) ? 0 : 1);
    };
    return {
      number: (key, value, unit) =>
        timelineSymptomDefinitionId(key) !== null
          ? `${symptomNumber(value)}/${TIMELINE_SYMPTOM_SCALE.max}`
          : key === MOOD_SERIES_KEY || unit === null
            ? plain.number(key, value, unit)
            : number({ type: key, unit }, value),
      unit: (key, unit) =>
        key === MOOD_SERIES_KEY || unit === null
          ? plain.unit(key, unit)
          : unitFor({ type: key, unit }),
    };
  }, [fmt, number, unitFor]);
}

/**
 * What stands behind one point of a value line: "mean of 4 readings" for a
 * measurement or mood, "on 3 days" for a symptom, whose count is the days
 * it was logged (#981).
 */
export function useSeriesCountText(): (key: string, count: number) => string {
  const { tCount } = useTranslations();
  return useCallback(
    (key, count) =>
      timelineSymptomDefinitionId(key) !== null
        ? tCount("timeline.symptoms.days", count)
        : tCount("timeline.values.readings", count),
    [tCount],
  );
}
