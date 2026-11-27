import type { ScoreBand } from "./band-tokens";

/**
 * The colour of a score ring's arc: its band, from the calm score palette
 * (`--score-good`, `--score-fair`, `--score-low` in `globals.css`, tuned per
 * theme and for red-green colour blindness), or the neutral ink for a score
 * without a band. The only colour rule a ring has (concept B); the band word
 * and the arc's length carry the same meaning, so colour is never alone.
 */
export const RING_BAND_COLOR: Record<ScoreBand, string> = {
  green: "var(--score-good)",
  yellow: "var(--score-fair)",
  red: "var(--score-low)",
};

/** The neutral ink of a ring whose score carries no band. */
export const RING_NO_BAND_COLOR = "var(--score-ink)";

export function ringColor(band: ScoreBand | null): string {
  return band === null ? RING_NO_BAND_COLOR : RING_BAND_COLOR[band];
}
