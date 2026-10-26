/**
 * Derive `daysAgo` from the cached `lastSeenAt` ISO string per request. The
 * cached envelope deliberately omits `daysAgo` so the dashboard tile
 * staleness caption stays correct across day boundaries even when the body
 * has been sitting in the 60s LRU.
 *
 * Returns a shallow-copied envelope with the enriched `lastSeenByType` map;
 * everything else is passed through unchanged.
 */
export function enrichLastSeenDaysAgo<
  T extends {
    lastSeenByType: Record<string, { lastSeenAt: string } | null>;
  },
>(
  body: T,
): Omit<T, "lastSeenByType"> & {
  lastSeenByType: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  >;
} {
  const nowMs = Date.now();
  const enriched: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  > = {};
  for (const [type, slot] of Object.entries(body.lastSeenByType)) {
    if (slot === null) {
      enriched[type] = null;
      continue;
    }
    const lastMs = new Date(slot.lastSeenAt).getTime();
    const daysAgo = Math.floor((nowMs - lastMs) / (24 * 60 * 60 * 1000));
    enriched[type] = { lastSeenAt: slot.lastSeenAt, daysAgo };
  }
  return { ...body, lastSeenByType: enriched };
}
