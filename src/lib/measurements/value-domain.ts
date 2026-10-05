/**
 * Per-metric numeric-domain facts — the ONE home for the two questions the
 * derivation and render layers kept answering independently, and therefore
 * kept answering differently:
 *
 *   1. **Can this metric be negative?** The chart's y-axis already refused a
 *      negative lower bound (`chart-y-domain.ts`) while the personal-baseline
 *      band underneath the same chart happily printed one, so a step page
 *      could read "your usual range is −5,595.6–13,387.6 steps". Same app,
 *      same question, two answers. The fact is a property of the METRIC, not
 *      of the surface that renders it, so it belongs beside the metric — and
 *      it is already declared there: `VALUE_RANGES` in
 *      `@/lib/validations/measurement` is the app-wide plausibility domain
 *      every ingest path validates against, and its `min` IS the metric's
 *      floor. Nothing new to maintain; this module only reads it. Two types
 *      declare a genuinely signed floor (`ANS_CHARGE`,
 *      `BODY_TEMPERATURE_DEVIATION`) and are correctly excluded.
 *
 *   2. **Is this metric integer-valued?** A step count has no fractional
 *      part, so "104.0 steps" is not a rounding preference, it is wrong. This
 *      one had no home at all — every sub-page passed (or forgot) its own
 *      `fractionDigits` prop, and the pages that forgot rendered a fraction
 *      of a step. The set below is the metrics whose values are discrete by
 *      construction: tallies of events, category flags pinned to 1, closed
 *      integer instrument scores, and integer ordinal levels.
 *
 * Deliberately NOT in the integer set: rates and continuous quantities that
 * merely tend to be logged as whole numbers (bpm, mmHg, kcal, minutes,
 * metres). A mean of 68.4 bpm is a real quantity; a mean of 104.3 steps is a
 * real quantity too, but a step is indivisible, so the metric is read as a
 * count and rendered as one.
 */
import { VALUE_RANGES } from "@/lib/validations/measurement";

/**
 * Decimal places used for a metric with no discreteness constraint — the
 * long-standing default of the stat strip and the coach-read strip.
 */
export const DEFAULT_METRIC_FRACTION_DIGITS = 1;

/**
 * Metrics whose stored values are whole numbers by construction. Keys are
 * `MeasurementType` values; typed as strings so client components can ask
 * without importing the Prisma client into the browser bundle.
 */
export const INTEGER_VALUED_MEASUREMENT_TYPES: ReadonlySet<string> = new Set([
  // Tallies — a fraction of one of these does not exist.
  "ACTIVITY_STEPS",
  "FLIGHTS_CLIMBED",
  "FALL_COUNT",
  "BREATHING_DISTURBANCES",
  "SLEEP_DISTURBANCE_COUNT",
  // Category events — the row carries a fixed `value = 1` (one fired event).
  "AUDIO_EXPOSURE_EVENT",
  "BREATHING_DISTURBANCE_EVENT",
  "HIGH_HEART_RATE_EVENT",
  "IRREGULAR_RHYTHM_NOTIFICATION",
  "LOW_HEART_RATE_EVENT",
  "WALKING_STEADINESS_EVENT",
  // Closed integer instrument scores — the questionnaire sums whole items.
  "PAIN_NRS",
  "PHQ9_SCORE",
  "GAD7_SCORE",
  "WHO5_SCORE",
  "SCI_SCORE",
  // Integer ordinal / rating scales.
  "RESILIENCE",
  "VISCERAL_FAT",
  // Whole years, as the device reports it.
  "VASCULAR_AGE",
]);

/**
 * True when the metric's own plausibility floor forbids a negative value.
 * Unknown types answer `false` — an absent range is an absent fact, never a
 * guessed one.
 */
export function isNonNegativeMetric(type: string | null | undefined): boolean {
  if (!type) return false;
  const range = VALUE_RANGES[type];
  return range !== undefined && range.min >= 0;
}

