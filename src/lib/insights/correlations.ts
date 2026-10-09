/**
 * Correlation discovery for the Insights `/insights` page.
 *
 * Pure functions — no DB, no clock, no I/O — that run the three
 * pre-defined hypotheses surfaced as `<CorrelationCard>` rows:
 *
 *   1. BP ↔ medication compliance — daily systolic vs the day's
 *      medication-compliance %.
 *   2. Mood ↔ resting pulse — same-day mood entry vs resting pulse.
 *   3. Weight ↔ weekday — weight grouped by day-of-week (one-way ANOVA-ish
 *      mean comparison; Pearson is not the right tool for a categorical
 *      x-axis, so #3 uses a "between-group F" approach).
 *
 * The richer automated discovery (scan every metric pair, FDR-controlled
 * top-N) is deferred to a future release — three pre-defined,
 * data-grounded hypotheses are enough to ship the surface.
 *
 * Quality bar (non-negotiable):
 *   - n >= 20 paired data points  (v1.4.23 H6 — raised from 14)
 *   - p <  0.05
 * Anything below the bar returns `{ kind: "insufficient", n, reason }` so
 * the card can render an EmptyState and never imply false confidence.
 *
 * Pearson p-value gate rationale (v1.4.23 H6, Code-MED-03):
 *   The two-sided p-value derives from the Fisher's-Z normal
 *   approximation. At low df (n < 20, df < 18) the normal approx is
 *   generous in the wrong direction — at df=12 a true p ≈ 0.04 gets
 *   reported as p ≈ 0.025, sneaking past the surfacing gate. v1.4.23
 *   raises `MIN_PAIRED_N` from 14 to 20 so the borderline-significance
 *   band is excluded entirely. A rigorous incomplete-beta fix is
 *   queued as a v1.4.24 candidate; raising the gate is the safer
 *   patch here because the false-positive cost compounds when v1.5/v1.6
 *   auto-discovery ships.
 *
 * Conservative phrasing — interpretations always read as "a pattern worth
 * watching" or similar, never "X causes Y". Causation language is banned
 * from this module by code-review convention. Every user-facing interpretation
 * is assembled from locale-keyed templates under `insights.correlation.*` so
 * the never-causal framing survives verbatim in all six locales rather than
 * leaking English into a non-English UI.
 */
import { defaultLocale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  dayKeyToIndex,
  residualisePair,
  type SeasonalBasis,
} from "@/lib/insights/seasonal-adjust";

/** Locale-aware string builder — mirrors the server translator's `t`. */
type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * English by default so the pure callers + unit tests that pass no locale keep
 * their existing (English) output; the analytics route threads the reader's
 * locale through the fast-path so the cards render in the reader's language.
 */
function defaultTranslate(): Translate {
  return getServerTranslator(defaultLocale).t;
}

/**
 * Weekday index (0 = Monday … 6 = Sunday, the order the ANOVA outlier index
 * uses) → the shared `charts.weekdaysFull.*` label key, reused so the weekday
 * name is already localised in every bundle.
 */
const WEEKDAY_LABEL_KEYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

export type CorrelationKind = "bp-compliance" | "mood-pulse" | "weight-weekday";

export interface CorrelationConfidenceBand {
  /** Lower bound of the 95 % confidence interval on the statistic. */
  low: number;
  /** Upper bound of the 95 % confidence interval on the statistic. */
  high: number;
  /** Discrete band the UI chip renders ("low" / "moderate" / "high"). */
  label: "low" | "moderate" | "high";
}

export interface CorrelationOk {
  kind: CorrelationKind;
  status: "ok";
  /** Pearson r for #1 + #2; eta-squared (effect size) for #3. */
  statistic: number;
  /** Sample count behind the statistic (paired rows for #1 + #2). */
  n: number;
  /** Two-sided p-value. < 0.05 is the surface threshold. */
  pValue: number;
  /** 95 % confidence band for the UI chip. */
  confidenceBand: CorrelationConfidenceBand;
  /**
   * One-sentence conservative interpretation, e.g. "Higher compliance is
   * paired with lower systolic — a pattern worth watching." NEVER claims
   * causation.
   */
  interpretation: string;
  /** Per-row data the card's scatter sparkline can render. */
  points: Array<{ x: number; y: number }>;
  /** Free-form key the UI can use to label the x-axis. */
  xLabel: string;
  /** Free-form key the UI can use to label the y-axis. */
  yLabel: string;
  patternId?: string;
  canonicalKey?: string;
  dismissed?: boolean;
}

