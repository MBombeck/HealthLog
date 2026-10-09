"use client";

import { useMemo } from "react";

import { useDayValueFormat } from "@/components/day/use-day-value-format";
import { useFormatters } from "@/lib/i18n/context";

import { plainSeriesFormat, type SeriesValueFormat } from "./series-format";

/** The mood score's series key (`MOOD_SERIES_KEY` on the server). */
const MOOD_SERIES_KEY = "MOOD";

/**
 * The timeline's value format: the day view's formatter for every
 * measurement series (unit preference, whole numbers for pressure and
 * pulse, sleep as a duration), one plain decimal for mood, which has no
 * measurement type behind it.
 */
export function useSeriesValueFormat(): SeriesValueFormat {
  const fmt = useFormatters();
  const { number, unitFor } = useDayValueFormat();
  return useMemo(() => {
    const plain = plainSeriesFormat(fmt);
    return {
      number: (key, value, unit) =>
        key === MOOD_SERIES_KEY || unit === null
          ? plain.number(key, value, unit)
          : number({ type: key, unit }, value),
      unit: (key, unit) =>
        key === MOOD_SERIES_KEY || unit === null
          ? plain.unit(key, unit)
          : unitFor({ type: key, unit }),
    };
  }, [fmt, number, unitFor]);
}
