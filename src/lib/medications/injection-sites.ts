/**
 * v1.4.25 W4d — injection-site rotation logic.
 *
 * The 8-zone enum maps to the Prisma `InjectionSite` enum exactly so
 * the snapshot, the picker, the card variant, and the doctor-report
 * all speak the same vocabulary. Front-of-body view, mirrored for
 * left/right per Eli Lilly's Mounjaro PI + Novo Nordisk's
 * Ozempic/Wegovy PI rotation guidance.
 */

export const INJECTION_SITE_KEYS = [
  "ABDOMEN_LEFT",
  "ABDOMEN_RIGHT",
  "ABDOMEN_UPPER_LEFT",
  "ABDOMEN_UPPER_RIGHT",
  "THIGH_LEFT",
  "THIGH_RIGHT",
  "UPPER_ARM_LEFT",
  "UPPER_ARM_RIGHT",
] as const;

export type InjectionSiteKey = (typeof INJECTION_SITE_KEYS)[number];

/**
 * Stylized SVG position for each site (front-of-body view, ~120x300
 * viewBox). Used by `injection-site-picker.tsx` to render the clickable
 * dots; tuned to read clearly on a 320px mobile viewport.
 *
 * The body outline is a rounded humanoid: head (y≈20), shoulders
 * (y≈60), torso (y≈70-180), thighs (y≈180-260). Sites sit on the
 * dominant injection zones — abdomen quadrants centred on (60, 130),
 * thighs at (40, 215) / (80, 215), upper arms at (20, 80) / (100, 80).
 */
export const SITE_COORDS: Record<InjectionSiteKey, { x: number; y: number }> = {
  ABDOMEN_UPPER_LEFT: { x: 48, y: 110 },
  ABDOMEN_UPPER_RIGHT: { x: 72, y: 110 },
  ABDOMEN_LEFT: { x: 48, y: 140 },
  ABDOMEN_RIGHT: { x: 72, y: 140 },
  THIGH_LEFT: { x: 42, y: 215 },
  THIGH_RIGHT: { x: 78, y: 215 },
  UPPER_ARM_LEFT: { x: 18, y: 82 },
  UPPER_ARM_RIGHT: { x: 102, y: 82 },
};

/**
 * Recommend the next injection site given the recent rotation
 * history. Strategy: maximise the average Euclidean distance from the
 * candidate to each of the last N sites (N defaults to 4), tie-break
 * by least-recently-used (an unseen site beats a stale one).
 *
 * Returns `null` only when the input history is empty (no
 * recommendation to make — the picker shows all sites as available).
 */
export function nextInjectionSite(
  history: ReadonlyArray<InjectionSiteKey>,
  windowSize = 4,
): InjectionSiteKey | null {
  if (history.length === 0) {
    // First-time user — recommend a sensible default (abdomen left)
    // rather than null. The card needs SOMETHING to point to.
    return "ABDOMEN_LEFT";
  }

  const recent = history.slice(0, windowSize);
  // Site → most recent index in the recent window (lower = more
  // recent). Sites missing from the window get a large rank so they
  // beat any recently-used site in the tie-break.
  const lastSeenRank = new Map<InjectionSiteKey, number>();
  for (let i = 0; i < recent.length; i += 1) {
    if (!lastSeenRank.has(recent[i])) {
      lastSeenRank.set(recent[i], i);
    }
  }

  let bestSite: InjectionSiteKey = INJECTION_SITE_KEYS[0];
  let bestScore = -Infinity;

  for (const candidate of INJECTION_SITE_KEYS) {
    if (candidate === recent[0]) continue; // never recommend the most-recent site
    const candidateCoord = SITE_COORDS[candidate];
    let dist = 0;
    for (const used of recent) {
      const usedCoord = SITE_COORDS[used];
      const dx = candidateCoord.x - usedCoord.x;
      const dy = candidateCoord.y - usedCoord.y;
      dist += Math.sqrt(dx * dx + dy * dy);
    }
    // Recency penalty — sites used more recently score lower.
    const rank = lastSeenRank.get(candidate);
    const recencyBonus = rank === undefined ? recent.length * 50 : -rank * 10;
    const score = dist + recencyBonus;
    if (score > bestScore) {
      bestScore = score;
      bestSite = candidate;
    }
  }

  return bestSite;
}

/**
 * i18n-friendly human-readable label key for a site. Caller passes
 * it to `t()` to render the localised string.
 */
export function describeInjectionSite(site: InjectionSiteKey): string {
  const suffix = site
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `medications.site${suffix}`;
}
