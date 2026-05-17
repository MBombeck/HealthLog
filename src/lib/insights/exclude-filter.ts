/**
 * v1.4.36 W3 T3 — exclude-metrics filter for the AI Insights payload.
 *
 * Mirrors the Coach snapshot's `excludeMetrics` contract so the user
 * has a single privacy contract across both surfaces: what's hidden
 * from the Coach turn stays hidden from the Insights generation. The
 * filter drops matching keys off the features object BEFORE
 * `JSON.stringify` so the LLM never sees the excluded data.
 *
 * The token vocabulary is the same `coachExcludeMetricEnum` from
 * `src/lib/validations/coach-prefs.ts` — see the comment there for
 * the canonical list. The mapping below pairs each token with the
 * features.ts field keys it gates; tokens with no mapped fields
 * (e.g. Apple Health metrics that don't have a dedicated features
 * branch yet) are no-ops on this surface but keep the contract
 * symmetric so adding a future field is one-line.
 *
 * Anthropometrics is special-cased: rather than dropping the whole
 * `context` field (which carries non-PII totals like `dataSpanDays`),
 * we strip just `heightCm` / `ageYears` / `gender` from it.
 */
import type { AggregatedFeatures, RawFeatures } from "./features";

/**
 * Map exclude-token → features.ts top-level keys to remove. `null`
 * means the token gates a substructure inside `context` and is
 * handled inline below.
 */
const EXCLUDE_TO_FEATURE_KEYS: Record<string, ReadonlyArray<keyof AggregatedFeatures>> = {
  bp: ["bloodPressure"],
  weight: ["weight"],
  pulse: ["pulse"],
  mood: ["mood"],
  compliance: ["medications"],
  medications: ["medications"],
  sleep: ["sleep"],
  steps: ["activity"],
  // hrv / resting_hr — no dedicated features branch yet (carried only
  // by the Coach Apple-Health blocks). Keep the entry for symmetry +
  // future-proofing.
  hrv: [],
  resting_hr: [],
};

/**
 * Return a shallow copy of `features` with every key gated by an
 * active exclude-token removed. Idempotent. Original payload is not
 * mutated — same posture as the snapshot filter so call sites can
 * keep both the filtered + unfiltered shape if they need to.
 */
export function applyInsightsExcludeFilter<
  T extends AggregatedFeatures | RawFeatures,
>(features: T, excludeMetrics: ReadonlyArray<string>): T {
  if (excludeMetrics.length === 0) return features;
  const next = { ...features } as Record<string, unknown>;
  for (const token of excludeMetrics) {
    const keys = EXCLUDE_TO_FEATURE_KEYS[token];
    if (keys) {
      for (const key of keys) {
        delete next[key as string];
      }
    }
    if (token === "anthropometrics" && next.context && typeof next.context === "object") {
      // Anthropometrics gates the profile sub-fields inside `context`.
      // The rest of context (totals, span days) stays — those are
      // aggregate counts the model needs for narrative coverage even
      // when the profile is hidden.
      const ctx = { ...(next.context as Record<string, unknown>) };
      ctx.heightCm = null;
      ctx.ageYears = null;
      ctx.gender = null;
      next.context = ctx;
    }
  }
  return next as T;
}
