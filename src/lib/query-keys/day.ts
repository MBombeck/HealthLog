/**
 * Query keys — the day view (v1.42, #613): one local day, and the index of
 * days that hold anything over a window.
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * Everything sits under the `["day"]` root so a write to any record table can
 * evict every open day at once: the record data bundles in `./index.ts` carry
 * the root, and a day is cheap enough to re-read that finer keys would only
 * add ways to miss one.
 */
export const dayKeys = {
  /** Root prefix; the data-dependent bundles invalidate through it. */
  dayRoot: () => ["day"] as const,
  /** `GET /api/day/{date}`. */
  day: (date: string) => ["day", "detail", date] as const,
  /** `GET /api/day/index`: the window bounds are the key. */
  dayIndex: (from: string, to: string) => ["day", "index", from, to] as const,
  /** `GET /api/day/notable`: what changed in a window, for a visit. */
  dayNotable: (from: string, to: string) =>
    ["day", "notable", from, to] as const,
};
