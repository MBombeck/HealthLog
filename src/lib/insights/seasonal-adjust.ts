/**
 * Seasonal and trend adjustment for the correlation engine.
 *
 * Two daily health series that both follow the calendar (blood pressure is
 * lower in summer, temperature is higher, sleep and HRV drift with daylight)
 * correlate strongly even when neither has anything to do with the other. A
 * raw Pearson over a year of such data reports the season, not a relation:
 * in a seeded simulation of two series that share only an annual cycle, the
 * raw lag-1 test rejected at p < 0.05 in 97 % of runs.
 *
 * The fix has two halves, and both are needed:
 *
 *  1. Remove the shared slow component from BOTH series before correlating.
 *     Each series is regressed on `[1, t, sin(2πd/365.25), cos(2πd/365.25)]`
 *     (one annual harmonic plus a linear trend) and the residuals are
 *     correlated. By Frisch–Waugh–Lovell this is the partial correlation with
 *     season and trend held fixed. Over a short span the annual wave is not
 *     identifiable and is practically a straight line, so below
 *     {@link SEASONAL_MIN_SPAN_DAYS} only `[1, t]` is removed.
 *  2. Count the information honestly. Daily residuals are still serially
 *     correlated (weather anomalies persist for days), so `n − 2` degrees of
 *     freedom overstate the evidence. The p-value uses the effective sample
 *     size of Pyper & Peterman (1998), which shrinks n by the product of the
 *     two residual series' autocorrelations. Without it the adjusted test
 *     still rejects 10–12 % of null pairs instead of 5 %.
 *
 * Pure: no imports, no clock, no I/O. Days are integer day indices (days since
 * 1970-01-01, see {@link dayKeyToIndex}), so a gap is simply an absent index;
 * the regression runs over the days that exist and nothing is imputed.
 */

/** Span (first to last paired day, inclusive) below which only the trend is removed. */
export const SEASONAL_MIN_SPAN_DAYS = 120;

/** Length of the annual cycle the harmonic models. */
export const ANNUAL_PERIOD_DAYS = 365.25;

/**
 * Rows required beyond the basis size to fit a series. Below `p + 10` points
 * a series is left unfitted and its pair is not tested at all, rather than
 * tested raw.
 */
export const FIT_MARGIN = 10;

/** Smallest effective sample size the p-value may assume. */
export const MIN_EFFECTIVE_N = 3;

