import { getNumberFormat, getDateTimeFormat } from "@/lib/intl/formatter-cache";
import {
  applyDisplayTransform,
  getQuantityTransform,
  paceSecondsPerDistanceUnit,
  type UnitPreference,
} from "@/lib/measurements/display-transform";
import {
  hourCycleOptions,
  type TimeFormatPreference,
} from "@/lib/format-locale";

/**
 * Shared formatters for the workout-detail surface. Pure helpers pulled
 * out of the former single `workout-detail.tsx` when it was split into a
 * `workout-detail/` directory (#67), so header / stats / splits format
 * durations and distances identically.
 */

/**
 * A workout's length as a clock reading with its unit, the way a sports
 * watch shows it: "38:00 Min." / "1:02:05 Std." in German, "38:00 min" /
 * "1:02:05 h" in English. The old "38m 00s" was English in every locale.
 */
export function formatDuration(
  seconds: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, "0");
  return h > 0
    ? t("common.durationClockHours", {
        time: `${h}:${m.toString().padStart(2, "0")}:${ss}`,
      })
    : t("common.durationClockMinutes", { time: `${m}:${ss}` });
}

/** Compact "34 min" style duration for the sport-average comparison line. */
export function formatDurationMinutes(seconds: number, locale: string): string {
  const minutes = Math.round(seconds / 60);
  return formatNumber(minutes, locale);
}

/**
 * A workout distance in the reader's unit, with its symbol: "5.80 km" or
 * "3.60 mi". The workout list, the detail header, the stat tile and the
 * sport-average line all print through this, so none of them can keep
 * kilometres for an imperial reader.
 */
export function formatDistance(
  meters: number,
  locale: string,
  preference: UnitPreference,
): string {
  const transform = getQuantityTransform("distance", preference);
  const value = applyDisplayTransform(meters, transform);
  const formatted = getNumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: value < 10 ? 2 : 1,
  }).format(value);
  return `${formatted} ${transform.displayUnit}`;
}

/** Elevation gain in the reader's unit with its symbol: "123.4 m" / "404.9 ft". */
export function formatElevation(
  meters: number,
  locale: string,
  preference: UnitPreference,
): string {
  const transform = getQuantityTransform("elevation", preference);
  return `${formatNumber(
    applyDisplayTransform(meters, transform),
    locale,
    transform.decimals,
  )} ${transform.displayUnit}`;
}

export function formatNumber(
  value: number,
  locale: string,
  fractionDigits = 0,
): string {
  return getNumberFormat(locale, {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * Average pace per kilometre or per mile, by the reader's preference. Only
 * meaningful for run / walk / hike / ride; the caller gates on distance +
 * sport.
 */
export function formatPace(
  durationSec: number,
  meters: number,
  preference: UnitPreference,
): string {
  return formatPaceSeconds(
    paceSecondsPerDistanceUnit(durationSec, meters, preference),
    getQuantityTransform("distance", preference).displayUnit,
  );
}

/**
 * "m:ss min/km" from a seconds-per-unit value. The splits table passes "km"
 * explicitly: its rows are kilometre segments cut server-side, so their
 * pace is per kilometre whatever the preference.
 */
export function formatPaceSeconds(secPerUnit: number, unit: string): string {
  let m = Math.floor(secPerUnit / 60);
  let s = Math.round(secPerUnit % 60);
  // 359.6 s is 6:00, not 5:60.
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return `${m}:${s.toString().padStart(2, "0")} min/${unit}`;
}

export function formatDateRange(
  startedAt: string,
  endedAt: string,
  locale: string,
  timeFormat: TimeFormatPreference,
): string {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  const dateFmt = getDateTimeFormat(locale, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const timeFmt = getDateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...hourCycleOptions(timeFormat),
  });
  return `${dateFmt.format(start)}, ${timeFmt.format(start)}–${timeFmt.format(end)}`;
}
