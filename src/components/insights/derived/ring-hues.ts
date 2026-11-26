/**
 * v1.14.0 — per-metric ring hues for the wellness-score strip.
 *
 * Each metric leans toward one intentional, distinct hue: readiness green,
 * recovery cyan, sleep purple, stress orange, strain pink — five clearly
 * different hues so the strip never reads as "a wash of green/cyan".
 *
 * v1.18.7 — CALM. The arc was a dark→neon two-stop gradient (the `to` stop
 * sat on the raw Dracula palette colour) plus a bloom + sheen, which glowed
 * against the flat charts. The two stops are now MUTED and sit a hair apart,
 * so each arc reads as a near-flat single tone — quiet as a chart series. The
 * actual colours live as CSS custom properties in `globals.css`
 * (`--ring-<key>-from` / `--ring-<key>-to` / `--tile-<key>`) with a Dracula
 * dark set on `:root` and an Alucard light set on `:root.light`, so each hue
 * is HAND-TUNED per theme — deep enough to hold contrast on the white Alucard
 * card without going neon on the dark Dracula card.
 *
 * The band semantic is never carried by the hue: it still rides `data-band`
 * + the band word + the aria-label, so a red-band readiness still reads "low"
 * in copy while its ring leans green.
 */

import type { ScoreBand } from "./band-tokens";

/** The per-metric hue keys the wellness strip passes to `<ScoreRing>`.
 *  `meds` is the dashboard dose ring: the medication family in Insights
 *  paints `--primary` everywhere (the compliance Progress bars, the
 *  compliance trend line, the drug-level and dose-strength curves), so
 *  the ring rides the same token — constant, never a band gradient.
 *  Contrast (computed): dark #bd93f9 — 6.78:1 card / 5.90:1 bg; light
 *  #644ac9 — 6.00:1 card / 5.60:1 bg — far above the 3:1 graphics
 *  floor in both themes, and a future `--primary` retune carries the
 *  ring along. */
export type RingHue =
  "readiness" | "sleep" | "recovery" | "stress" | "strain" | "meds" | "health";

/**
 * Near-flat single-hue arc `[from, to]` per metric, plus a band fallback for
 * the anatomy detail view (which passes no `hue`, so the ring keeps its
 * green/yellow/red band semantics there). The two stops are a hair apart for a
 * whisper of depth, not a neon sweep. Values are CSS var references resolved
 * per theme — consumed straight by the SVG `<linearGradient>` stops.
 */
export const RING_GRADIENT: Record<RingHue | ScoreBand, [string, string]> = {
  readiness: ["var(--ring-readiness-from)", "var(--ring-readiness-to)"],
  recovery: ["var(--ring-recovery-from)", "var(--ring-recovery-to)"],
  sleep: ["var(--ring-sleep-from)", "var(--ring-sleep-to)"],
  stress: ["var(--ring-stress-from)", "var(--ring-stress-to)"],
  strain: ["var(--ring-strain-from)", "var(--ring-strain-to)"],
  // Perfectly flat by design (both stops on the one token) — the med
  // family's `--primary`, not a hand-tuned from/to pair.
  meds: ["var(--primary)", "var(--primary)"],
  // The Health score's ring on the Insights head takes the teal the web's
  // recovery ring wore; that ring left the head in 1.50, and the purple
  // family is the sleep score's.
  health: ["var(--ring-recovery-from)", "var(--ring-recovery-to)"],
  // Band fallback for the anatomy detail view (no per-metric hue passed):
  green: ["var(--ring-green-from)", "var(--ring-green-to)"],
  yellow: ["var(--ring-yellow-from)", "var(--ring-yellow-to)"],
  red: ["var(--ring-red-from)", "var(--ring-red-to)"],
};

/**
 * The surface tint per metric — the `--tile-hue` the `.wellness-tile` CSS
 * mixes (gently) over the theme `--card`. Set inline by each `RingTile`.
 */
export const TILE_HUE: Record<RingHue, string> = {
  readiness: "var(--tile-readiness)",
  sleep: "var(--tile-sleep)",
  recovery: "var(--tile-recovery)",
  stress: "var(--tile-stress)",
  strain: "var(--tile-strain)",
  // No wellness tile carries the meds hue; the dose ring lives on the
  // dashboard hero only. Primary keeps the record total.
  meds: "var(--primary)",
  health: "var(--tile-recovery)",
};
