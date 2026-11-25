/**
 * The deterministic sentences about the day's vitals and last night, shared
 * by the Today hero's lead (`today-overview.ts`) and the morning sentence
 * (`morning.ts`), so both say a fact the same way. Pure; every word comes from
 * the bundle.
 */
import type { Locale } from "@/lib/i18n/config";
import { pluralKey } from "@/lib/i18n/plural";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { translateOrNull } from "@/lib/i18n/translate-code";
import type { TodaySleep, TodayVital } from "@/lib/daily/today-overview";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * How far last night may sit from the person's usual before the night itself
 * becomes the day's strongest signal. An hour is a difference anyone notices
 * the next day; less than that is ordinary variation and stays a fact.
 */
export const SLEEP_NOTABLE_DIFF_MINUTES = 60;

/** Within this many minutes of the usual, the night reads as "close to". */
export const SLEEP_CLOSE_DIFF_MINUTES = 20;

/** How far outside its band a vital sits, in band widths. */
function outsideBy(v: TodayVital): number {
  const width = Math.max(v.high - v.low, Number.EPSILON);
  if (v.direction === "above") return (v.value - v.high) / width;
  if (v.direction === "below") return (v.low - v.value) / width;
  return 0;
}

/** Today's vitals outside their range, the furthest out first. */
export function outsideVitals(vitals: readonly TodayVital[]): TodayVital[] {
  return vitals
    .filter((v) => v.direction !== "in")
    .sort((a, b) => outsideBy(b) - outsideBy(a));
}

export function vitalLabel(t: Translate, type: string): string {
  const key = `daily.today.vital.${type}`;
  return translateOrNull(t, key) ?? t("daily.today.vital.generic");
}

export function sleepDiff(sleep: TodaySleep): number | null {
  if (sleep.usualMinutes === null) return null;
  return Math.round(sleep.minutes - sleep.usualMinutes);
}

export function duration(minutes: number, t: Translate): string {
  return formatDurationMinutes(Math.round(minutes), t);
}

/**
 * The sentence for vitals outside their range: the furthest out by name,
 * with its compared value and range, and how many more are outside. Expects
 * `outside` from {@link outsideVitals}, non-empty.
 */
export function vitalsOutsideSentence(
  outside: readonly TodayVital[],
  locale: Locale,
  t: Translate,
): string {
  const v = outside[0];
  const params = {
    metric: vitalLabel(t, v.type),
    value: v.valueLabel,
    range: v.rangeLabel,
  };
  return outside.length === 1
    ? t(`daily.lead.vitalOutside.${v.direction}`, params)
    : t(
        pluralKey(
          `daily.lead.vitalsOutside.${v.direction}`,
          outside.length - 1,
          locale,
        ),
        { ...params, count: outside.length - 1 },
      );
}

/** The sentence for a night at least an hour off the usual, or null. */
export function notableNightSentence(
  sleep: TodaySleep | null,
  t: Translate,
): string | null {
  const diff = sleep ? sleepDiff(sleep) : null;
  if (!sleep || diff === null || Math.abs(diff) < SLEEP_NOTABLE_DIFF_MINUTES) {
    return null;
  }
  return t(`daily.lead.sleep.${diff > 0 ? "more" : "less"}`, {
    duration: duration(sleep.minutes, t),
    diff: duration(Math.abs(diff), t),
  });
}

/**
 * The counting sentence for today's vitals, all inside their range: the
 * number of them, or the one by name. Null when there is none.
 */
export function vitalsInRangeSentence(
  vitals: readonly TodayVital[],
  locale: Locale,
  t: Translate,
): string | null {
  if (vitals.length >= 2) {
    return t(pluralKey("daily.lead.vitalsInRange", vitals.length, locale), {
      count: vitals.length,
    });
  }
  if (vitals.length === 1) {
    const v = vitals[0];
    return t("daily.lead.vitalInRange", {
      metric: vitalLabel(t, v.type),
      value: v.valueLabel,
      range: v.rangeLabel,
    });
  }
  return null;
}

/** The sentence for an ordinary night that is in, or null. */
export function ordinaryNightSentence(
  sleep: TodaySleep | null,
  t: Translate,
): string | null {
  if (!sleep) return null;
  return sleepDiff(sleep) !== null
    ? t("daily.lead.sleep.usual", { duration: duration(sleep.minutes, t) })
    : t("daily.lead.sleep.plain", { duration: duration(sleep.minutes, t) });
}