/**
 * True when the value sits inside the metric's declared plausibility domain —
 * the same `VALUE_RANGES` band every interactive, import, MCP and Telegram
 * write path validates against before storing a reading.
 *
 * The derivation layer needs the question answered too, and for the opposite
 * direction. A stored value outside the domain is one the application has
 * already declared impossible, so it is not a reading: it is a provider glitch,
 * a unit-decode slip, or a row from a writer that never had the gate. Folding
 * it into a mean or a median makes the statistic say something the data never
 * did — a personal pulse band in the tens of thousands, and a "your pulse is
 * above your usual range" line built on a number no heart has ever produced.
 * A statistic that quietly digests an impossible input is worse than one that
 * declines to, because it looks like an answer.
 *
 * Unknown types and non-finite values answer `false`-safe in opposite ways on
 * purpose: an absent range is an absent fact, so the value passes; a NaN is
 * never an input to anything.
 */
export function isPlausibleMetricValue(
  type: string | null | undefined,
  value: number,
): boolean {
  if (!Number.isFinite(value)) return false;
  const range = plausibleMetricRange(type);
  if (range === undefined) return true;
  return value >= range.min && value <= range.max;
}

/**
 * The plausibility domain of a metric, for a reader that filters in SQL
 * rather than row by row (`readDayAggregates`' `valueRange`). `undefined`
 * when the metric declares none, which admits every value.
 */
export function plausibleMetricRange(
  type: string | null | undefined,
): { min: number; max: number } | undefined {
  return type ? VALUE_RANGES[type] : undefined;
}

/**
 * True when EVERY named metric forbids negative values (and at least one was
 * named). Used by the chart, which can paint several series in one axis: a
 * single signed series keeps the full downward padding for all of them.
 */
export function areAllNonNegativeMetrics(
  types: readonly (string | null | undefined)[],
): boolean {
  return types.length > 0 && types.every((type) => isNonNegativeMetric(type));
}

/**
 * Clamp a DERIVED lower edge (a baseline band edge, a padded axis bound) to
 * the metric's zero floor. Derived edges are arithmetic — median − k·MAD, a
 * padded minimum — and arithmetic does not know that a step cannot be owed.
 */
export function clampDerivedLowerBound(
  type: string | null | undefined,
  lower: number,
): number {
  return isNonNegativeMetric(type) ? Math.max(0, lower) : lower;
}

/**
 * Decimal places a metric's values are read at. Zero for a discrete metric,
 * the shared default otherwise. Surfaces call this instead of hard-coding a
 * default, so a page that says nothing still renders the metric correctly.
 */
export function metricFractionDigits(type: string | null | undefined): number {
  if (type && INTEGER_VALUED_MEASUREMENT_TYPES.has(type)) return 0;
  return DEFAULT_METRIC_FRACTION_DIGITS;
}

/**
 * The smallest half-width a personal band may have, in the metric's canonical
 * unit: roughly the day-to-day wobble of the measurement itself.
 *
 * A median ± k·MAD band has no width at all when most days carry the same
 * value (a device that reports a whole-number resting rate does this often),
 * and then reads "your usual range is 61–61 bpm" while a reading of 62 counts
 * as outside it. Below this width a band says nothing a single reading could
 * not, so the band is widened to it. Metrics not listed take one step of
 * their own display precision, which is the least that keeps the two edges
 * apart on screen.
 */
const MIN_BAND_HALF_WIDTH: Readonly<Record<string, number>> = {
  RESTING_HEART_RATE: 2, // bpm
  PULSE: 3, // bpm
  HEART_RATE_VARIABILITY: 3, // ms
  RESPIRATORY_RATE: 0.5, // breaths/min
  OXYGEN_SATURATION: 1, // %
  BODY_TEMPERATURE: 0.2, // °C
  SKIN_TEMPERATURE: 0.2, // °C
  WRIST_TEMPERATURE: 0.2, // °C
  BLOOD_PRESSURE_SYS: 4, // mmHg
  BLOOD_PRESSURE_DIA: 3, // mmHg
  BLOOD_GLUCOSE: 5, // mg/dL
  WEIGHT: 0.3, // kg
};

export function minimumBandHalfWidth(type: string | null | undefined): number {
  if (!type) return 0;
  return MIN_BAND_HALF_WIDTH[type] ?? 10 ** -metricFractionDigits(type);
}
