/**
 * Locale-aware formatters.
 *
 * HealthLog's UI language is user-configurable (DE/EN). Numbers, dates, and
 * times must render in the active locale — not in the hard-coded de-DE that
 * lingered from the German-first era.
 *
 * Call via the `useFormatters()` client hook. For server-only code paths
 * (jobs, API routes, PDF generation) pass the locale explicitly through
 * `makeFormatters(locale)`. The optional second argument carries the
 * per-user timezone (v1.4.25 W7) — when omitted the formatter falls back
 * to `DEFAULT_TIMEZONE` so legacy callers keep rendering in the default zone.
 *
 * UTC is always preserved in the database.
 */

import { localeFromLanguageTag, type Locale } from "./i18n/config";
import { getDateTimeFormat, getNumberFormat } from "./intl/formatter-cache";
import { DEFAULT_TIMEZONE, isValidTimezone } from "./tz/format";

/**
 * Map our short locale ("de" / "en") to a full BCP-47 tag suitable for
 * `Intl.*`. When we add locales, extend this map — do not rely on the short
 * tag directly since browsers differ in how they handle "en" vs "en-US".
 */
const INTL_LOCALE_MAP: Record<Locale, string> = {
  de: "de-DE",
  en: "en-US",
  fr: "fr-FR",
  es: "es-ES",
  it: "it-IT",
  pl: "pl-PL",
  ko: "ko-KR",
  nl: "nl-NL",
  "pt-BR": "pt-BR",
  ru: "ru-RU",
};

export function resolveIntlLocale(locale: Locale): string {
  return INTL_LOCALE_MAP[locale] ?? "en-US";
}

/**
 * Hour-cycle display preference (mirrors the `TimeFormatPreference` Prisma
 * enum). AUTO defers to the locale's own convention (en-US → AM/PM, de-DE →
 * 24h); H12 forces AM/PM; H24 forces a 24-hour clock ("h23": midnight is
 * 00:30, never 24:30). Display-time only — stored instants stay UTC.
 */
export type TimeFormatPreference = "AUTO" | "H12" | "H24";

/**
 * Date-order display preference (mirrors the `DateFormatPreference` Prisma
 * enum). AUTO defers to the locale's own field order (de-DE → dd.MM.yyyy,
 * en-US → MM/dd/yyyy); DMY pins day-month-year, MDY pins month-day-year,
 * YMD pins ISO yyyy-MM-dd. Display-time only — stored instants stay UTC.
 */
export type DateFormatPreference = "AUTO" | "DMY" | "MDY" | "YMD";

/**
 * Intl options for the requested hour cycle. AUTO contributes nothing so
 * `Intl.DateTimeFormat` falls back to the locale default.
 *
 * Exported so call sites that build their own `Intl.DateTimeFormat` (chart
 * axes, list rows that deliberately render in the browser timezone rather
 * than the profile zone) can still honour the user's H12 / H24 preference by
 * spreading these options. Pair it with `useTimeFormatPreference()` on the
 * client. Any new hour/minute renderer must route through this rather than
 * re-deciding the cycle locally — that is the regression this single source
 * prevents (an `en`-locale or AUTO user got AM/PM even with H24 selected
 * wherever a formatter omitted the cycle).
 */
export function hourCycleOptions(
  timeFormat: TimeFormatPreference,
): Intl.DateTimeFormatOptions {
  switch (timeFormat) {
    case "H12":
      return { hour12: true };
    case "H24":
      return { hourCycle: "h23" };
    default:
      return {};
  }
}

/**
 * The Intl locale tag a non-AUTO date preference renders through. The
 * field order is a property of the BCP-47 locale, not a `DateTimeFormat`
 * option, so we pin a canonical locale whose default numeric date order
 * matches the requested preference and reuse the user's own locale only
 * for AUTO. DMY is rendered through de-DE so it carries the app-wide
 * dotted separator (dd.MM.yyyy); MDY through en-US (MM/dd/yyyy); YMD
 * through the ISO-canonical en-CA / sv (yyyy-MM-dd). The day/month/year
 * `2-digit`/`numeric` field set is supplied by the caller.
 */
