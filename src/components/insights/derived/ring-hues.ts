/**
 * Per-metric hues of the score charts and tiles: readiness green, recovery
 * cyan, sleep purple, stress orange, strain pink, a history line and a tile
 * tint each. The colours live as CSS custom properties in `globals.css`
 * (`--ring-<key>-from` / `--ring-<key>-to` / `--tile-<key>`), hand-tuned per
 * theme.
 *
 * Since 1.50 these never colour a ring's arc. A ring says its band and only
 * its band (`ring-color.ts`, concept B): an identity hue on the arc read as
 * a verdict, so a readiness of 42 sat in a calm green ring.
 */

/** The per-metric hue keys of the score charts and tiles (not the rings).
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
 * Per-metric series colours `[from, to]` for a score's charts (its history
 * line, the anatomy's metric lines). Never a ring's arc: since 1.50 a ring is
 * coloured by its band only (`ring-color.ts`, concept B), so a hue on a ring
 * can no longer say "green" about a low score. Values are CSS var references
 * resolved per theme.
 */
export const RING_GRADIENT: Record<RingHue, [string, string]> = {
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