export interface CorrelationInsufficient {
  kind: CorrelationKind;
  status: "insufficient";
  /** What we did manage to count, even if below threshold. */
  n: number;
  /** Why we gave up: too few rows or p above threshold. */
  reason: "too_few_pairs" | "not_significant" | "no_variance";
  /** Tiny preview the empty-state can use to hint at progress. */
  points: Array<{ x: number; y: number }>;
}

export type CorrelationResult = CorrelationOk | CorrelationInsufficient;

/**
 * Hard floor for paired sample count.
 *
 * v1.4.23 H6 — raised from 14 to 20 so borderline-df Pearson cards
 * stop surfacing. The Fisher's-Z normal approximation overstates
 * significance at df < 18; raising the gate is the simpler patch here
 * (a rigorous incomplete-beta replacement is queued as a v1.4.24
 * candidate). Acceptable trade-off: less false-positive noise; the
 * v1.4.16 B5e feedback aggregator can reverse the call if usage data
 * later shows users miss the borderline cards.
 */
export const MIN_PAIRED_N = 20;
/** Two-sided p-value threshold for a card to surface. */
export const MAX_P_VALUE = 0.05;

// ── Pearson correlation ──────────────────────────────────────────

export interface PearsonOk {
  status: "ok";
  r: number;
  n: number;
  /** Two-sided p-value derived from the t-statistic. */
  pValue: number;
  /** 95 % confidence interval on r via Fisher z-transform. */
  confidenceInterval: [number, number];
  /**
   * The effective sample size the p-value and interval used, when the caller
   * supplied one (serially correlated input). Absent on the plain path, where
   * the p-value uses `n`.
   */
  effectiveN?: number;
}

export interface PearsonInsufficient {
  status: "insufficient";
  reason: "too_few_pairs" | "no_variance";
  n: number;
}

export type PearsonResult = PearsonOk | PearsonInsufficient;

/**
 * Pearson correlation coefficient with a two-sided p-value and a 95 %
 * Fisher-z confidence interval. Pure inline implementation — no
 * dependency on `mathjs` or similar; the formulas are textbook.
 */
export function pearson(input: {
  xs: readonly number[];
  ys: readonly number[];
  minPairs?: number;
  /**
   * Effective sample size for serially correlated input (see
   * `effectiveSampleSize` in `seasonal-adjust.ts`). When given, the t-test
   * uses `min(effectiveN, n − covariates) − 2` degrees of freedom and the
   * Fisher-z interval `effectiveN − 3`, so a persistent series cannot claim the
   * evidence of `n` independent days. `minPairs` still gates on the observed
   * pair count.
   */
  effectiveN?: number;
  /**
   * Nuisance columns already partialled out of both arms (trend, harmonic).
   * Each costs one degree of freedom, as in any partial correlation. Only
   * read when `effectiveN` is given.
   */
  covariates?: number;
}): PearsonResult {
  const { xs, ys } = input;
  const minPairs = input.minPairs ?? MIN_PAIRED_N;
  if (xs.length !== ys.length) {
    throw new Error("pearson: xs and ys must have equal length");
  }
  const n = xs.length;
  if (n < minPairs)
    return { status: "insufficient", reason: "too_few_pairs", n };

  const sumX = xs.reduce((s, v) => s + v, 0);
  const sumY = ys.reduce((s, v) => s + v, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) {
    return { status: "insufficient", reason: "no_variance", n };
  }

  const r = sxy / Math.sqrt(sxx * syy);
  // Numerically clamp into [-1, 1] — floating-point can drift just past
  // the boundary on near-perfect correlations.
  const clamped = Math.max(-1, Math.min(1, r));

  // Two-sided p-value via Student's t. t = r * sqrt(n-2) / sqrt(1-r^2).
  // v1.4.26 P6-1 — replaced the normal-approx fallback with a rigorous
  // regularised-incomplete-beta evaluation so the surface decision is
  // exact at every df the corpus produces, not just for df >= 18. The
  // auto-discovery work planned for v1.5/v1.6 widens the metric pair
  // grid past the three pre-defined cards here; the exact p-value
  // pre-empts a class of false positives that the normal-approx
  // overstated at low df.
  const effectiveN =
    input.effectiveN !== undefined && Number.isFinite(input.effectiveN)
      ? Math.min(n, Math.max(3, input.effectiveN))
      : undefined;
  const df =
    effectiveN === undefined
      ? n - 2
      : Math.min(effectiveN, n - (input.covariates ?? 0)) - 2;
  const tStat =
    Math.abs(clamped) >= 1
      ? Number.POSITIVE_INFINITY
      : (clamped * Math.sqrt(Math.max(0, df))) /
        Math.sqrt(1 - clamped * clamped);
  const pValue = twoSidedPFromT(Math.abs(tStat), df);

  // Fisher z-transform for 95 % CI on r.
  const z = atanh(clamped);
  const se = 1 / Math.sqrt(Math.max(1, (effectiveN ?? n) - 3));
  const zLow = z - 1.96 * se;
  const zHigh = z + 1.96 * se;
  const confidenceInterval: [number, number] = [tanh(zLow), tanh(zHigh)];

  return {
    status: "ok",
    r: roundTo(clamped, 3),
    n,
    pValue,
    confidenceInterval,
    ...(effectiveN === undefined
      ? {}
      : { effectiveN: Math.round(effectiveN * 10) / 10 }),
  };
}

