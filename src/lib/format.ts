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
 *
 * v1.4.43 QoL (M8) — `activeLocale()` now reads the full `Locale` union
 * (`de | en | fr | es | it | pl`). Pre-fix, a sub-locale user (fr / es /
 * it / pl) saw French strings but the legacy SSR formatters silently
 * fell back to `en`, producing "12/24/2025, 2:30 PM" in a French shell.
 * `Intl.DateTimeFormat` already handles every supported locale via the
 * `INTL_LOCALE_MAP`, so the only change is to widen the cookie /
 * localStorage decoder.
 */

import { makeFormatters } from "./format-locale";
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

/**
 * v1.4.43 QoL (L8) — render a timestamp as a relative phrase when it
 * happened within the last 24 hours, otherwise fall back to the
 * absolute locale-aware date+time. Closes the visual inconsistency
 * the measurement-list surfaced: the same screen could show "vor 3
 * min" (briefing) alongside "21.05.2026, 14:32" (list rows) for
 * adjacent events.
 *
 * Buckets:
 *   - < 1 m  → "just now"
 *   - < 1 h  → "vor N min" / "N min ago"
 *   - < 24 h → "vor N Std." / "N h ago"
 *   - ≥ 24 h → absolute `formatDateTime`
 *
 * The relative branch reuses the `insights.relative*` i18n keys (same
 * keys `formatRelativeTime()` reads from `@/lib/i18n/relative-time`).
 * Caller supplies a `t()` translator so this helper stays usable
 * server-side; clients should pass `useTranslations().t`. The buckets
 * mirror the briefing's existing copy so users never see two
 * different relative phrasings in the same view.
 */
export function formatDateOrRelative(
  iso: Date | string,
  t: (key: string, params?: Record<string, string | number>) => string,
  /**
   * Optional "now" for deterministic tests. Defaults to `Date.now()`.
   */
  nowMs: number = Date.now(),
): string {
  const target =
    iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = nowMs - target;
  // Future timestamps fall back to absolute — relative copy doesn't
  // model them and "in 3 min" would mislead in a health-log context.
  if (diffMs < 0) return formatDateTime(iso);
  if (diffMs < 60_000) return t("insights.relativeJustNow");
  // v1.4.49.2 — One/Other pluralisation. Mirrors the
  // `src/lib/i18n/relative-time.ts:24-48` pattern (which got this fix in
  // v1.4.43 H6 for the "vor 1 Minuten" bug). This twin helper was missed
  // in the v1.4.43 sweep, so the bare `t("insights.relativeMinutesAgo",
  // { count })` and `t("insights.relativeHoursAgo", { count })` calls
  // returned the key itself — the translation bundle only carries the
  // pluralised `*One` / `*Other` variants. Reported by Marc as raw
  // `insights.relativeHoursAgo` leaking onto medication cards, recent-
  // achievements, admin sections, and every other consumer of
  // `formatDateOrRelative`.
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return t(
      minutes === 1
        ? "insights.relativeMinutesAgoOne"
        : "insights.relativeMinutesAgoOther",
      { count: minutes },
    );
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t(
      hours === 1
        ? "insights.relativeHoursAgoOne"
        : "insights.relativeHoursAgoOther",
      { count: hours },
    );
  }
  return formatDateTime(iso);
}

