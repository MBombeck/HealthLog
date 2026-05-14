/**
 * v1.4.20 phase B5 — Personal Health Score.
 *
 * A composite 0–100 score that blends four health pillars into one
 * easy-to-read number. Server-deterministic: the same inputs always
 * produce the same output, so a curious user can recompute it mentally
 * (or in a spreadsheet) from the four components.
 *
 * Formula (when every component is present):
 *   score = round(
 *     0.30 * bpInTargetRate       // % of paired BP readings inside band
 *   + 0.20 * weightTrendAlignment // 0..100, see weightTrendAlignment()
 *   + 0.20 * moodStability        // 0..100, see moodStability()
 *   + 0.30 * complianceRate       // mean of medication compliance30
 *   )
 *
 * When a component is null (insufficient data, no medications, no
 * weight target, etc.) the remaining weights are scaled proportionally
 * so they still sum to 100 — the score never lies about what was
 * actually measured.
 *
 * Bands:
 *   green  >= 75
 *   yellow 50..74
 *   red    < 50
 *
 * The score is **descriptive, not prescriptive** — see the disclaimer
 * the UI surfaces ("Indicative — not a clinical assessment.").
 */

export type HealthScoreBand = "green" | "yellow" | "red";

/**
 * v1.4.25 W8e — per-component source attribution.
 *
 * `manual` / `withings` / `appleHealth` map onto the `MeasurementSource`
 * enum already persisted on the underlying rows. `mixed` is the
 * aggregate label when the component blends entries from more than one
 * source. `none` is the explicit empty-state — no measurement contributed.
 *
 * The token list is a UI-facing camelCase view of the persisted
 * `MeasurementSource` enum so the i18n keys (`provenance.sources.*`)
 * stay locale-stable even if the storage enum grows.
 */
/**
 * Source tokens that can contribute to a component before the
 * `resolveSourceLabel` aggregation kicks in. Exported here so the
 * analytics route, the health-score helper, and the React card all
 * read the same union — the literal `"manual" | "withings" |
 * "appleHealth"` was previously spelled at four call sites.
 */
export type ContributingSource = "manual" | "withings" | "appleHealth";

export type HealthScoreComponentSource = ContributingSource | "mixed" | "none";

/**
 * v1.4.25 W8e — per-component source attribution as it arrives from the
 * Prisma layer (the route maps Withings/Apple-Health/Manual rows for
 * each pillar and forwards the contributing source set plus the
 * freshest timestamp). `complianceSources` is `null` when no medications
 * are active so the redistribution helper keeps treating compliance as
 * "no signal" rather than "manual with zero entries".
 */
export interface HealthScoreSourceAttribution {
  /** Sources that contributed to the BP-in-target rate. */
  bpSources?: ReadonlyArray<ContributingSource>;
  asOfBp?: string | null;
  /** Sources that contributed to the weight series. */
  weightSources?: ReadonlyArray<ContributingSource>;
  asOfWeight?: string | null;
  /** Sources that contributed to the mood entries. */
  moodSources?: ReadonlyArray<ContributingSource>;
  asOfMood?: string | null;
  /** Sources that contributed to medication compliance. */
  complianceSources?: ReadonlyArray<ContributingSource>;
  asOfCompliance?: string | null;
  /** Wall-clock anchor for the as-of-window-end fallback. */
  windowEndAt?: string;
}

export interface HealthScoreInput {
  /** All-time BP-in-target rate, already 0..100 (or null). */
  bpInTargetRate: number | null;
  /** Weight readings over the last 30 days, ascending or unsorted (we sort). */
  weightSeriesLast30d: Array<{ date: string; kg: number }>;
  /** User's stored target weight in kg, if any. */
  weightTargetKg: number | null;
  /** Mood entries over the last 30 days. `score` 1..5 in HealthLog. */
  moodEntriesLast30d: Array<{ date: string; score: number }>;
  /** Per-active-medication 30-day compliance %. Empty array → null. */
  medicationCompliance30: number[];
  /**
   * v1.4.25 W8e — optional source attribution. When omitted the
   * resulting `HealthScoreComponentDetail.source` falls back to `none`
   * for null components and `manual` for present ones (the
   * pre-v1.4.25 implicit default).
   */
  attribution?: HealthScoreSourceAttribution;
}