/** One paired observation keyed on a calendar day. */
export interface DayPair {
  /** Day index (days since 1970-01-01) or a `YYYY-MM-DD` key. */
  day: number | string;
  x: number;
  y: number;
}

export type AdjustedPearsonResult =
  | (PearsonOk & { effectiveN: number; basis: SeasonalBasis })
  | PearsonInsufficient;

/**
 * Pearson for two daily series with the shared season and trend removed and
 * the p-value computed from the effective sample size. The discovery engine
 * (every surface that scans the matrix) and the dated fixed-hypothesis cards
 * below go through it.
 *
 * The reported `r` is the correlation of the residuals, i.e. the partial
 * correlation with trend (and, over 120 days or more, the annual cycle) held
 * fixed. `n` stays the observed pair count; `effectiveN` is what the evidence
 * is worth after serial correlation. Pairs too few to fit the basis come back
 * `too_few_pairs` and are not tested at all.
 */
export function seasonallyAdjustedPearson(
  pairs: readonly DayPair[],
  opts: { minPairs?: number } = {},
): AdjustedPearsonResult {
  const minPairs = opts.minPairs ?? MIN_PAIRED_N;
  const n = pairs.length;
  if (n < minPairs)
    return { status: "insufficient", reason: "too_few_pairs", n };
  const days = pairs.map((p) =>
    typeof p.day === "number" ? p.day : dayKeyToIndex(p.day),
  );
  const adjusted = residualisePair(
    days,
    pairs.map((p) => p.x),
    pairs.map((p) => p.y),
  );
  if (!adjusted) return { status: "insufficient", reason: "too_few_pairs", n };
  // A series that is nothing but trend (and season) leaves residuals that are
  // zero up to rounding. Pearson on those would correlate floating-point
  // noise, so treat a residual spread below 1e-9 of the raw spread as none.
  if (
    negligibleSpread(
      pairs.map((p) => p.x),
      adjusted.xs,
    ) ||
    negligibleSpread(
      pairs.map((p) => p.y),
      adjusted.ys,
    )
  ) {
    return { status: "insufficient", reason: "no_variance", n };
  }
  const result = pearson({
    xs: adjusted.xs,
    ys: adjusted.ys,
    minPairs,
    effectiveN: adjusted.effectiveN,
    covariates: adjusted.covariates,
  });
  if (result.status !== "ok") return result;
  return {
    ...result,
    effectiveN: result.effectiveN ?? n,
    basis: adjusted.basis,
  };
}

function sumSquaresAboutMean(values: readonly number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0);
}

function negligibleSpread(
  raw: readonly number[],
  residuals: readonly number[],
): boolean {
  const rawSs = sumSquaresAboutMean(raw);
  if (rawSs === 0) return true;
  return sumSquaresAboutMean(residuals) <= rawSs * 1e-9;
}

