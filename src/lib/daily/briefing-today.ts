/**
 * The cached briefing, reduced to what is still true about today.
 *
 * The briefing is model text written at one moment and served for up to a
 * day, and the content-hash gate may keep the same text across several. The
 * hero reads it as the day's lead, its top signal as "pulse is up today", and
 * the morning push repeats both. Two things made that wrong in practice:
 *
 *   - A briefing written on an earlier calendar day speaks about that day.
 *     Served after midnight it narrates yesterday's readings as today's.
 *   - A signal whose metric has no reading today is not a signal of the day,
 *     whatever the text says. The prompt input is filtered the same way
 *     (`computeSignalsOfDay`), so this only catches text cached before that,
 *     or a cache that outlived the reading it was written from.
 *
 * Both are decided here, on the server, so every client (the web hero, the
 * iOS app reading `topSignal`, the push line) gets the same answer. The
 * delta string is model text as well: its figures are re-read at the
 * metric's display precision, so a pulse difference reads "+34 bpm", never
 * "+33.72 bpm".
 */
import type { DailyBriefing, DailyBriefingSignal } from "@/lib/ai/schema";
import type { Locale } from "@/lib/i18n/config";
import { resolveIntlLocale } from "@/lib/format-locale";
import { vitalDisplayDecimals } from "@/lib/measurements/vital-precision";
import { userDayKey } from "@/lib/tz/format";

/**
 * The measurement type a briefing signal is a reading of. Metrics absent
 * here (sleep, steps, mood, compliance, derived scores) are not a single
 * dated reading and keep their signal; the prompt input already decides
 * those.
 */
export const SIGNAL_READING_TYPE: Partial<
  Record<DailyBriefingSignal["sourceMetric"], string>
> = {
  bp: "BLOOD_PRESSURE_SYS",
  weight: "WEIGHT",
  pulse: "PULSE",
  resting_hr: "RESTING_HEART_RATE",
  hrv: "HEART_RATE_VARIABILITY",
  body_temp: "BODY_TEMPERATURE",
};

/** The locale's decimal separator ("," for de, "." for en). */
function decimalSeparator(locale: Locale): string {
  return (
    new Intl.NumberFormat(resolveIntlLocale(locale))
      .formatToParts(1.5)
      .find((part) => part.type === "decimal")?.value ?? "."
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Re-read the figures in a signal's delta string at the metric's display
 * precision.
 *
 * Only a number written with the locale's own decimal separator is touched,
 * and only when it carries more fraction digits than the metric is shown
 * with: "1.234" in German is a thousand, not a decimal, and is left alone.
 * A figure that rounds to zero loses its sign ("+0.3 bpm" reads "0 bpm").
 * A metric with no reading type keeps its delta verbatim.
 */
export function formatSignalDelta(
  delta: string,
  sourceMetric: DailyBriefingSignal["sourceMetric"],
  locale: Locale,
): string {
  const type = SIGNAL_READING_TYPE[sourceMetric];
  if (!type) return delta;
  // Every reading type above reads at the same precision in both unit
  // systems (whole bpm / mmHg / ms, one decimal of kg / lb / °C / °F).
  const decimals = vitalDisplayDecimals(type, 1);
  const sep = decimalSeparator(locale);
  const number = new Intl.NumberFormat(resolveIntlLocale(locale), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  });
  const pattern = new RegExp(
    `([+\\-−±]?)(\\d+)${escapeRegExp(sep)}(\\d+)(?![\\d])`,
    "g",
  );
  return delta.replace(pattern, (match, sign: string, int: string, frac) => {
    if ((frac as string).length <= decimals) return match;
    const value = Number(`${int}.${frac as string}`);
    const rounded = Math.round(value * 10 ** decimals) / 10 ** decimals;
    return `${rounded === 0 ? "" : sign}${number.format(rounded)}`;
  });
}

export interface BriefingForTodayContext {
  /** When the cached briefing was written (ISO), or null when unknown. */
  updatedAt: string | null;
  /** The newest reading of a measurement type (ISO), or null when none. */
  lastSeenAt: (type: string) => string | null;
  /** The reader's zone and today's day key in it. */
  timezone: string;
  todayLocalDate: string;
  /** The reader's language, already resolved; deltas are re-read in it. */
  language: Locale;
}

/**
 * The briefing as the Today surfaces may use it: null when it was written on
 * an earlier calendar day, otherwise with every reading-backed signal whose
 * metric was not measured today removed and every remaining delta re-read at
 * its metric's precision.
 */
export function briefingForToday(
  briefing: DailyBriefing | null,
  ctx: BriefingForTodayContext,
): DailyBriefing | null {
  if (!briefing) return null;
  if (
    ctx.updatedAt !== null &&
    userDayKey(new Date(ctx.updatedAt), ctx.timezone) !== ctx.todayLocalDate
  ) {
    return null;
  }
  if (!briefing.signalsOfDay) return briefing;
  const measuredToday = (type: string) => {
    const at = ctx.lastSeenAt(type);
    return (
      at !== null &&
      userDayKey(new Date(at), ctx.timezone) === ctx.todayLocalDate
    );
  };
  const signalsOfDay = briefing.signalsOfDay
    .filter((signal) => {
      const type = SIGNAL_READING_TYPE[signal.sourceMetric];
      return type === undefined || measuredToday(type);
    })
    .map((signal) =>
      signal.delta
        ? {
            ...signal,
            delta: formatSignalDelta(
              signal.delta,
              signal.sourceMetric,
              ctx.language,
            ),
          }
        : signal,
    );
  return { ...briefing, signalsOfDay };
}