export interface HealthScoreComponentDetail {
  /** Sub-score 0..100, or null if the component had insufficient data. */
  value: number | null;
  /** Effective weight after null-redistribution, 0..1. */
  weight: number;
  /**
   * v1.4.25 W8e — which ingest path produced the underlying
   * measurement(s) for this component. `mixed` when two or more
   * sources contributed; `none` when the value is null.
   */
  source: HealthScoreComponentSource;
  /**
   * ISO timestamp of the most recent contributing measurement, or
   * the as-of-window-end when no measurement contributed.
   */
  asOf: string;
}

export interface HealthScoreResult {
  /** 0..100, integer. Always present (defaults to 0 with all-null input). */
  score: number;
  band: HealthScoreBand;
  components: {
    bp: HealthScoreComponentDetail;
    weight: HealthScoreComponentDetail;
    mood: HealthScoreComponentDetail;
    compliance: HealthScoreComponentDetail;
  };
  /** Difference vs. last week's score; null when no historical input. */
  delta: number | null;
}

const BASE_WEIGHTS = {
  bp: 0.3,
  weight: 0.2,
  mood: 0.2,
  compliance: 0.3,
} as const;

// ── Pure helpers ─────────────────────────────────────────────────────

/**
 * Linear-regression slope (units / day) over a time-series of points.
 * Pure least-squares fit. Returns null when there are fewer than two
 * distinct x-values (the denominator collapses to zero).
 */
export function linearRegressionSlope(
  points: Array<{ date: string; value: number }>,
): number | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const startMs = new Date(sorted[0].date).getTime();
  if (Number.isNaN(startMs)) return null;
  const xy = sorted.map((p) => {
    const t = new Date(p.date).getTime();
    return {
      x: (t - startMs) / (24 * 60 * 60 * 1000),
      y: p.value,
    };
  });
  const n = xy.length;
  const sumX = xy.reduce((s, p) => s + p.x, 0);
  const sumY = xy.reduce((s, p) => s + p.y, 0);
  const sumXY = xy.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = xy.reduce((s, p) => s + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Coefficient of variation: stdev / |mean|. Returns null when the mean
 * is zero (the metric is undefined) or when fewer than two values are
 * supplied (population variance over n=1 is zero by definition but
 * carries no signal).
 */
export function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return null;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stdev = Math.sqrt(variance);
  return stdev / Math.abs(mean);
}

/**
 * Score how well the recent weight trend is closing the gap toward the
 * target band [targetMin..targetMax].
 *
 * - Already inside the band → 100 (the trend doesn't need to do anything).
 * - Above the band → a downward slope is "closing the gap"; magnitude
 *   maps slope to 0..100 with a saturating curve so a 0.5 kg/day drop
 *   doesn't read more positive than a 0.05 kg/day drop.
 * - Below the band → an upward slope is closing.
 *
 * Insufficient data (< 2 readings, no target) → null.
 */
export function weightTrendAlignment(
  series: Array<{ date: string; kg: number }>,
  target: { min: number; max: number } | null,
): number | null {
  if (!target || series.length < 2) return null;
  const points = series.map((p) => ({ date: p.date, value: p.kg }));
  // Latest reading drives the "are we currently in the band" check.
  const sorted = [...points].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const latest = sorted[sorted.length - 1].value;
  if (latest >= target.min && latest <= target.max) return 100;

  const slope = linearRegressionSlope(points);
  if (slope === null) return null;

  // Saturate a 0.1 kg/day movement to ~75 % alignment so noisy data
  // doesn't cliff the score. The mapping uses a tanh-style curve scaled
  // around 0.05 kg/day (≈ 1.5 kg/month — a clinically reasonable rate).
  const SATURATION = 0.05;
  const normalised = Math.tanh(Math.abs(slope) / SATURATION);

  // Above the band: slope < 0 closes the gap.
  // Below the band: slope > 0 closes the gap.
  const closing = latest > target.max ? slope < 0 : slope > 0;
  if (slope === 0) return 50; // exactly stable counts as "neither"
  return Math.round(closing ? 50 + 50 * normalised : 50 - 50 * normalised);
}

