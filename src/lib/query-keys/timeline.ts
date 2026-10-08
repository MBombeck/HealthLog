/**
 * Query keys — the life timeline and life events (v1.42, #613).
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * The timeline, its readiness inventory and the life-event list share the
 * `["timeline"]` root: a life-event write changes all three, and a write to any
 * other record table evicts the root through the data bundles in `./index.ts`.
 */
export const timelineKeys = {
  /** Root prefix; the data-dependent bundles invalidate through it. */
  timelineRoot: () => ["timeline"] as const,
  /**
   * `GET /api/timeline`. Zoom, window and the chosen value series are the
   * key: each combination is a different payload.
   */
  timeline: (
    zoom: string,
    from: string | null,
    to: string | null,
    values: string,
  ) => ["timeline", "lanes", zoom, from, to, values] as const,
  /** `GET /api/timeline/readiness`. */
  timelineReadiness: () => ["timeline", "readiness"] as const,
  /** `GET /api/life-events`. */
  lifeEvents: () => ["timeline", "life-events"] as const,
};
