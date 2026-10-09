"use client";

import type { Matcher } from "react-day-picker";

import { Calendar } from "@/components/ui/calendar";
import type { Locale } from "@/lib/i18n/config";

import { resolveDateFnsLocale } from "./calendar-locale";

/**
 * `DateField`'s single-day calendar, in its own module so the field can
 * load it on demand (`date-field.tsx`). Takes the app locale and resolves
 * the date-fns one here, beside react-day-picker, so neither rides the
 * field.
 */
export function DateFieldCalendar({
  appLocale,
  selected,
  onSelect,
  disabled,
  defaultMonth,
}: {
  appLocale: Locale;
  selected: Date | undefined;
  onSelect: (date: Date | undefined) => void;
  disabled: Matcher[] | undefined;
  defaultMonth: Date;
}) {
  return (
    <Calendar
      mode="single"
      selected={selected}
      onSelect={onSelect}
      disabled={disabled}
      defaultMonth={defaultMonth}
      locale={resolveDateFnsLocale(appLocale)}
      autoFocus
    />
  );
}
