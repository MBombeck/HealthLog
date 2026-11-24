/**
 * The night metrics that can be drawn as lines over the hypnogram (#1419).
 *
 * Shared by the server read (`night-overlays.ts`), the persisted chart
 * preference (`dashboard-layout.ts`, `chartOverlayPrefs.sleepNight`) and the
 * card, so the three agree on one closed set. Client-safe: no database code.
 *
 * Each kind names the measurement types that can carry it, in the order a
 * tie between them is broken. HRV is two estimators (SDNN, RMSSD) and skin
 * temperature an absolute reading or a deviation from baseline; the overlay
 * reports which type it drew, and never mixes two in one line.
 */
export const NIGHT_OVERLAY_KINDS = [
  "pulse",
  "hrv",
  "respiration",
  "spo2",
  "skinTemperature",
  "roomTemperature",
] as const;

export type NightOverlayKind = (typeof NIGHT_OVERLAY_KINDS)[number];

/** How many lines the night timeline draws at once. */
export const MAX_NIGHT_OVERLAY_LINES = 2;

export function isNightOverlayKind(value: unknown): value is NightOverlayKind {
  return (
    typeof value === "string" &&
    (NIGHT_OVERLAY_KINDS as readonly string[]).includes(value)
  );
}

/**
 * A stored selection, cleaned: unknown kinds and repeats dropped, at most
 * {@link MAX_NIGHT_OVERLAY_LINES} kept (the most recently chosen last).
 * Anything that is not an array is no selection.
 */
export function coerceNightOverlayKinds(value: unknown): NightOverlayKind[] {
  if (!Array.isArray(value)) return [];
  const out: NightOverlayKind[] = [];
  for (const entry of value) {
    if (isNightOverlayKind(entry) && !out.includes(entry)) out.push(entry);
  }
  return out.slice(-MAX_NIGHT_OVERLAY_LINES);
}

/**
 * The selection after a toggle of `kind`. `chosen` is the stored selection,
 * `shown` the part of it the night holds. Turning a shown kind off removes
 * it; turning one on appends it and, past the limit, drops the one chosen
 * first. A stored kind the night does not hold stays chosen for the nights
 * that do, until the limit pushes it out.
 */
export function nextOverlaySelection(
  chosen: readonly NightOverlayKind[],
  shown: readonly NightOverlayKind[],
  kind: NightOverlayKind,
): NightOverlayKind[] {
  if (shown.includes(kind)) return chosen.filter((k) => k !== kind);
  return [...chosen.filter((k) => k !== kind), kind].slice(
    -MAX_NIGHT_OVERLAY_LINES,
  );
}
