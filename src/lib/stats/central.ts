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

/**
 * `roundTo` for a figure summed from many readings that more than one code
 * path computes. Two summation orders of the same mean differ in the last
 * bits (a 7-day pulse mean of exactly 74.425 came back as 74.42499999999964
 * from one path and 74.42500000000861 from the other), and on an exact half
 * `Math.round` then serves two figures for the same data. The scaled value is
 * first cut to 11 significant digits, far above that noise and far below
 * anything a reading can tell apart, so both land on the half and round up.
 */
export function roundStableTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(Number((value * factor).toPrecision(11))) / factor;
}

/** A served figure to two decimals (`roundStableTo`); null for no value. */
export function roundStable2(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return roundStableTo(value, 2);
}

/**
 * Σ values with Neumaier's compensation: the rounding error of every addition
 * is carried and added back at the end, so the result is (all but always) the
 * correctly rounded sum whatever order the values arrive in. For a figure
 * served unrounded or to several decimals where the reading order is not
 * fixed, such as rows that share a timestamp.
 */
export function compensatedSum(values: Iterable<number>): number {
  let sum = 0;
  let carry = 0;
  for (const v of values) {
    const t = sum + v;
    carry += Math.abs(sum) >= Math.abs(v) ? sum - t + v : v - t + sum;
    sum = t;
  }
  return sum + carry;
}
