/**
 * v1.10.0 — shared score-band token vocabulary for the derived-metrics
 * design system. Extracted so the new primitives (score-ring,
 * coverage-meter, sparkline-delta-tile, provenance-explainer) paint the
 * exact same band colour grammar the shipped `health-score-card` already
 * uses, without each component redeclaring the map (concept cohesion).
 *
 * These point at the *semantic* feedback tokens (`--success` / `--warning`
 * / `--destructive`), NOT the raw `--dracula-*` primitives. That matters
 * for contrast: `:root.light` (Alucard) overrides the semantic tokens to
 * AA-safe darker tones (`--success: #14720a`, `--warning: #a34d14`,
 * `--destructive: #cb3a2a`) precisely because straight Dracula
 * green/orange on a white `--card` clears only ~1.1–1.5:1 — under AA.
 * Painting the band off the semantic token means every score surface
 * tracks that light-mode correction automatically, in both themes. The
 * raw `--dracula-*` primitives now carry their own AA-tuned light
 * overrides too (globals.css `:root.light`), so chart code that passes
 * `var(--dracula-*)` references is theme-safe; the band still rides the
 * semantic token because a green/yellow/red band is the one semantic the
 * whole v1.10 score language extends.
 */

export type ScoreBand = "green" | "yellow" | "red";

/** Tailwind text-colour class per band (the headline number colour). */
export const BAND_NUMBER_CLASS: Record<ScoreBand, string> = {
  green: "text-success",
  yellow: "text-warning",
  red: "text-destructive",
};

/** Tailwind background class per band (progress/fill bars). */
export const BAND_PROGRESS_CLASS: Record<ScoreBand, string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-destructive",
};

/** Tailwind border-colour class per band (card / chip outlines). */
export const BAND_BORDER_CLASS: Record<ScoreBand, string> = {
  green: "border-success/40",
  yellow: "border-warning/40",
  red: "border-destructive/40",
};

/**
 * Map a 0..100 score to its band. Mirrors the thresholds the existing
 * health-score blend uses (≥ 70 green, ≥ 40 yellow, else red) so a
 * derived score and the composite health score never disagree on colour
 * for the same number.
 */
export function bandForScore(score: number): ScoreBand {
  if (score >= 70) return "green";
  if (score >= 40) return "yellow";
  return "red";
}

/** Clamp a score into the 0..100 rendering range, defending bad input. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
