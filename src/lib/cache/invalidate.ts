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
 * Invalidate every cache that may reflect a user's measurement set.
 *
 * Covers: analytics aggregate, achievement progress, workouts cache.
 * Mood-analytics is invalidated separately via `invalidateUserMood`
 * because mood writes don't change measurement rows.
 */
export function invalidateUserMeasurements(userId: string): void {
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
}

/**
 * Invalidate the dashboard-widget layout cache for a single user.
 *
 * Called from the dashboard-widgets PUT / DELETE endpoints when the
 * user reorders / disables a tile.
 */
export function invalidateUserDashboardWidgets(userId: string): void {
  caches.dashboardWidgets.deleteByPrefix(userId);
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