function atanh(x: number): number {
  // Math.atanh in case the runtime polyfill misbehaves; both should agree.
  return 0.5 * Math.log((1 + x) / (1 - x));
}

function tanh(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Two-sided p-value for a t-statistic with `df` degrees of freedom.
 *
 * v1.4.26 P6-1 — exact Student's-t survival via the regularised
 * incomplete beta. The two-sided p of |t| with df is
 *   p = I_{x}(df/2, 1/2)        where x = df / (df + t^2).
 * `regularizedIncompleteBeta` below evaluates `I_x(a, b)` with the
 * Lentz continued-fraction recurrence (Numerical Recipes §6.4); the
 * symmetric-tail identity I_x(a,b) = 1 - I_{1-x}(b,a) keeps the
 * recurrence in its convergent half-plane. The previous normal
 * approximation overstated significance at df < 18; this routine is
 * accurate to ~1e-12 across the surfacing range so the v1.4.23 H6
 * gate is no longer load-bearing for correctness — only for sample
 * adequacy.
 */
function twoSidedPFromT(absT: number, df: number): number {
  if (!Number.isFinite(absT)) return 0;
  if (df <= 0) return 1;
  if (absT === 0) return 1;
  const x = df / (df + absT * absT);
  return regularizedIncompleteBeta(x, df / 2, 0.5);
}

// ── Welch two-sample t-test (unequal variances) ────────────────────

export interface WelchOk {
  status: "ok";
  /** Mean of the first sample ("with"). */
  meanA: number;
  /** Mean of the second sample ("without"). */
  meanB: number;
  /** meanA − meanB. */
  meanDiff: number;
  /** Welch t-statistic for the difference of means. */
  tStat: number;
  /** Welch–Satterthwaite degrees of freedom. */
  df: number;
  /** Exact two-sided p-value via the incomplete beta. */
  pValue: number;
  nA: number;
  nB: number;
}

export interface WelchInsufficient {
  status: "insufficient";
  reason: "too_few_samples" | "no_variance";
  nA: number;
  nB: number;
}

export type WelchResult = WelchOk | WelchInsufficient;

/**
 * Welch's two-sample t-test for the difference of two group means under
 * unequal variances (the correct test when the "with-tag" and
 * "without-tag" day counts and spreads differ, which they almost always
 * do). Reuses the exact Student-t survival (`twoSidedPFromT`) so the
 * p-value is accurate at the small df the mood surface produces — the
 * same rigour the Pearson cards use, not a normal approximation.
 *
 * Returns `insufficient` when either group is below `minPerGroup`, or
 * when both groups are constant (zero pooled variance → no testable
 * difference). Guards divide-by-zero and the all-equal degenerate case
 * so callers never see NaN/Infinity.
 *
 * Formula (Welch 1947):
 *   t  = (x̄_A − x̄_B) / sqrt(s²_A/n_A + s²_B/n_B)
 *   df = (s²_A/n_A + s²_B/n_B)² /
 *        ( (s²_A/n_A)²/(n_A−1) + (s²_B/n_B)²/(n_B−1) )
 * with s² the unbiased (n−1) sample variance.
 */
export function welchTTest(
  groupA: readonly number[],
  groupB: readonly number[],
  options: { minPerGroup?: number } = {},
): WelchResult {
  const minPerGroup = options.minPerGroup ?? 2;
  const nA = groupA.length;
  const nB = groupB.length;
  if (nA < minPerGroup || nB < minPerGroup) {
    return { status: "insufficient", reason: "too_few_samples", nA, nB };
  }

  const meanA = groupA.reduce((s, v) => s + v, 0) / nA;
  const meanB = groupB.reduce((s, v) => s + v, 0) / nB;
  // Unbiased (n−1) sample variances.
  const varA = groupA.reduce((s, v) => s + (v - meanA) ** 2, 0) / (nA - 1);
  const varB = groupB.reduce((s, v) => s + (v - meanB) ** 2, 0) / (nB - 1);

  const seA = varA / nA;
  const seB = varB / nB;
  const seSum = seA + seB;
  if (seSum === 0) {
    // Both groups are perfectly constant — no testable spread. If their
    // means differ the difference is real but has no variance estimate;
    // we surface it as "no_variance" so the caller renders a deterministic
    // band rather than a t-test that would divide by zero.
    return { status: "insufficient", reason: "no_variance", nA, nB };
  }

  const meanDiff = meanA - meanB;
  const tStat = meanDiff / Math.sqrt(seSum);
  const dfDenomA = nA > 1 ? seA ** 2 / (nA - 1) : 0;
  const dfDenomB = nB > 1 ? seB ** 2 / (nB - 1) : 0;
  const dfDenom = dfDenomA + dfDenomB;
  const df = dfDenom === 0 ? nA + nB - 2 : seSum ** 2 / dfDenom;
  const pValue = twoSidedPFromT(Math.abs(tStat), df);

  return {
    status: "ok",
    meanA: roundTo(meanA, 3),
    meanB: roundTo(meanB, 3),
    meanDiff: roundTo(meanDiff, 3),
    tStat: roundTo(tStat, 3),
    df: roundTo(df, 2),
    pValue,
    nA,
    nB,
  };
}

/**
 * Regularised incomplete beta function I_x(a, b).
 *
 * Continued-fraction evaluation of B_x(a, b) via the modified Lentz
 * recurrence; the prefactor `front` = x^a (1-x)^b / (a B(a, b)) is
 * computed in log-space to avoid intermediate overflow. The recursion
 * converges fast for x < (a+1)/(a+b+2); the symmetric-tail identity
 * I_x(a,b) = 1 - I_{1-x}(b,a) handles the other half-plane.
 *
 * Source: Press, Teukolsky, Vetterling, Flannery — Numerical Recipes
 * in C, 2nd ed., §6.4 "Incomplete Beta Function".
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // bt = exp(lnΓ(a+b) - lnΓ(a) - lnΓ(b) + a ln x + b ln(1-x))
  // = x^a · (1-x)^b / B(a,b)
  const bt = Math.exp(
    lnGamma(a + b) -
      lnGamma(a) -
      lnGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(x, a, b)) / a;
  }
  // Symmetric-tail branch: pass swapped args + 1-x. Same `bt` prefactor.
  return 1 - (bt * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Modified Lentz continued-fraction sum for B_x(a, b). Returns the
 * raw CF value; the caller multiplies by the `front` factor and
 * divides by `a` to recover I_x(a, b). Cap at 200 iterations — the
 * recurrence converges in <50 across the t-distribution surface; the
 * cap is defence-in-depth.
 */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const maxIter = 200;
  const epsilon = 3e-16;
  const fpMin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    // Even step.
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;
    // Odd step.
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < epsilon) return h;
  }
  return h;
}

