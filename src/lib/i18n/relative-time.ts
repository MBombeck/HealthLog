/**
 * v1.4.20 — shared relative-time helper.
 *
 * Formats an ISO timestamp as a localised "just now" / "N minutes ago"
 * string via i18n keys. Three Insights surfaces (hero strip, daily
 * briefing, history rail) carried byte-identical copies of this helper;
 * lift the body here so a future i18n key change lands once.
 *
 * Buckets: <1m → just-now, <1h → minutes, <24h → hours, else days.
 *
 * v1.4.43 — pluralisation. Each bucket reads a *One (singular) or
 * *Other (plural) key, matching the dashboard.staleHintWeeksOne / Other
 * pattern already in the bundle. Eliminates the "vor 1 Minuten" grammar
 * bug a German user spotted.
 *
 * The tier now comes from `pluralKey`, which adds the *Few form Polish
 * needs for 2–4. Locales whose rules have no "few" category resolve to the
 * same two keys as before. `locale` defaults to the app default so a caller
 * without one in hand keeps the previous behaviour rather than throwing.
 */
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  shiftDateKey,
} from "@/lib/tz/format";
import { resolveIntlLocale, type Formatters } from "@/lib/format-locale";
import { pluralKey } from "./plural";
import { defaultLocale, type Locale } from "./config";

/**
 * Resolve the day-boundary zone for the calendar-bucketed labels below.
 * Issue #490 half-fix closure: `timeZone` used to flow straight into
 * `Intl.DateTimeFormat`, where `undefined` silently meant the BROWSER
 * zone — so pre-`/api/auth/me` the today/yesterday boundary followed the
 * device while the rendered clock (`fmt.time`) followed the profile
 * mirror. Boundary and clock must resolve the SAME zone in every state:
 * valid zone → itself; undefined / "" / garbage → Berlin (the exact
 * fallback `makeFormatters` applies to the clock). Never the browser.
 */
function resolveBoundaryZone(timeZone: string | undefined): string {
  return timeZone && isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
}

export function formatRelativeTime(
  iso: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: Locale = defaultLocale,
): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = Date.now() - target;
  if (diffMs < 60_000) return t("insights.relativeJustNow");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return t(pluralKey("insights.relativeMinutesAgo", minutes, locale), {
      count: minutes,
    });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t(pluralKey("insights.relativeHoursAgo", hours, locale), {
      count: hours,
    });
  }
  const days = Math.floor(hours / 24);
  return t(pluralKey("insights.relativeDaysAgo", days, locale), {
    count: days,
  });
}

/**
 * v1.18.9 — date-only relative label, shared with the medication card grammar.
 *
 * Buckets a calendar date against "now": same day → `medications.today`
 * ("Heute"), the day before → `medications.yesterday` ("Gestern"), otherwise
 * the absolute date through the caller's locale formatter. The today /
 * yesterday i18n keys are the SAME ones the medication card renders for its
 * last-taken line, so a Vorsorge "zuletzt erledigt" reads identically.
 *
 * Day-bucketing uses an `en-CA` (YYYY-MM-DD) day key — locale-independent and
 * string-comparable — formatted in the supplied IANA `timeZone` so the
 * boundary follows the user's zone, not the server's. `formatDate` renders the
 * absolute fallback (pass the locale `fmt.date`).
 */
export function relativeCalendarDate(
  iso: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  formatDate: (value: Date) => string,
  timeZone?: string,
): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return "";
  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveBoundaryZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // Yesterday is the key before today's, not the host's calendar step back:
  // `setDate(-1)` moves in the HOST zone, which on a server is UTC, so in the
  // hour around a change of clocks in `timeZone` it named the wrong day.
  const today = dayFormatter.format(new Date());

  const targetDay = dayFormatter.format(target);
  if (targetDay === today) return t("medications.today");
  if (targetDay === shiftDateKey(today, -1)) return t("medications.yesterday");
  return formatDate(target);
}

/**
 * v1.22 — "Updated …" freshness label for the insight surfaces.
 *
 * Replaces the bare relative read ("2 hours ago") on the briefing + per-metric
 * cards with a calendar-bucketed label that shows the TIME only for today:
 *   - today     → "Updated today, 14:30"   (time via the locale formatter)
 *   - yesterday → "Updated yesterday"        (no time)
 *   - older     → "Updated on 14.06."        (date-only, honours the user's
 *                  DateFormatPreference via the passed `formatDate`)
 *
 * Day-bucketing uses an `en-CA` (YYYY-MM-DD) key formatted in `timeZone` so the
 * boundary follows the user's zone, matching `relativeCalendarDate`. `formatDate`
 * + `formatTime` come from the locale formatters hook (`useFormatters` →
 * `fmt.dateShort` / `fmt.time`), so both honour the user's locale + preferences.
 */
export function formatUpdatedLabel(
  iso: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  formatDate: (value: Date) => string,
  formatTime: (value: Date) => string,
  timeZone?: string,
): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return "";
  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveBoundaryZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // The key before today's, as in `relativeCalendarDate` above.
  const today = dayFormatter.format(new Date());

  const targetDay = dayFormatter.format(target);
  if (targetDay === today) {
    return t("insights.updatedTodayAt", { time: formatTime(target) });
  }
  if (targetDay === shiftDateKey(today, -1)) {
    return t("insights.updatedYesterday");
  }
  return t("insights.updatedOn", { date: formatDate(target) });
}

/**
 * Render a timestamp as a relative phrase when it
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
 *   - ≥ 24 h → absolute `fmt.dateTime`
 *
 * The relative branch reuses the `insights.relative*` i18n keys (same
 * keys `formatRelativeTime()` above reads).
 * Caller supplies a `t()` translator and the formatter set so this
 * helper stays usable server-side; clients pass `useTranslations().t`
 * and `useFormatters()`. The buckets
 * mirror the briefing's existing copy so users never see two
 * different relative phrasings in the same view.
 */
export function formatDateOrRelative(
  iso: Date | string,
  t: (key: string, params?: Record<string, string | number>) => string,
  /** Formatter set the absolute branch renders through (`useFormatters()`). */
  fmt: Pick<Formatters, "dateTime">,
  /**
   * Optional "now" for deterministic tests. Defaults to `Date.now()`.
   */
  nowMs: number = Date.now(),
): string {
  const target = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = nowMs - target;
  // Future timestamps fall back to absolute — relative copy doesn't
  // model them and "in 3 min" would mislead in a health-log context.
  if (diffMs < 0) return fmt.dateTime(iso);
  if (diffMs < 60_000) return t("insights.relativeJustNow");
  // One/Other pluralisation, as in `formatRelativeTime` above: the bundle
  // carries only the `*One` / `*Other` variants, so a bare key would print
  // itself.
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
  return fmt.dateTime(iso);
}

/**
 * The compact relative label of a list row's meta line: "vor 7 Std.",
 * "3 days ago", "il y a 2 j". The short style comes from
 * `Intl.RelativeTimeFormat`, so it needs no strings of its own; a week or
 * more back it is the date. Under a minute it says "just now" through the
 * same key as the long form.
 */
export function formatRelativeShort(
  iso: Date | string,
  t: (key: string) => string,
  locale: Locale,
  fmt: Pick<Formatters, "date">,
  nowMs: number = Date.now(),
): string {
  const target = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = nowMs - target;
  if (diffMs < 0) return fmt.date(iso);
  if (diffMs < 60_000) return t("insights.relativeJustNow");
  const rtf = new Intl.RelativeTimeFormat(resolveIntlLocale(locale), {
    style: "short",
    numeric: "always",
  });
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, "day");
  return fmt.date(iso);
}
