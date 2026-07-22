/**
 * Query keys — nutrient-intake sync (v1.28). One read: the window
 * summary behind the read-only Settings → Sources card. Part of the
 * centralized factory; aggregated in `./index.ts`.
 */
export const nutrientKeys = {
  /** Prefix for invalidating every nutrient read. */
  nutrientsRoot: () => ["nutrients"] as const,

  /** Per-nutrient window summary from `GET /api/nutrients?days=N`. */
  nutrientIntake: (days: number) => ["nutrients", "intake", days] as const,
  /**
   * v1.29 — one nutrient's day-bucketed series from
   * `GET /api/nutrients/daily?nutrient=<code>&days=N`. Feeds the
   * `/insights/nutrients` hydration + caffeine charts.
   */
  nutrientDaily: (nutrient: string, days: number) =>
    ["nutrients", "daily", nutrient, days] as const,
};
