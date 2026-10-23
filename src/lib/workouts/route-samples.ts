/**
 * One point of a stored route's `sampleTimestamps`, aligned with the
 * geometry's coordinates. Both ingests store `{ t, speedMs?, hr? }`; tracks
 * written before the per-point channels carry a bare ISO instant. Every
 * reader goes through `routeSampleInstant` so neither shape is skipped.
 */
export type RouteSample = string | { t: string; speedMs?: number; hr?: number };

/** The ISO instant of one sample, or null when it carries none. */
export function routeSampleInstant(sample: unknown): string | null {
  if (typeof sample === "string") return sample.length > 0 ? sample : null;
  if (typeof sample === "object" && sample !== null && "t" in sample) {
    const t = (sample as { t: unknown }).t;
    return typeof t === "string" && t.length > 0 ? t : null;
  }
  return null;
}
