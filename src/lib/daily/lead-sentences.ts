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

/**
 * Last night against the person's usual, read one way by every sentence and
 * line that compares the two (the morning's night card, the Today facts and
 * the lead): `plain` without a usual to compare with,
 * `usual` within {@link SLEEP_CLOSE_DIFF_MINUTES}, else `more` or `less` by
 * whole minutes.
 */
export type SleepVersusUsual =
  | { kind: "plain" }
  | { kind: "usual" }
  | { kind: "more" | "less"; diffMinutes: number };

export function sleepVersusUsual(sleep: TodaySleep): SleepVersusUsual {
  const diff = sleepDiff(sleep);
  if (diff === null) return { kind: "plain" };
  if (Math.abs(diff) <= SLEEP_CLOSE_DIFF_MINUTES) return { kind: "usual" };
  return { kind: diff > 0 ? "more" : "less", diffMinutes: Math.abs(diff) };
}

/**
 * The night as one short line: the duration, and how far it sits from the
 * usual when it is not close to it ("7 h 20 min, 35 min less than usual").
 */
export function sleepFactLine(sleep: TodaySleep, t: Translate): string {
  const params = { duration: duration(sleep.minutes, t) };
  const versus = sleepVersusUsual(sleep);
  if (versus.kind === "plain" || versus.kind === "usual") {
    return t(`daily.todayFact.sleep.${versus.kind}`, params);
  }
  return t(`daily.todayFact.sleep.${versus.kind}`, {
    ...params,
    diff: duration(versus.diffMinutes, t),
  });
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
 * The sentence for a night that is in and not notable, or null. Within the
 * close margin it is "close to your usual"; between that and an hour it says
 * the difference, so a night 40 minutes short is never called usual.
 */
export function ordinaryNightSentence(
  sleep: TodaySleep | null,
  t: Translate,
): string | null {
  if (!sleep) return null;
  const params = { duration: duration(sleep.minutes, t) };
  const versus = sleepVersusUsual(sleep);
  if (versus.kind === "plain" || versus.kind === "usual") {
    return t(`daily.lead.sleep.${versus.kind}`, params);
  }
  return t(`daily.lead.sleep.${versus.kind}`, {
    ...params,
    diff: duration(versus.diffMinutes, t),
  });
}
