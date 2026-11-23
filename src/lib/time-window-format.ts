export function formatTimeWindowPart(value: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const hh = m[1].padStart(2, "0");
  const mm = m[2];
  return `${hh}:${mm}`;
}

import type { Locale } from "@/lib/i18n/config";

/**
 * Render a daily intake time window like "08:00 bis 12:00 Uhr" / "08:00 – 12:00".
 *
 * The historic call sites (see `medication-card.tsx`, `medication-form.tsx`)
 * never passed a locale, so the renderer hard-coded the German "bis ... Uhr"
 * suffix and the English locale ended up with mixed-language strings such as
 * `"Today, 19:00 bis 23:00 Uhr"`. Pass the active UI locale so that the right
 * separator + suffix are picked. When no locale is provided we keep the
 * legacy German output for backwards compatibility with any consumer we may
 * have missed.
 *
 * v1.4.25 — locales other than DE render with the language-neutral
 * "08:00 – 12:00" form (the same as EN) until a locale-specific suffix
 * ships. The DE branch keeps its trailing "Uhr" suffix verbatim.
 */
export function formatTimeWindowRange(
  start: string,
  end: string,
  locale?: Locale,
  /**
   * The reader's wall-clock formatter (`useFormatters().wallTime`), so the
   * range follows the 12 h / 24 h preference like every instant beside it.
   * Without it the parts stay `HH:mm`. The German "Uhr" suffix belongs to the
   * 24 h clock only and is dropped for a 12 h reading.
   */
  wallTime?: (hhmm: string) => string,
): string {
  const s = wallTime
    ? wallTime(formatTimeWindowPart(start))
    : formatTimeWindowPart(start);
  const e = wallTime
    ? wallTime(formatTimeWindowPart(end))
    : formatTimeWindowPart(end);
  const uhr = !/[a-z]/i.test(s + e);
  // A degenerate window — start == end (a single target time, or a med with
  // no real window span) — must read as ONE time, not "07:00 bis 07:00 Uhr" /
  // "07:00 – 07:00". The "bis" / "–" separator is reserved for a genuine
  // range. The DE branch keeps its "Uhr" suffix on the single time.
  if (s === e) {
    return (locale === undefined || locale === "de") && uhr ? `${s} Uhr` : s;
  }
  if (locale === undefined || locale === "de") {
    return uhr ? `${s} bis ${e} Uhr` : `${s} bis ${e}`;
  }
  return `${s} – ${e}`;
}
