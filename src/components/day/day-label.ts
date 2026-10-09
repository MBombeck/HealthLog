"use client";

import type { DateKey } from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";

/**
 * "Saturday, 3 January 2026", for the day's header, its spoken name and its
 * strip. Its own module, so the shell's day layer can name a day without
 * loading the day view.
 */
export function useLongDayLabel(
  length: "long" | "short" = "long",
): (date: DateKey) => string {
  const { locale } = useTranslations();
  const intl = resolveIntlLocale(locale);
  return (date: DateKey) =>
    new Intl.DateTimeFormat(intl, {
      weekday: length,
      day: "numeric",
      month: length,
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${date}T12:00:00.000Z`));
}
