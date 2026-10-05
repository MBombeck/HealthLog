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
import type { DailyBriefing } from "@/lib/ai/schema";
import type { Locale } from "@/lib/i18n/config";
import { resolveIntlLocale } from "@/lib/format-locale";
import { vitalDisplayDecimals } from "@/lib/measurements/vital-precision";
import { userDayKey } from "@/lib/tz/format";

/**
 * The measurement type a briefing signal is a reading of. Metrics absent
 * here (sleep, steps, mood, compliance, derived scores) are not a single
 * dated reading and keep their signal; the prompt input already decides
 * those.
 *
 * Keyed by string rather than by the briefing's `sourceMetric` enum: the
 * signals-of-the-day block does carry glucose, and the published enum
 * (which the iOS client decodes) does not yet. A glucose signal is covered
 * here the day the enum gains it, without a contract change today.
 */
export const SIGNAL_READING_TYPE: Readonly<Record<string, string>> = {
  bp: "BLOOD_PRESSURE_SYS",
  weight: "WEIGHT",
  pulse: "PULSE",
  resting_hr: "RESTING_HEART_RATE",
  hrv: "HEART_RATE_VARIABILITY",
  body_temp: "BODY_TEMPERATURE",
  glucose: "BLOOD_GLUCOSE",
};

/** The locale's decimal and grouping separators ("," and "." for de). */
function separators(locale: Locale): { decimal: string; group: string } {
  const parts = new Intl.NumberFormat(resolveIntlLocale(locale)).formatToParts(
    12345.5,
  );
  return {
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
    group: parts.find((p) => p.type === "group")?.value ?? ",",
  };
}

/** Separators a figure may carry: point, comma, and the two thin spaces. */
const SEP = "[.,\\u00a0\\u202f]";

/**
 * A figure with at least one separator in it. Plain integers ("+6 mmHg",
 * "30-day") are never rewritten, so the window words stay as written.
 */
const FIGURE = new RegExp(
  `(?<![\\p{L}\\d])([+\\-−±]?)(\\d+(?:${SEP}\\d+)+)(?![\\d])`,
  "gu",
);

/**
 * Read one written figure: which separator is the decimal one, and whether
 * the rest are thousands groups. Null when the grouping is not well formed,
 * in which case the figure is left as written.
 *
 * Both a point and a comma: the later one is the decimal. One kind only:
 * repeated, or a thin space, it is grouping; once, it is grouping only when
 * it is the locale's grouping mark followed by exactly three digits ("1.234"
 * in German, "1,234" in English), otherwise a decimal, whichever convention
 * the model wrote in ("33.72" inside German text is still 33.72).
 */
function readFigure(
  raw: string,
  locale: Locale,
): { value: number; fractionDigits: number; native: boolean } | null {
  const { decimal: localeDecimal, group: localeGroup } = separators(locale);
  const marks = [...raw.matchAll(/[.,\u00a0\u202f]/g)].map((m) => m[0]);
  const points = marks.filter((m) => m === "." || m === ",");
  const spaced = points.length < marks.length;
  let decimal: string | null = null;
  if (new Set(points).size === 2) {
    decimal = raw.lastIndexOf(".") > raw.lastIndexOf(",") ? "." : ",";
  } else if (points.length === 1) {
    // Beside thin-space grouping ("1 234,5") the one mark is the decimal.
    const mark = points[0];
    const after = raw.slice(raw.indexOf(mark) + 1);
    const asGroup = !spaced && mark === localeGroup && after.length === 3;
    decimal = asGroup ? null : mark;
  }
  // Repeated marks of one kind, and thin spaces, are grouping.
  const [intPart, fracPart = ""] =
    decimal === null
      ? [raw]
      : [
          raw.slice(0, raw.lastIndexOf(decimal)),
          raw.slice(raw.lastIndexOf(decimal) + 1),
        ];
  const groups = intPart.split(/[.,\u00a0\u202f]/);
  if (groups.length > 1 && groups.slice(1).some((g) => g.length !== 3)) {
    return null;
  }
  const value = Number(`${groups.join("")}.${fracPart || "0"}`);
  if (!Number.isFinite(value)) return null;
  // Written the way the locale writes it: decimal mark and grouping both.
  const native =
    (decimal === null || decimal === localeDecimal) &&
    marks.every((m) => m === decimal || m === localeGroup);
  return { value, fractionDigits: fracPart.length, native };
}

/**
 * Re-read the figures in a signal's delta string at the metric's display
 * precision, in the reader's number format.
 *
 * Only figures with a decimal or grouping mark are touched; a plain integer
 * stays as written. A figure already at the metric's precision and written
 * the locale's way is left alone; anything else is re-rounded and re-written
 * with the locale's own marks ("+1,234.5 kg" in German reads "+1.234,5 kg").
 * A non-zero difference that rounds to nothing reads "±0" at the metric's
 * precision rather than an unsigned zero that looks like a measurement. A
 * metric with no reading type keeps its delta verbatim.
 */
export function formatSignalDelta(
  delta: string,
  sourceMetric: string,
  locale: Locale,
): string {
  const type = SIGNAL_READING_TYPE[sourceMetric];
  if (!type) return delta;
  // Every reading type reads at one precision in both unit systems (whole
  // bpm / mmHg / ms, one decimal of kg / lb / °C / °F), except glucose,
  // whose precision follows the unit the delta is written in.
  const decimals = vitalDisplayDecimals(
    type,
    type === "BLOOD_GLUCOSE" && /mmol/i.test(delta) ? 1 : 0,
  );
  const number = new Intl.NumberFormat(resolveIntlLocale(locale), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return delta.replace(FIGURE, (match, sign: string, raw: string) => {
    const figure = readFigure(raw, locale);
    if (!figure) return match;
    if (figure.native && figure.fractionDigits <= decimals) return match;
    const scale = 10 ** decimals;
    const rounded = Math.round(figure.value * scale) / scale;
    if (rounded === 0 && figure.value !== 0) return `±${number.format(0)}`;
    return `${sign}${number.format(rounded)}`;
  });
}

export interface BriefingForTodayContext {
  /**
   * When the briefing's content was generated (ISO, from the payload's
   * `briefingGeneratedAt`), or null when the payload predates the field.
   * Never the cache row's `insightsCachedAt`: that moves on every warm,
   * including the unchanged-hash refresh that keeps yesterday's text.
   */
  generatedAt: string | null;
  /** The newest reading of a measurement type (ISO), or null when none. */
  lastSeenAt: (type: string) => string | null;
  /** The reader's zone and today's day key in it. */
  timezone: string;
  todayLocalDate: string;
  /** The reader's language, already resolved; deltas are re-read in it. */
  language: Locale;
}

/**
 * The briefing as the Today surfaces may use it: null when its content was
 * generated on an earlier calendar day, or at an unknown time, otherwise with every reading-backed signal whose
 * metric was not measured today removed and every remaining delta re-read at
 * its metric's precision.
 */
export function briefingForToday(
  briefing: DailyBriefing | null,
  ctx: BriefingForTodayContext,
): DailyBriefing | null {
  if (!briefing) return null;
  if (
    ctx.generatedAt === null ||
    userDayKey(new Date(ctx.generatedAt), ctx.timezone) !== ctx.todayLocalDate
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
