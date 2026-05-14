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
 * v1.4.25 W9e — locales other than DE render with the language-neutral
 * "08:00 – 12:00" form (the same as EN) until a locale-specific suffix
 * ships. The DE branch keeps its trailing "Uhr" suffix verbatim.
 */
export function formatTimeWindowRange(
  start: string,
  end: string,
  locale?: Locale,
): string {
  const s = formatTimeWindowPart(start);
  const e = formatTimeWindowPart(end);
  if (locale === undefined || locale === "de") {
    return `${s} bis ${e} Uhr`;
  }
  return `${s} – ${e}`;
}
