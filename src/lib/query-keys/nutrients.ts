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
  /**
   * v1.43 — the nutrient catalogue from `GET /api/nutrients/catalog`: codes,
   * labels, input units and upper limits. The composition form is built from
   * it.
   */
  nutrientCatalog: () => ["nutrients", "catalog"] as const,
  /** The daily energy balance from `GET /api/nutrients/energy-balance`. */
  energyBalance: (days: number) =>
    ["nutrients", "energy-balance", days] as const,
  // No key for `GET /api/nutrients/targets`: no web view reads it. The
  // target editor reads a code's target from the daily series above and
  // invalidates that series after a save. The route serves the API and the
  // iPhone app.
};
