/**
 * Variance and standard deviation, with the kind named at every call site.
 *
 * - `population` divides by n: the spread of exactly these readings. It is
 *   what a surface reports when it describes a series the person can see.
 * - `sample` divides by n − 1: an estimate of the spread that readings like
 *   these come from. It belongs where the spread feeds a decision (a
 *   significance verdict, a changepoint threshold) or where a clinical
 *   definition asks for it.
 *
 * The two differ by sqrt(n / (n − 1)), about 22 % at n = 3, so one series
 * shown with both rules looks like two different series. Every hand-rolled
 * spread used to pick its rule silently; the API reported the population SD
 * of a blood-pressure series while the MCP and AI payload reported the
 * sample SD of the same readings.
 */

export type VarianceKind = "population" | "sample";

/**
 * The kind every surface uses to report the spread of a person's readings,
 * so the API, the MCP tools, the Coach and the AI payload say the same
 * number for the same series.
 */
export const READING_SPREAD: VarianceKind = "population";

/** `null` when the kind is undefined for this many values (n < 1, or n < 2 for a sample). */
export function variance(
  values: readonly number[],
  kind: VarianceKind,
): number | null {
  const n = values.length;
  const divisor = kind === "sample" ? n - 1 : n;
  if (divisor < 1) return null;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let squares = 0;
  for (const v of values) squares += (v - mean) ** 2;
  return squares / divisor;
}

export function standardDeviation(
  values: readonly number[],
  kind: VarianceKind,
): number | null {
  const v = variance(values, kind);
  return v === null ? null : Math.sqrt(v);
}

/**
 * `variance` over readings given as distinct values and how often each
 * occurs, for a reader that folds the readings before it sees them.
 */
export function varianceOfCounts(
  entries: ReadonlyArray<readonly [value: number, count: number]>,
  kind: VarianceKind,
): number | null {
  let n = 0;
  let sum = 0;
  for (const [v, c] of entries) {
    n += c;
    sum += v * c;
  }
  const divisor = kind === "sample" ? n - 1 : n;
  if (divisor < 1) return null;
  const mean = sum / n;
  let squares = 0;
  for (const [v, c] of entries) squares += c * (v - mean) ** 2;
  return squares / divisor;
}