/**
 * Mood stability scored as `100 - CV*100`, clamped to 0..100. Returns
 * null when there are fewer than 5 entries (the variance is too noisy
 * to draw a stability conclusion from).
 */
export function moodStability(
  entries: Array<{ date: string; score: number }>,
): number | null {
  if (entries.length < 5) return null;
  const values = entries.map((e) => e.score);
  const cv = coefficientOfVariation(values);
  if (cv === null) return null;
  const score = 100 - cv * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Mean of medication-compliance percentages. Returns null when no
 * medications are active so the score doesn't penalise people who
 * haven't logged any.
 */
export function complianceRate(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((s, v) => s + v, 0);
  return Math.round(sum / values.length);
}

// ── Composite ────────────────────────────────────────────────────────

function clampToHundred(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function bandFor(score: number): HealthScoreBand {
  if (score >= 75) return "green";
  if (score >= 50) return "yellow";
  return "red";
}

/**
 * Compute the composite score + sub-component breakdown. Pure.
 *
 * The optional `previous` parameter is used by the route to plug the
 * "vs last week" delta — when omitted the result's `delta` is null.
 */
export function computeHealthScore(
  input: HealthScoreInput,
  previous?: HealthScoreInput,
): HealthScoreResult {
  const bpValue =
    input.bpInTargetRate === null ? null : clampToHundred(input.bpInTargetRate);

  const target = deriveWeightTarget(input.weightTargetKg);
  const weightValue = weightTrendAlignment(input.weightSeriesLast30d, target);

  const moodValue = moodStability(input.moodEntriesLast30d);

  const complianceValue = complianceRate(input.medicationCompliance30);

  const attribution = input.attribution ?? {};
  const windowEndAt = attribution.windowEndAt ?? deriveWindowEndAt(input);
  const components = redistribute(
    {
      bp: bpValue,
      weight: weightValue,
      mood: moodValue,
      compliance: complianceValue,
    },
    {
      bp: {
        sources: attribution.bpSources ?? null,
        asOf: attribution.asOfBp ?? null,
      },
      weight: {
        sources: attribution.weightSources ?? null,
        asOf: attribution.asOfWeight ?? null,
      },
      mood: {
        sources: attribution.moodSources ?? null,
        asOf: attribution.asOfMood ?? null,
      },
      compliance: {
        sources: attribution.complianceSources ?? null,
        asOf: attribution.asOfCompliance ?? null,
      },
    },
    windowEndAt,
  );

  let raw = 0;
  for (const key of ["bp", "weight", "mood", "compliance"] as const) {
    const c = components[key];
    if (c.value !== null) raw += c.value * c.weight;
  }
  const score = Math.round(clampToHundred(raw));
  const band = bandFor(score);

  let delta: number | null = null;
  if (previous) {
    const prev = computeHealthScore(previous);
    delta = score - prev.score;
  }

  return { score, band, components, delta };
}

/**
 * Collapse a list of contributing source tokens into the single label
 * the UI renders. `null`/empty when the underlying value is missing
 * → `none`. Two or more distinct tokens → `mixed`. Exactly one token
 * → that token. Pre-v1.4.25 inputs (no attribution supplied) default
 * to `manual` for present values so the contract stays backward-compat
 * — the manual-entry path has been HealthLog's only ingest since
 * v1.0.
 */
function resolveSourceLabel(
  hasValue: boolean,
  sources: ReadonlyArray<ContributingSource> | null,
): HealthScoreComponentSource {
  if (!hasValue) return "none";
  if (!sources || sources.length === 0) return "manual";
  const unique = Array.from(new Set(sources));
  if (unique.length === 1) return unique[0];
  return "mixed";
}

/**
 * Re-scale the four base weights to skip any component whose value is
 * null. The remaining components keep the same proportional ratio
 * (e.g. BP and Compliance both at 30 % of original 80 % → 37.5 %).
 *
 * v1.4.25 W8e — the helper also folds the per-component
 * `HealthScoreSourceAttribution` slice into each output detail so the
 * client can render the provenance accordion without a second pass over
 * the analytics payload.
 */
function redistribute(
  values: {
    bp: number | null;
    weight: number | null;
    mood: number | null;
    compliance: number | null;
  },
  attribution: Record<
    keyof typeof BASE_WEIGHTS,
    {
      sources: ReadonlyArray<ContributingSource> | null;
      asOf: string | null;
    }
  >,
  windowEndAt: string,
): HealthScoreResult["components"] {
  const present: Array<keyof typeof BASE_WEIGHTS> = [];
  for (const key of ["bp", "weight", "mood", "compliance"] as const) {
    if (values[key] !== null) present.push(key);
  }
  const totalBaseWeight = present.reduce((s, key) => s + BASE_WEIGHTS[key], 0);
  const weightFor = (key: keyof typeof BASE_WEIGHTS): number => {
    if (values[key] === null) return 0;
    if (totalBaseWeight === 0) return 0;
    return BASE_WEIGHTS[key] / totalBaseWeight;
  };
  const detailFor = (
    key: keyof typeof BASE_WEIGHTS,
  ): HealthScoreComponentDetail => {
    const value = values[key];
    const attr = attribution[key];
    const source = resolveSourceLabel(value !== null, attr.sources);
    // When a component is `none`, fall back to the window-end anchor so
    // the UI can still render "as of <today>" without inventing a date.
    const asOf =
      source === "none" ? windowEndAt : (attr.asOf ?? windowEndAt);
    return {
      value,
      weight: weightFor(key),
      source,
      asOf,
    };
  };
  return {
    bp: detailFor("bp"),
    weight: detailFor("weight"),
    mood: detailFor("mood"),
    compliance: detailFor("compliance"),
  };
}

/**
 * v1.4.25 Fix-G — when the caller doesn't supply `attribution.windowEndAt`
 * we synthesise it deterministically from the input data so
 * `computeHealthScore` stays pure (same input → same output). The route
 * always supplies its own `windowEndAt`; this fallback exists so unit
 * tests and ad-hoc callers don't pull `new Date()` into the result.
 *
 * Strategy: take the most recent date across the weight and mood series.
 * If neither has any entries (e.g. compliance-only input), fall back to
 * the Unix epoch so the value is stable and obviously synthetic — the
 * UI never renders this string when attribution is provided.
 */
function deriveWindowEndAt(input: HealthScoreInput): string {
  let latest = -Infinity;
  for (const p of input.weightSeriesLast30d) {
    const t = new Date(p.date).getTime();
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  for (const p of input.moodEntriesLast30d) {
    const t = new Date(p.date).getTime();
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  if (latest === -Infinity) return new Date(0).toISOString();
  return new Date(latest).toISOString();
}

/**
 * The `weightTargetKg` input is a single number; we expand it to a
 * narrow ±2 kg band so the alignment helper has a "target zone" to
 * test inclusion against. Null target → null band → null component.
 */
function deriveWeightTarget(
  targetKg: number | null,
): { min: number; max: number } | null {
  if (targetKg === null || !Number.isFinite(targetKg)) return null;
  return { min: targetKg - 2, max: targetKg + 2 };
}

/**
 * Helper for callers that have only height + want a BMI-22 fallback
 * target. Surfaces the same ±2 kg band semantics as the in-house
 * derivation so the math is consistent across callers.
 */
export function defaultWeightTargetFromHeight(
  heightCm: number | null,
): number | null {
  if (heightCm === null || heightCm <= 0) return null;
  const heightM = heightCm / 100;
  return Math.round(22 * heightM * heightM * 10) / 10;
}
