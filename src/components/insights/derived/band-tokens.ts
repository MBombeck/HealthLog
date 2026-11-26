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

import {
  SCORE_BAND_DIRECTION,
  scoreBand,
  type HealthLogScoreKind,
} from "@/lib/analytics/score/shared";

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
 * Map a higher-is-better 0..100 score to its band, for a ring or row the
 * server sent no band for. It IS the server's rule (`scoreBand`, green from
 * 70, yellow from 50), so a pillar row and the score the server computed
 * never disagree on colour for the same number. A lower-is-better score
 * (stress, strain) must pass the server's band, never fall back to this.
 */
export function bandForScore(score: number): ScoreBand {
  return scoreBand(score);
}

/** Clamp a score into the 0..100 rendering range, defending bad input. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * The message key of the word under a HealthLog score's band, by the
 * score's direction (`SCORE_BAND_DIRECTION`). A higher-better score reads
 * good / fair / low; a load (stress, strain) reads as a load, low /
 * moderate / high, so a heavy stress is "high", never "low". The health
 * score is higher-better like readiness and the sleep score. Every score
 * surface takes its word from here, never from a map of its own.
 */
export function scoreBandWordKey(
  kind: HealthLogScoreKind,
  band: ScoreBand,
): string {
  return bandWordKey(band, SCORE_BAND_DIRECTION[kind] === "lower-better");
}

/** `scoreBandWordKey` by direction alone, for a ring told only `load`. */
export function bandWordKey(band: ScoreBand, load = false): string {
  return load
    ? `insights.scores.loadBand.${band}`
    : `insights.derived.scoreRing.band.${band}`;
}
