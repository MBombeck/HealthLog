/**
 * Legacy locale-aware date/time helpers, kept only for their remaining
 * importers under `src/components/medications/**` (`formatDateTime`,
 * `formatTime`). Once those move to `useFormatters()` from
 * `@/lib/i18n/context`, delete this module. Every other caller already
 * formats through `useFormatters()` (client) or `makeFormatters(locale)` from
 * `@/lib/format-locale` (server). Do not add new importers.
 *
 * The helpers guess the locale from the `healthlog-locale` cookie, then
 * localStorage, falling back to `en`; on the server `document` is undefined,
 * so they always render `en`. The remaining callers render only after a
 * `useQuery` fetch, i.e. post-hydration, so no hydration mismatch arises.
 */

import { makeFormatters } from "./format-locale";
import { readStoredDateFormat } from "./date-format";
import { readStoredTimeFormat } from "./time-format";
import { readStoredTimezone } from "./timezone-mirror";
import { locales, type Locale } from "./i18n/config";

function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

function activeLocale(): Locale {
  if (typeof document === "undefined") return "en";
  // Prefer the cookie (what SSR used) over localStorage to stay in sync
  // across hydration. Falls back to localStorage for backwards compat.
  const cookieMatch = document.cookie.match(
    /(?:^|;\s*)healthlog-locale=([^;]+)/,
  );
  const fromCookie = cookieMatch?.[1];
  if (isLocale(fromCookie)) return fromCookie;
  const fromStorage = window.localStorage?.getItem("healthlog-locale");
  if (isLocale(fromStorage)) return fromStorage;
  return "en";
}

function formatters() {
  // Honour the mirrored hour-cycle preference, the mirrored profile timezone
  // (issue #490) AND the mirrored date order (issue #922) so these legacy
  // helpers render the same clock, zone and field order as `useFormatters()`
  // call sites. The date mirror was the one of the three that was never read
  // here, which is why the measurements list ignored the profile setting the
  // entry form's `<DateField>` obeyed. SSR reads AUTO + "" (→ Berlin) — same
  // post-hydration caveat as `activeLocale()` above.
  return makeFormatters(
    activeLocale(),
    readStoredTimezone(),
    readStoredTimeFormat(),
    readStoredDateFormat(),
  );
}

/** Locale-aware "19.02.2026, 14:30" or "02/19/2026, 2:30 PM". */
export function formatDateTime(date: Date | string): string {
  return formatters().dateTime(date);
}

/** Locale-aware "14:30". */
export function formatTime(date: Date | string): string {
  return formatters().time(date);
}
