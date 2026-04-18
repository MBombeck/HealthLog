/**
 * Legacy locale-aware date/time helpers.
 *
 * These originally hard-coded `de-DE`. They are now locale-aware via the
 * reader resolution below. New code should prefer `useFormatters()` from
 * `@/lib/i18n/context` (client) or `makeFormatters(locale)` from
 * `@/lib/format-locale` (server). These helpers remain so existing call sites
 * work during migration.
 */

import { makeFormatters, DISPLAY_TIMEZONE } from "./format-locale";
import type { Locale } from "./i18n/config";

export { DISPLAY_TIMEZONE };

function activeLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const saved = window.localStorage?.getItem("healthlog-locale");
  return saved === "de" ? "de" : "en";
}

function formatters() {
  return makeFormatters(activeLocale());
}

/** Locale-aware "19.02.2026, 14:30" or "02/19/2026, 2:30 PM". */
export function formatDateTime(date: Date | string): string {
  return formatters().dateTime(date);
}

/** Locale-aware "19.02.2026" or "02/19/2026". */
export function formatDate(date: Date | string): string {
  return formatters().date(date);
}

/** Locale-aware short date without year unless `includeYear`. */
export function formatDateShort(
  date: Date | string,
  includeYear = false,
): string {
  const f = formatters();
  return includeYear ? f.date(date) : f.dateShort(date);
}

/** Locale-aware "14:30". */
export function formatTime(date: Date | string): string {
  return formatters().time(date);
}

/** Locale-aware short weekday + date. */
export function formatDateWithWeekday(date: Date | string): string {
  return formatters().dateWithWeekday(date);
}
