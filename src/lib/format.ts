/**
 * Legacy locale-aware date/time helpers.
 *
 * These originally hard-coded `de-DE`. They now defer to `makeFormatters`
 * using a best-effort read of `healthlog-locale` from cookie → localStorage,
 * falling back to `en`. New code should prefer `useFormatters()` from
 * `@/lib/i18n/context` (client) or `makeFormatters(locale)` from
 * `@/lib/format-locale` (server).
 *
 * SSR caveat: on the server `activeLocale()` always returns `en` because
 * `document` is undefined. All current call sites render their formatted
 * strings only after a `useQuery` fetch — i.e. post-hydration — so there is
 * no hydration-mismatch path today. If you add a new caller that renders
 * pre-fetch data (e.g. a static prop), migrate it to `useFormatters()` to
 * stay consistent with the server-rendered locale.
 */

import { makeFormatters, DISPLAY_TIMEZONE } from "./format-locale";
import type { Locale } from "./i18n/config";

export { DISPLAY_TIMEZONE };

function activeLocale(): Locale {
  if (typeof document === "undefined") return "en";
  // Prefer the cookie (what SSR used) over localStorage to stay in sync
  // across hydration. Falls back to localStorage for backwards compat.
  const cookieMatch = document.cookie.match(
    /(?:^|;\s*)healthlog-locale=([^;]+)/,
  );
  const fromCookie = cookieMatch?.[1];
  if (fromCookie === "de" || fromCookie === "en") return fromCookie;
  const fromStorage = window.localStorage?.getItem("healthlog-locale");
  return fromStorage === "de" ? "de" : "en";
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
