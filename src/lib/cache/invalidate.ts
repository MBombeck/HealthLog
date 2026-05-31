/**
 * v1.4.34 IW-G — per-user cache invalidation helpers.
 *
 * Each write endpoint that touches a measurement / mood / medication /
 * dashboard-widget row calls the matching helper after its successful
 * database commit. The helpers walk the affected `caches.*` maps and
 * delete every key whose `userId` prefix matches.
 *
 * The "evict the whole user-bucket" stance is intentional: a redundant
 * eviction costs the next reader one cache miss (cheap, the row's
 * already paginated and the snapshot LRU sits behind), but an
 * under-eviction surfaces stale data which is the directive's failure
 * mode. The full per-write → per-cache fan-out is documented in the
 * blueprint §6 (`.planning/research/v1434-r-cache-aggregation.md`).
 *
 * The helpers are intentionally synchronous — they do `Map.delete()`
 * over a bounded entry set, which is cheap enough to run inline before
 * the write endpoint's `apiSuccess()` return. No `await` overhead.
 */

import { caches } from "./server-cache";

/**
 * v1.7.0 W6 — server cache key for the unified dashboard first-paint
 * snapshot. Lives under the analytics cache bucket so the existing
 * `caches.analytics.deleteByPrefix(`${userId}|`)` sweep on a
 * measurement / mood / medication write already covers it; the widget
 * + insight invalidators that DON'T touch the analytics bucket call
 * `invalidateUserDashboardSnapshot` explicitly. Exported so the cache
 * key stays single-source-of-truth across the route and the tests.
 */
export function dashboardSnapshotCacheKey(userId: string): string {
  return `${userId}|dashboard-snapshot`;
}

/**
 * Drop the unified dashboard snapshot for a single user. Cheap
 * point-delete; safe to call redundantly.
 */
export function invalidateUserDashboardSnapshot(userId: string): void {
  caches.analytics.delete(dashboardSnapshotCacheKey(userId));
}

/**
 * Invalidate every cache that may reflect a user's measurement set.
 *
 * Covers: analytics aggregate, achievement progress, workouts cache.
 * Mood-analytics is invalidated separately via `invalidateUserMood`
 * because mood writes don't change measurement rows.
 */
export function invalidateUserMeasurements(userId: string): void {
  // The `${userId}|` prefix sweep covers the slim / thick analytics
  // cells, the iOS summary cell, AND the v1.7.0 dashboard snapshot
  // (`${userId}|dashboard-snapshot`) in one pass.
  caches.analytics.deleteByPrefix(`${userId}|`);
  caches.achievements.deleteByPrefix(userId);
  caches.workouts.deleteByPrefix(`${userId}|`);
  // v1.4.36 W1 — measurement writes change the per-target consistency
  // strips, the in-range rates and the streak counters that
  // `/api/insights/targets` computes. Evict the user's bucket so the
  // next mount paints fresh data.
  caches.insightsTargets.deleteByPrefix(userId);
}

/**
 * Invalidate every cache that may reflect a user's mood entries.
 *
 * Mood writes also dirty the analytics aggregate (correlations runner
 * pairs mood × pulse) and achievement progress (consistent-month / mood
 * badges).
 */
export function invalidateUserMood(userId: string): void {
  caches.moodAnalytics.deleteByPrefix(userId);
  caches.achievements.deleteByPrefix(userId);
  caches.analytics.deleteByPrefix(`${userId}|`);
  // v1.4.36 W1 — mood writes change the mood target rows on the
  // insights/targets response (MOOD_SCORE, MOOD_STABILITY).
  caches.insightsTargets.deleteByPrefix(userId);
}

/**
 * Invalidate every cache that may reflect a user's medication state.
 *
 * Covers the medications cache, the medication-intake compliance cache
 * (cached daily), and achievement progress.
 */
export function invalidateUserMedications(userId: string): void {
  caches.medications.deleteByPrefix(userId);
  caches.medicationsIntake.deleteByPrefix(`${userId}|`);
  caches.achievements.deleteByPrefix(userId);
  // v1.4.36 W1 — medication writes change the MEDICATION_COMPLIANCE
  // target rollup (compliance7 / compliance30 / consistency strip).
  caches.insightsTargets.deleteByPrefix(userId);
  // v1.4.38 W-F — `/api/dashboard/summary` lives under the analytics
  // cache and reads `medicationIntakeEvent` for both today's compliance
  // tally and the 365-day streak feed. A taken / skipped event must
  // evict the user-bucket so the next iOS poll reflects the change.
  caches.analytics.deleteByPrefix(`${userId}|`);
}

/**
 * Invalidate the dashboard-widget layout cache for a single user.
 *
 * Called from the dashboard-widgets PUT / DELETE endpoints when the
 * user reorders / disables a tile.
 */
export function invalidateUserDashboardWidgets(userId: string): void {
  caches.dashboardWidgets.deleteByPrefix(userId);
  // v1.7.0 W6 — the layout rides inside the unified snapshot now, so a
  // tile reorder / visibility toggle must also drop the snapshot. The
  // widget invalidator does NOT touch the analytics bucket, so the
  // prefix sweep above does not cover the snapshot key — drop it
  // explicitly.
  invalidateUserDashboardSnapshot(userId);
}

/**
 * v1.7.0 — invalidate caches a fresh comprehensive-insight write
 * dirties. The dashboard snapshot embeds the pre-generated daily
 * briefing read-only, so a new generation must evict it; the next
 * snapshot then carries the new briefing. Called directly from the
 * `/api/insights/generate` POST after its own cache write, and from
 * `generateComprehensiveInsight` after its write — so the
 * `insight-pregenerate` cron evicts through the generator, not by
 * calling this itself.
 */
export function invalidateUserInsights(userId: string): void {
  invalidateUserDashboardSnapshot(userId);
}

/**
 * Invalidate the insights tile-layout cache for a single user. Called
 * from the insights-layout PUT / DELETE endpoints when the user
 * reorders / disables a tile so the next `/insights` mount paints the
 * new layout.
 */
export function invalidateUserInsightsLayout(userId: string): void {
  caches.insightsLayout.deleteByPrefix(userId);
}

/**
 * Global eviction of the bug-report-status cache.
 *
 * The cache is keyed on the singleton `"singleton"` slot because the
 * underlying data is a row in `AppSettings`. Any admin write to the
 * GitHub-token / bug-report-enabled fields invalidates the entire
 * cache; the per-user `isAdmin` flag is layered on at request time, so
 * the cache itself only stores role-agnostic shape.
 */
export function invalidateAppSettings(): void {
  caches.bugreportStatus.deleteByPrefix("");
}