/**
 * ln(Γ(x)) via Lanczos g=7 coefficients. Accurate to ~1e-15 for
 * x > 0.5; we only call it with arguments >= 0.5 (a >= 0.5, b = 0.5
 * fixed) so the reflection formula is unnecessary.
 */
function lnGamma(x: number): number {
  const c = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let y = x;
  let tmp = x + 7.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 0.99999999999980993;
  for (let j = 0; j < c.length; j++) {
    ser += c[j] / ++y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function normalCdf(x: number): number {
  // Abramowitz & Stegun 26.2.17 — max abs error ~7.5e-8.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  let p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) p = 1 - p;
  return p;
}

// ── One-way "ANOVA-ish" weekday comparison ──────────────────────

export interface WeekdayAnovaOk {
  status: "ok";
  /** Per-weekday means — index 0 = Monday … 6 = Sunday. */
  means: Array<number | null>;
  /** Per-weekday sample counts — same indexing. */
  counts: number[];
  /** Effect size — eta-squared (between-SS / total-SS). */
  etaSquared: number;
  /** F statistic. */
  fStat: number;
  /** Two-sided p-value approximated from the F-statistic. */
  pValue: number;
  /** Index (0 = Monday) of the weekday with the most extreme deviation from the grand mean. */
  outlierIndex: number;
  /** n total rows. */
  n: number;
}

export interface WeekdayAnovaInsufficient {
  status: "insufficient";
  reason: "too_few_pairs" | "no_variance";
  n: number;
  means: Array<number | null>;
  counts: number[];
}

export type WeekdayAnovaResult = WeekdayAnovaOk | WeekdayAnovaInsufficient;

export interface DailyValuePoint {
  /** Day-of-week; 0 = Monday, 6 = Sunday. ISO weekday minus one. */
  weekday: number;
  /** The metric value (kg, mmHg, etc.). */
  value: number;
}

/**
 * One-way ANOVA across seven weekday groups. Returns `etaSquared`
 * (between-SS / total-SS) as the effect size and an F-statistic with
 * a two-sided p-value approximation. Pure — no clock, no Date math.
 *
 * Caller is responsible for slicing measurements into the
 * `{ weekday, value }` shape (see `correlateWeightWeekday` below).
 */
export function weekdayAnova(
  daily: readonly DailyValuePoint[],
  options: { minN?: number } = {},
): WeekdayAnovaResult {
  const minN = options.minN ?? MIN_PAIRED_N;
  const n = daily.length;
  const groups: number[][] = [[], [], [], [], [], [], []];
  for (const point of daily) {
    if (point.weekday < 0 || point.weekday > 6) continue;
    groups[point.weekday].push(point.value);
  }
  const counts = groups.map((g) => g.length);
  const means: Array<number | null> = groups.map((g) =>
    g.length === 0 ? null : g.reduce((s, v) => s + v, 0) / g.length,
  );

  if (n < minN) {
    return {
      status: "insufficient",
      reason: "too_few_pairs",
      n,
      means,
      counts,
    };
  }

  const grandMean = daily.reduce((s, p) => s + p.value, 0) / n;
  let betweenSS = 0;
  let withinSS = 0;
  let nonEmptyGroups = 0;
  for (let g = 0; g < 7; g++) {
    const groupValues = groups[g];
    const groupMean = means[g];
    if (groupMean === null) continue;
    nonEmptyGroups++;
    betweenSS += groupValues.length * (groupMean - grandMean) ** 2;
    for (const v of groupValues) {
      withinSS += (v - groupMean) ** 2;
    }
  }
  const totalSS = betweenSS + withinSS;
  if (totalSS === 0 || nonEmptyGroups < 2) {
    return { status: "insufficient", reason: "no_variance", n, means, counts };
  }

  const dfBetween = nonEmptyGroups - 1;
  const dfWithin = n - nonEmptyGroups;
  const fStat =
    dfWithin > 0 && withinSS > 0
      ? betweenSS / dfBetween / (withinSS / dfWithin)
      : Number.POSITIVE_INFINITY;
  const etaSquared = roundTo(betweenSS / totalSS, 3);
  const pValue = twoSidedPFromF(fStat, dfBetween, dfWithin);

  // Find the weekday whose mean deviates most from the grand mean.
  let outlierIndex = 0;
  let maxAbsDev = -1;
  for (let g = 0; g < 7; g++) {
    if (means[g] === null) continue;
    const dev = Math.abs((means[g] as number) - grandMean);
    if (dev > maxAbsDev) {
      maxAbsDev = dev;
      outlierIndex = g;
    }
  }

  return {
    status: "ok",
    means,
    counts,
    etaSquared,
    fStat: roundTo(fStat, 3),
    pValue,
    outlierIndex,
    n,
  };
}

/**
 * Two-sided p-value approximation from an F-statistic. We use the
 * Wilson-Hilferty cube-root transform of chi-squared (dfBetween scaled)
 * which converges to the standard normal — accurate enough for the
 * surfacing decision (cards only paint when p < 0.05).
 */
function twoSidedPFromF(
  fStat: number,
  dfBetween: number,
  dfWithin: number,
): number {
  if (!Number.isFinite(fStat) || fStat <= 0) return 1;
  if (dfBetween <= 0 || dfWithin <= 0) return 1;
  // Wilson-Hilferty: z = ((F)^(1/3) * (1 - 2/(9*dfWithin)) - (1 - 2/(9*dfBetween))) /
  //                       sqrt((F)^(2/3) * 2/(9*dfWithin) + 2/(9*dfBetween))
  const cubeF = Math.cbrt(fStat);
  const a = 2 / (9 * dfWithin);
  const b = 2 / (9 * dfBetween);
  const numerator = cubeF * (1 - a) - (1 - b);
  const denom = Math.sqrt(cubeF * cubeF * a + b);
  if (denom === 0) return 0;
  const z = numerator / denom;
  // F is one-tailed by nature (only large F is "more variable"); we
  // surface the one-tailed p so a small effect with p ≈ 0.5 doesn't
  // accidentally surface as "highly significant" via two-tailed math.
  return 1 - normalCdf(z);
}

/**
 * Day index of a day-start `Date` (the fast path builds these from user-zone
 * day keys at UTC midnight). Rounded so a DST-shifted midnight lands on the
 * same day.
 */
function dayIndexOfDate(date: Date): number {
  return Math.round(date.getTime() / 86_400_000);
}

// ── Hypothesis #1 — BP × medication compliance ─────────────────

export interface BpComplianceInput {
  /**
   * Per-day pairs: average systolic on the day vs medication-compliance
   * percentage on the same day. Caller is responsible for the join.
   */
  daily: ReadonlyArray<{ date: Date; systolic: number; compliancePct: number }>;
}

/**
 * Hypothesis #1 — higher medication compliance is paired with lower BP.
 *
 * Runs Pearson on (compliancePct, systolic). A negative r supports the
 * hypothesis (compliance up → BP down). The interpretation phrase
 * tracks the sign so a positive r reads as "no support for the
 * hypothesis" rather than the reverse.
 */
export function correlateBpCompliance(
  input: BpComplianceInput,
  t: Translate = defaultTranslate(),
): CorrelationResult {
  const points = input.daily.map((d) => ({
    x: d.compliancePct,
    y: d.systolic,
  }));
  const r = seasonallyAdjustedPearson(
    input.daily.map((d, i) => ({
      day: dayIndexOfDate(d.date),
      x: points[i].x,
      y: points[i].y,
    })),
  );
  if (r.status === "insufficient") {
    return {
      kind: "bp-compliance",
      status: "insufficient",
      n: r.n,
      reason: r.reason,
      points,
    };
  }
  if (r.pValue >= MAX_P_VALUE) {
    return {
      kind: "bp-compliance",
      status: "insufficient",
      n: r.n,
      reason: "not_significant",
      points,
    };
  }
  const interpretation =
    r.r < -0.1
      ? t("insights.correlation.hypothesis.bpCompliance.support")
      : r.r > 0.1
        ? t("insights.correlation.hypothesis.bpCompliance.surprising")
        : t("insights.correlation.hypothesis.bpCompliance.none");
  return {
    kind: "bp-compliance",
    status: "ok",
    statistic: r.r,
    n: r.n,
    pValue: r.pValue,
    confidenceBand: bandFromInterval(r.confidenceInterval),
    interpretation,
    points,
    xLabel: "Compliance %",
    yLabel: "Systolic (mmHg)",
  };
}

// ── Hypothesis #2 — Mood × resting pulse ───────────────────────

export interface MoodPulseInput {
  /**
   * Per-day pairs: mood score (1-5) vs resting pulse (bpm) on the same day.
   */
  daily: ReadonlyArray<{ date: Date; mood: number; restingPulse: number }>;
}

/**
 * Hypothesis #2 — lower mood is paired with higher resting pulse.
 *
 * Runs Pearson on (mood, restingPulse). A negative r supports the
 * hypothesis (mood down → pulse up).
 */
export function correlateMoodPulse(
  input: MoodPulseInput,
  t: Translate = defaultTranslate(),
): CorrelationResult {
  const points = input.daily.map((d) => ({ x: d.mood, y: d.restingPulse }));
  const r = seasonallyAdjustedPearson(
    input.daily.map((d, i) => ({
      day: dayIndexOfDate(d.date),
      x: points[i].x,
      y: points[i].y,
    })),
  );
  if (r.status === "insufficient") {
    return {
      kind: "mood-pulse",
      status: "insufficient",
      n: r.n,
      reason: r.reason,
      points,
    };
  }
  if (r.pValue >= MAX_P_VALUE) {
    return {
      kind: "mood-pulse",
      status: "insufficient",
      n: r.n,
      reason: "not_significant",
      points,
    };
  }
  const interpretation =
    r.r < -0.1
      ? t("insights.correlation.hypothesis.moodPulse.support")
      : r.r > 0.1
        ? t("insights.correlation.hypothesis.moodPulse.surprising")
        : t("insights.correlation.hypothesis.moodPulse.none");
  return {
    kind: "mood-pulse",
    status: "ok",
    statistic: r.r,
    n: r.n,
    pValue: r.pValue,
    confidenceBand: bandFromInterval(r.confidenceInterval),
    interpretation,
    points,
    xLabel: "Mood (1-5)",
    yLabel: "Resting pulse (bpm)",
  };
}

// ── Hypothesis #3 — Weight × weekday ───────────────────────────

export interface WeightWeekdayInput {
  /**
   * Daily weight rows. Caller pre-aggregates so each row corresponds to
   * one (day, weight) pairing.
   */
  daily: ReadonlyArray<{ weekday: number; weight: number }>;
}

/**
 * Hypothesis #3 — weight has a weekly pattern (e.g. Monday spikes
 * after weekends).
 *
 * Runs the weekday ANOVA. Effect size + significance gate the surface;
 * the interpretation flags the most-deviant weekday.
 */
export function correlateWeightWeekday(
  input: WeightWeekdayInput,
  t: Translate = defaultTranslate(),
): CorrelationResult {
  const points = input.daily.map((d) => ({ x: d.weekday, y: d.weight }));
  const anova = weekdayAnova(
    input.daily.map((d) => ({ weekday: d.weekday, value: d.weight })),
  );
  if (anova.status === "insufficient") {
    return {
      kind: "weight-weekday",
      status: "insufficient",
      n: anova.n,
      reason: anova.reason,
      points,
    };
  }
  if (anova.pValue >= MAX_P_VALUE) {
    return {
      kind: "weight-weekday",
      status: "insufficient",
      n: anova.n,
      reason: "not_significant",
      points,
    };
  }
  const dayLabel = t(
    `charts.weekdaysFull.${WEEKDAY_LABEL_KEYS[anova.outlierIndex]}`,
  );
  const grandMean =
    input.daily.reduce((s, p) => s + p.weight, 0) / input.daily.length;
  const outlierMean = anova.means[anova.outlierIndex] ?? grandMean;
  const direction = t(
    `insights.correlation.weekdayDirection.${outlierMean > grandMean ? "above" : "below"}`,
  );
  const delta = Math.abs(outlierMean - grandMean).toFixed(1);
  const interpretation = t("insights.correlation.hypothesis.weightWeekday", {
    weekday: dayLabel,
    delta,
    direction,
  });

  return {
    kind: "weight-weekday",
    status: "ok",
    // For ANOVA we surface eta-squared as the "statistic" so the UI can
    // render a magnitude chip. The chart renders mean-per-weekday.
    statistic: anova.etaSquared,
    n: anova.n,
    pValue: anova.pValue,
    confidenceBand: bandFromEtaSquared(anova.etaSquared, anova.n),
    interpretation,
    points,
    xLabel: "Weekday",
    yLabel: "Weight (kg)",
  };
}

function bandFromInterval(
  interval: [number, number],
): CorrelationConfidenceBand {
  const low = roundTo(interval[0], 3);
  const high = roundTo(interval[1], 3);
  // Width of the CI drives the discrete chip — wide CI → low confidence.
  const width = Math.abs(high - low);
  let label: CorrelationConfidenceBand["label"];
  if (width <= 0.4) label = "high";
  else if (width <= 0.8) label = "moderate";
  else label = "low";
  return { low, high, label };
}

function bandFromEtaSquared(eta: number, n: number): CorrelationConfidenceBand {
  // ANOVA effect-size confidence — Cohen's conventions: eta² >= 0.14
  // is "large", >= 0.06 "medium", < 0.06 "small". n boosts the band.
  const adjusted = eta + (n >= 60 ? 0.02 : 0);
  let label: CorrelationConfidenceBand["label"];
  if (adjusted >= 0.14) label = "high";
  else if (adjusted >= 0.06) label = "moderate";
  else label = "low";
  // We expose the raw eta as the "interval" lo/hi for downstream UIs
  // that want a numeric — there's no closed-form 95 % CI on eta-squared
  // without a non-central F distribution we don't carry, so the band
  // label is the load-bearing surface.
  return { low: roundTo(adjusted, 3), high: roundTo(adjusted, 3), label };
}
