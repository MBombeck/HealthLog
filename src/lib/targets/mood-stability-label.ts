/**
 * v1.4.25 W3e — verbal label for the MOOD_STABILITY target headline.
 *
 * The card used to render the raw σ value ("0.42 σ"), which most users
 * cannot interpret. Replace with a three-state verbal label keyed
 * against translation entries `targets.mood.stability.{stable,
 * variable,highlyVariable}`.
 *
 * Thresholds (Marc-set, documented in the W3e implementation plan):
 *   σ <  1.0  →  "stable"           (stabil / stable)
 *   σ <  2.0  →  "variable"         (schwankend / variable)
 *   σ ≥  2.0  →  "highly-variable"  (sehr schwankend / highly variable)
 *
 * Pure helper so the threshold logic can be unit-tested in isolation
 * without React. Returns the stable English key — callers (the card,
 * the Coach prompt builder) own the locale resolution.
 */
export type MoodStabilityLabel = "stable" | "variable" | "highlyVariable";

export function moodStabilityLabel(sigma: number): MoodStabilityLabel {
  if (sigma < 1.0) return "stable";
  if (sigma < 2.0) return "variable";
  return "highlyVariable";
}
