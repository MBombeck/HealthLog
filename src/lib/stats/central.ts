/**
 * Mean, median and rounding: the one copy of each.
 *
 * An empty input has no centre, so both answer `null`. Absence is not zero,
 * and a NaN leaks into arithmetic without a trace; a caller that wants a
 * number for "nothing" writes that decision at its call site, where a reader
 * can see it.
 */

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** The middle value, or the mean of the two middle values. Does not mutate. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Median absolute deviation about the median (raw, unscaled); null when empty. */
export function medianAbsoluteDeviation(
  values: readonly number[],
): number | null {
  const center = median(values);
  if (center === null) return null;
  return median(values.map((v) => Math.abs(v - center)));
}

/** `value` rounded to `digits` decimals with `Math.round` (halves round up). */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
