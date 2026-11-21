"use client";

import { createElement, useCallback, type ComponentProps } from "react";

import { DayLinkStated } from "@/components/day/day-link";

import { useCalendarDate } from "@/hooks/use-calendar-date";
import { useDisplayTimezone, useFormatters } from "@/lib/i18n/context";
import { formatLabValue, type LabNumberFormat } from "@/lib/labs/format-value";
import { isLabDateOnly, labReadingDay } from "@/lib/labs/reading-day";

/**
 * A lab value in the reader's number format, with every digit the reading
 * holds (see `formatLabValue`). Pass the reading's `sourceValue` as `printed`
 * for a converted reading so it keeps the precision its report printed.
 */
export function useLabNumber(): LabNumberFormat {
  const fmt = useFormatters();
  return useCallback(
    (value: number, printed?: number | null) =>
      formatLabValue(value, fmt.number, printed),
    [fmt],
  );
}

/**
 * The date a lab reading was taken. A reading entered by hand carries its
 * time of day and is dated in the reader's zone; one imported from a report
 * that states only the date is stored at noon (older rows: midnight) UTC and
 * is dated by that calendar date (`isLabDateOnly`), the same day the server
 * files it under.
 */
export function useLabDate(): (takenAt: string) => string {
  const fmt = useFormatters();
  const calendarDate = useCalendarDate();
  return useCallback(
    (takenAt: string) => {
      const instant = new Date(takenAt);
      return isLabDateOnly(instant) ? calendarDate(instant) : fmt.date(instant);
    },
    [fmt, calendarDate],
  );
}

/**
 * A link that opens the day a lab reading belongs to, by the same rule the
 * server files it under (`labReadingDay`).
 */
export function LabDayLink({
  takenAt,
  ...props
}: Omit<ComponentProps<typeof DayLinkStated>, "at"> & { takenAt: string }) {
  const timeZone = useDisplayTimezone();
  return createElement(DayLinkStated, {
    ...props,
    at: labReadingDay(takenAt, timeZone),
  });
}