/** Which nuisance basis a fit removed. */
export type SeasonalBasis = "harmonic" | "trend";

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` → whole days since 1970-01-01 (calendar arithmetic, no zone). */
export function dayKeyToIndex(day: string): number {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** The basis a span of `spanDays` calendar days gets. */
export function basisForSpan(spanDays: number): SeasonalBasis {
  return spanDays < SEASONAL_MIN_SPAN_DAYS ? "trend" : "harmonic";
}

/** Number of columns in a basis (intercept included). */
export function basisSize(basis: SeasonalBasis): number {
  return basis === "harmonic" ? 4 : 2;
}

/** Fewest rows a fit under `basis` accepts. */
export function minFitRows(basis: SeasonalBasis): number {
  return basisSize(basis) + FIT_MARGIN;
}

/**
 * Solve the small symmetric system `A·x = b` by Gauss–Jordan with partial
 * pivoting. Returns null when the system is singular (e.g. every day equal).
 */
function solve(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    }
    [M[c], M[p]] = [M[p], M[c]];
    const pivot = M[c][c];
    if (Math.abs(pivot) < 1e-10) return null;
    for (let j = c; j <= n; j++) M[c][j] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row[n]);
}

/**
 * Residuals of `values` after an ordinary least-squares fit of the chosen
 * basis over the given days. The trend column is centred and scaled to the
 * span so the normal equations stay well conditioned. Returns null when there
 * are fewer than {@link minFitRows} rows or the fit is singular.
 */
export function residualise(
  days: readonly number[],
  values: readonly number[],
  basis: SeasonalBasis,
): number[] | null {
  const n = days.length;
  if (values.length !== n) {
    throw new Error("residualise: days and values must have equal length");
  }
  if (n < minFitRows(basis)) return null;

  let lo = Infinity;
  let hi = -Infinity;
  for (const d of days) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const mid = (lo + hi) / 2;
  const scale = Math.max(1, hi - lo);
  const w = (2 * Math.PI) / ANNUAL_PERIOD_DAYS;
  const p = basisSize(basis);

  const rows: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = days[i];
    const t = (d - mid) / scale;
    rows[i] =
      basis === "harmonic" ? [1, t, Math.sin(w * d), Math.cos(w * d)] : [1, t];
  }

  const XtX = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xty = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    const f = rows[i];
    const y = values[i];
    for (let a = 0; a < p; a++) {
      Xty[a] += f[a] * y;
      for (let b = a; b < p; b++) XtX[a][b] += f[a] * f[b];
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
  }

  const beta = solve(XtX, Xty);
  if (!beta) return null;

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let fit = 0;
    for (let k = 0; k < p; k++) fit += rows[i][k] * beta[k];
    out[i] = values[i] - fit;
  }
  return out;
}

/**
 * Autocorrelation of a gappy daily series at a CALENDAR lag of `k` days: the
 * covariance over the pairs of days `k` apart that both exist, divided by the
 * variance over every day that exists. Returns 0 when fewer than three such
 * pairs exist or the series is constant.
 *
 * `dense` holds the series on a contiguous day grid starting at the first day,
 * with `NaN` for a missing day.
 */
function autocorrelationDense(
  dense: Float64Array,
  mean: number,
  variance: number,
  k: number,
): number {
  if (variance === 0) return 0;
  let c = 0;
  let cnt = 0;
  for (let i = 0; i + k < dense.length; i++) {
    const a = dense[i];
    const b = dense[i + k];
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    c += (a - mean) * (b - mean);
    cnt++;
  }
  return cnt < 3 ? 0 : c / cnt / variance;
}

function densify(
  days: readonly number[],
  values: readonly number[],
): { dense: Float64Array; mean: number; variance: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of days) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const dense = new Float64Array(hi - lo + 1).fill(Number.NaN);
  let sum = 0;
  for (let i = 0; i < days.length; i++) {
    dense[days[i] - lo] = values[i];
    sum += values[i];
  }
  const mean = sum / values.length;
  let ss = 0;
  for (const v of values) ss += (v - mean) ** 2;
  return { dense, mean, variance: ss / values.length };
}

/**
 * Autocorrelation of a gappy daily series at calendar lag `k`. Exposed for the
 * tests; the engine goes through {@link effectiveSampleSize}.
 */
export function autocorrelation(
  days: readonly number[],
  values: readonly number[],
  k: number,
): number {
  if (values.length < 3) return 0;
  const { dense, mean, variance } = densify(days, values);
  return autocorrelationDense(dense, mean, variance, k);
}

/**
 * Pyper & Peterman (1998) effective sample size for the correlation of two
 * serially correlated series observed on the same `days`:
 *
 *   1/n_eff = 1/n + (2/n) · Σ_{k=1}^{⌊n/5⌋} ((n − k)/n) · ρx(k) · ρy(k)
 *
 * with ρ the calendar-lag autocorrelations of each residual series. Clamped to
 * `[MIN_EFFECTIVE_N, n]`: two persistent series lose most of their apparent
 * information, two white-noise series keep about all of it, and opposite
 * autocorrelation structures never inflate n beyond the observed pairs.
 */
export function effectiveSampleSize(
  days: readonly number[],
  xs: readonly number[],
  ys: readonly number[],
): number {
  const n = days.length;
  if (xs.length !== n || ys.length !== n) {
    throw new Error("effectiveSampleSize: inputs must have equal length");
  }
  if (n < 3) return n;
  const x = densify(days, xs);
  const y = densify(days, ys);
  const maxLag = Math.max(1, Math.floor(n / 5));
  let s = 0;
  for (let k = 1; k <= maxLag; k++) {
    const rx = autocorrelationDense(x.dense, x.mean, x.variance, k);
    if (rx === 0) continue;
    const ry = autocorrelationDense(y.dense, y.mean, y.variance, k);
    s += ((n - k) / n) * rx * ry;
  }
  const inv = 1 / n + (2 / n) * s;
  if (!(inv > 0)) return n;
  return Math.min(n, Math.max(MIN_EFFECTIVE_N, 1 / inv));
}

/** Both residual series of one paired sample, ready for Pearson. */
export interface SeasonalResiduals {
  /** Which nuisance basis was removed (decided by the paired span). */
  basis: SeasonalBasis;
  /** Columns removed besides the intercept (partial-correlation df cost). */
  covariates: number;
  xs: number[];
  ys: number[];
  /** Pyper–Peterman effective sample size of the residual pair. */
  effectiveN: number;
}

/**
 * Residualise both arms of a paired sample on the same nuisance basis and
 * compute the effective sample size of the result.
 *
 * `days` is the day index each pair is keyed on (the behaviour day for a
 * lagged pair). Keying the outcome arm on the same index is exact: a constant
 * lag shifts the trend into the intercept and rotates the sine/cosine pair
 * into itself, so the column space is identical.
 *
 * Returns null when the sample is too small to fit the chosen basis; the
 * caller then leaves the pair untested rather than testing it raw.
 */
export function residualisePair(
  days: readonly number[],
  xs: readonly number[],
  ys: readonly number[],
): SeasonalResiduals | null {
  const n = days.length;
  if (xs.length !== n || ys.length !== n) {
    throw new Error("residualisePair: inputs must have equal length");
  }
  if (n === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of days) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const basis = basisForSpan(hi - lo + 1);
  const rx = residualise(days, xs, basis);
  const ry = residualise(days, ys, basis);
  if (!rx || !ry) return null;
  return {
    basis,
    covariates: basisSize(basis) - 1,
    xs: rx,
    ys: ry,
    effectiveN: effectiveSampleSize(days, rx, ry),
  };
}