function dateOrderLocale(
  dateFormat: DateFormatPreference,
  localeTag: string,
): string {
  switch (dateFormat) {
    case "DMY":
      return "de-DE";
    case "MDY":
      return "en-US";
    case "YMD":
      // en-CA renders numeric dates as yyyy-MM-dd across engines; it is the
      // ISO-8601 default order without pulling a locale the app doesn't ship.
      return "en-CA";
    default:
      return localeTag;
  }
}

type DateInput = Date | string | number;

function asDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * True when `date` falls in the same calendar year as "now", both read in
 * `tz`. Backs the `*Smart` conditional-year formatters below — a date is
 * compared in the SAME timezone the formatter renders it in (rather than
 * the runtime's local timezone) so a UTC-pinned bucket-label formatter
 * (`makeBucketLabelFormatters`, chart axes) and a profile-timezone
 * formatter agree with what they actually print. `getDateTimeFormat` is
 * the same process-wide cache the rest of this module uses, so the extra
 * lookup is cheap.
 */
function isCurrentYearInTz(date: Date, tz: string, localeTag: string): boolean {
  const yearIn = (value: Date) =>
    getDateTimeFormat(localeTag, { timeZone: tz, year: "numeric" }).format(
      value,
    );
  const target = yearIn(date);
  const now = yearIn(new Date());
  return target === now;
}

export interface Formatters {
  /** Integer or decimal with the active locale's decimal separator. */
  number: (value: number, fractionDigits?: number) => string;
  /** Same as `number` but thousands-grouped. */
  integer: (value: number) => string;
  /** Percentage, e.g. 0.835 → "83,5 %" in DE / "83.5%" in EN. */
  percent: (value: number, fractionDigits?: number) => string;
  /** Short date, e.g. "19.02.2026" / "02/19/2026". */
  date: (value: DateInput) => string;
  /** Short date without year, e.g. "19.02." / "Feb 19". */
  dateShort: (value: DateInput) => string;
  /**
   * Short date that adds the year whenever `value` falls outside the
   * current calendar year, e.g. "19.02." this year vs. "19.02.2025" for
   * a date from last year. Use this instead of `dateShort` on any
   * surface that can render a date older than the current year (chart
   * axes/tooltips, history lists, timelines) — see the "generell
   * überall" year-disambiguation rule.
   */
  dateShortSmart: (value: DateInput) => string;
  /**
   * `dateShortSmart` for a STATED calendar date: a day key anchored at noon
   * UTC (`YYYY-MM-DDT12:00:00Z`), or the bare `YYYY-MM-DD` key itself. Read
   * in UTC so the date never moves: the zone-aware `dateShortSmart` shows a
   * noon-UTC anchor as the next day in UTC+12..+14 (and an evening anchor as
   * the previous day west of UTC-12). The year rule is the same: the year is
   * added when the date falls outside the reader's current year.
   */
  dateShortSmartCalendar: (value: DateInput) => string;
  /**
   * Two `dateShortSmart` dates as one range, joined the way the locale joins
   * a range (`Intl.DateTimeFormat#formatRange`), never by a dash of our own:
   * "19.–25.02." in German, "2/19 ~ 2/25" in Korean. The year is added to
   * both ends when either falls outside the current year.
   */
  dateRangeShortSmart: (from: DateInput, to: DateInput) => string;
  /** `dateRangeShortSmart` for two STATED calendar dates, read as `dateShortSmartCalendar` reads them. */
  dateRangeShortSmartCalendar: (from: DateInput, to: DateInput) => string;
  /** Full date + time; hour cycle follows the `timeFormat` preference. */
  dateTime: (value: DateInput) => string;
  /** Time only, e.g. "14:30" or "2:30 PM" per the `timeFormat` preference. */
  time: (value: DateInput) => string;
  /**
   * A stored wall-clock time ("08:00", the `HH:mm` of a schedule, a dose
   * window or a slot) in the same hour cycle as `time`, so a schedule time
   * and an instant never sit side by side as "08:00" and "08:30 AM". A value
   * that is not `HH:mm` comes back unchanged.
   */
  wallTime: (hhmm: string) => string;
  /** Short weekday + date, e.g. "Do., 19.02." / "Thu, Feb 19". */
  dateWithWeekday: (value: DateInput) => string;
  /**
   * Short weekday + date that adds the year whenever `value` falls
   * outside the current calendar year, e.g. "Do., 19.02." this year vs.
   * "Do., 19.02.2025" for a date from last year.
   */
  dateWithWeekdaySmart: (value: DateInput) => string;
  /** For axis labels: 3-letter month abbreviation. */
  monthShort: (value: DateInput) => string;
  /**
   * A month with its two-digit year, for a column per month that can cross a
   * year boundary ("Aug 26", "Aug. 26"). Never "26/08", which reads as a day.
   */
  monthYearShort: (value: DateInput) => string;
}

/**
 * A decimal in the reader's notation for text built outside React (a server
 * sentence, a deterministic fallback): at most `maxFractionDigits` digits,
 * trailing zeros dropped, no grouping. `toFixed` prints a full stop in every
 * language; this prints "0,8" in German and "0.8" in English.
 */
export function formatDecimal(
  value: number,
  locale: Locale,
  maxFractionDigits: number,
): string {
  return getNumberFormat(resolveIntlLocale(locale), {
    maximumFractionDigits: maxFractionDigits,
    useGrouping: false,
  }).format(value);
}

/**
 * Two short dates as one range in the locale's own range form
 * (`formatRange`), rendered in `renderTz`. The year is added when either end
 * falls outside the reader's current year, read in `readerTz`.
 */
function shortDateRange(
  localeTag: string,
  renderTz: string,
  readerTz: string,
  from: Date,
  to: Date,
): string {
  const yearIn = (d: Date, zone: string) =>
    getDateTimeFormat(localeTag, { timeZone: zone, year: "numeric" }).format(d);
  const current = yearIn(new Date(), readerTz);
  const thisYear =
    yearIn(from, renderTz) === current && yearIn(to, renderTz) === current;
  return getDateTimeFormat(localeTag, {
    timeZone: renderTz,
    day: "2-digit",
    month: "2-digit",
    ...(thisYear ? {} : { year: "numeric" as const }),
  }).formatRange(from, to);
}

/** A stated calendar day (`YYYY-MM-DD` or a noon-UTC anchor) as a Date. */
function calendarDay(value: DateInput): Date {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00.000Z`)
    : asDate(value);
}

/**
 * Build the locale-aware formatter set.
 *
 * Every parameter is REQUIRED, deliberately. `timeFormat` and `dateFormat`
 * used to default to "AUTO", and a preference parameter with a default is
 * how "the setting works in one place" ships: issue #922 — a reporter moved
 * the profile off MM/DD/YYYY, the entry form followed, and the chart axes
 * and the measurements list did not, because every construction except
 * `useFormatters()` silently took the default. A caller with nothing to
 * pass writes "AUTO" and thereby says so. Same for `userTz`: pass the
 * resolved profile zone, or an explicit `undefined` to accept the
 * `DEFAULT_TIMEZONE` fallback.
 */
export function makeFormatters(
  locale: Locale,
  userTz: string | undefined,
  timeFormat: TimeFormatPreference,
  dateFormat: DateFormatPreference,
): Formatters {
  const intlLocale = resolveIntlLocale(locale);
  // Poison guard: an invalid IANA name would make `Intl.DateTimeFormat`
  // throw `RangeError` inside every date/time call — i.e. white-screen
  // every page that renders a timestamp. Validate here (cheap — the
  // probe memoises successful constructions) and fall back to Berlin,
  // matching `formatInUserTz` / `hourInTz` / `isNearUtc`.
  const tz = userTz && isValidTimezone(userTz) ? userTz : DEFAULT_TIMEZONE;
  const hourOpts = hourCycleOptions(timeFormat);
  // Field-order locale for the numeric date renderers. AUTO keeps the
  // user's own locale; DMY/MDY/YMD pin a canonical locale whose default
  // numeric order matches. `monthShort` deliberately stays on `intlLocale`
  // so axis month names follow the UI language, not the date-order pin.
  const dateLocale = dateOrderLocale(dateFormat, intlLocale);

  // v1.28.42 — the returned closures used to construct a fresh
  // `Intl.NumberFormat` / `Intl.DateTimeFormat` on every call. `makeFormatters`
  // is memoised per (locale, tz, timeFormat, dateFormat) on the client, but a
  // dense history list still calls these closures thousands of times per
  // render, rebuilding an identical formatter each time (V8's toLocale cache
  // busts on any options object) → main-thread stalls. Route through the
  // process-wide formatter cache so each distinct (locale, options) shape is
  // constructed once. `getDateTimeFormat(...).format(date)` is behaviourally
  // identical to `Date.prototype.toLocale*String(locale, options)` — the latter
  // builds the same `Intl.DateTimeFormat` internally — so rendered output is
  // unchanged. The options carry `timeZone` + the hour-cycle/date-field shape,
  // so the cache key already distinguishes every variant.
  return {
    number: (value, fractionDigits) =>
      getNumberFormat(intlLocale, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(value),

    integer: (value) =>
      getNumberFormat(intlLocale, { maximumFractionDigits: 0 }).format(value),

    percent: (value, fractionDigits = 0) =>
      getNumberFormat(intlLocale, {
        style: "percent",
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(value),

    date: (value) =>
      getDateTimeFormat(dateLocale, {
        timeZone: tz,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(asDate(value)),

    dateShort: (value) =>
      getDateTimeFormat(dateLocale, {
        timeZone: tz,
        day: "2-digit",
        month: "2-digit",
      }).format(asDate(value)),

    dateShortSmart: (value) => {
      const d = asDate(value);
      return getDateTimeFormat(dateLocale, {
        timeZone: tz,
        day: "2-digit",
        month: "2-digit",
        ...(isCurrentYearInTz(d, tz, dateLocale)
          ? {}
          : { year: "numeric" as const }),
      }).format(d);
    },

    dateShortSmartCalendar: (value) => {
      const d =
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? new Date(`${value}T12:00:00.000Z`)
          : asDate(value);
      const year = getDateTimeFormat(dateLocale, {
        timeZone: "UTC",
        year: "numeric",
      }).format(d);
      const currentYear = getDateTimeFormat(dateLocale, {
        timeZone: tz,
        year: "numeric",
      }).format(new Date());
      return getDateTimeFormat(dateLocale, {
        timeZone: "UTC",
        day: "2-digit",
        month: "2-digit",
        ...(year === currentYear ? {} : { year: "numeric" as const }),
      }).format(d);
    },

    dateRangeShortSmart: (from, to) =>
      shortDateRange(dateLocale, tz, tz, asDate(from), asDate(to)),

    dateRangeShortSmartCalendar: (from, to) =>
      shortDateRange(dateLocale, "UTC", tz, calendarDay(from), calendarDay(to)),

    dateTime: (value) =>
      getDateTimeFormat(dateLocale, {
        timeZone: tz,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        ...hourOpts,
      }).format(asDate(value)),

    time: (value) =>
      getDateTimeFormat(intlLocale, {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        ...hourOpts,
      }).format(asDate(value)),

    wallTime: (hhmm) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
      if (!m) return hhmm;
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      if (hour > 23 || minute > 59) return hhmm;
      // A fixed UTC day: only the wall-clock parts are read.
      return getDateTimeFormat(intlLocale, {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        ...hourOpts,
      }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
    },

    dateWithWeekday: (value) =>
      getDateTimeFormat(dateLocale, {
        timeZone: tz,
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
      }).format(asDate(value)),

    dateWithWeekdaySmart: (value) => {
      const d = asDate(value);
      return getDateTimeFormat(dateLocale, {
        timeZone: tz,
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        ...(isCurrentYearInTz(d, tz, dateLocale)
          ? {}
          : { year: "numeric" as const }),
      }).format(d);
    },

    monthShort: (value) =>
      getDateTimeFormat(intlLocale, {
        timeZone: tz,
        month: "short",
      }).format(asDate(value)),

    monthYearShort: (value) =>
      getDateTimeFormat(intlLocale, {
        timeZone: tz,
        month: "short",
        year: "2-digit",
      }).format(asDate(value)),
  };
}

/**
 * Parse locale from a `Accept-Language` header or `healthlog-locale` cookie.
 * Server-side helper for jobs, API routes, and PDF generation where there is
 * no React context.
 */
export function parseLocaleFromAcceptLanguage(header: string | null): Locale {
  if (!header) return "en";
  const first = header.split(",")[0]?.split(";")[0];
  return localeFromLanguageTag(first) ?? "en";
}
