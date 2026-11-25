/**
 * Query keys — the unified daily-value system (S2 Today surface).
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * The Today hero reads ONE cell against `GET /api/daily/digest` (the
 * `DailyDigest` DTO S1 shipped). A single flat key: the digest is a
 * per-user daily read with no discriminator, so `["daily","digest"]`
 * is the whole surface. Kept in the factory so a future daily-data
 * mutation can invalidate it by prefix without a bare-array literal
 * (the `healthlog/queryKey-factory` rule bans those).
 */
export const dailyKeys = {
  dailyDigest: () => ["daily", "digest"] as const,
  /**
   * The morning read (`GET /api/daily/morning`). Flat like the digest: the
   * server keys its own cell by the reader's local day, and the client must
   * build the same key in the server render and in the browser, which a
   * date computed on either side would not guarantee.
   */
  dailyMorning: () => ["daily", "morning"] as const,
};
