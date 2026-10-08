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

import { forgetCoverageProbe } from "@/lib/rollups/coverage-inflight";

import { caches } from "./server-cache";

/**
 * v1.7.0 W6 — server cache key for the unified dashboard first-paint
 * snapshot. Lives under the analytics cache bucket so the `${userId}|`
 * sweep on a measurement / mood / medication write already covers it
 * (measurement writes mark it stale; mood / medication writes hard-evict
 * it); the widget + insight invalidators that DON'T touch the analytics
 * bucket call `invalidateUserDashboardSnapshot` explicitly. Exported so
 * the cache key stays single-source-of-truth across route and tests.
 */
export function dashboardSnapshotCacheKey(userId: string): string {
  return `${userId}|dashboard-snapshot`;
}

/**
 * Drop the unified dashboard snapshot for a single user. The snapshot cell is
 * keyed `${userId}|dashboard-snapshot|${locale}` (the briefing prose is
 * locale-specific), so this must sweep by PREFIX — an exact point-delete of the
 * locale-less key silently misses every real cell and the dashboard keeps
 * serving the pre-write layout for the whole SWR window. The prefix is
 * distinctive (nothing else in the analytics bucket starts with it), so the
 * sweep touches only this user's snapshot variants. Safe to call redundantly.
 */
export function invalidateUserDashboardSnapshot(userId: string): void {
  caches.analytics.deleteByPrefix(dashboardSnapshotCacheKey(userId));
}

/**
 * Invalidate every cache that may reflect a user's measurement set.
 *
 * Covers: analytics aggregate, achievement progress, workouts cache.
 * Mood-analytics is invalidated separately via `invalidateUserMood`
 * because mood writes don't change measurement rows.
 *
 * v1.16.7 — `evict` splits the analytics bucket by write origin. The
 * `cachedSwr` readers (dashboard snapshot, comprehensive) serve a
 * marked-stale entry as-is, so a mark-stale right after an interactive
 * write would hand the user back the pre-write body. Interactive
 * single-entry routes (manual create / update / delete, bulk-delete,
 * restore) pass `{ evict: true }` so the user's own entry is reflected
 * on the very next read — matching the mood / medication hard-evict
 * posture. Background batch syncs (Apple Health, Withings, workouts)
 * keep the default mark-stale so a high-frequency sync never busts the
 * bucket into inline cold-rebuild storms.
 *
 * v1.42 — the same split now covers `insightsTargets`, and the Apple Health
 * batch route follows it: it evicts only for a `foreground` or `manual`
 * sync or a batch that wrote a hand-entered (`MANUAL`) reading, and marks
 * stale otherwise. The achievements and workouts buckets still evict on
 * every call.
 */
export function invalidateUserMeasurements(
  userId: string,
  opts?: { evict?: boolean },
): void {
  // A coverage probe already running read the set before this write; the
  // next reader must not join it.
  forgetCoverageProbe(userId);
  // The `${userId}|` prefix covers the slim / thick analytics cells, the
  // iOS summary cell, AND the v1.7.0 dashboard snapshot
  // (`${userId}|dashboard-snapshot`) in one pass.
  if (opts?.evict) {
    caches.analytics.deleteByPrefix(`${userId}|`);
  } else {
    // v1.12.7 — mark stale rather than hard-evict. Measurement writes are
    // the highest-frequency dirty signal (every iOS Apple-Health sync
    // posts a batch), and a hard evict busts the snapshot into a cold
    // rebuild on the next read all day long. Marking stale lets the
    // `cachedSwr` snapshot read serve the prior value immediately while a
    // single background recompute warms a fresh one. The slim / thick /
    // summary cells read via plain `cached` are unaffected: a marked-stale
    // entry has `expiresAt === now`, so their next read is a clean miss and
    // rebuilds fresh — identical to the old evict for those keys.
    caches.analytics.markStaleByPrefix(`${userId}|`);
  }
  caches.achievements.deleteByPrefix(userId);
  caches.workouts.deleteByPrefix(`${userId}|`);
  // v1.4.36 W1 — measurement writes change the per-target consistency
  // strips, the in-range rates and the streak counters that
  // `/api/insights/targets` computes.
  //
  // v1.42 — same split as the analytics bucket. The route reads through
  // `cachedSwr`, so a background sync marks the bucket stale (the next read
  // serves the prior strips once while one rebuild runs) instead of
  // throwing it away on every batch; an interactive write still evicts.
  if (opts?.evict) {
    caches.insightsTargets.deleteByPrefix(userId);
  } else {
    caches.insightsTargets.markStaleByPrefix(userId);
  }
  // v1.16.8 — the batched derived-wellness payload computes over the
  // same measurement rollups. Same split as the analytics bucket:
  // interactive writes evict (the user's own entry must reflect on the
  // next read), background syncs mark stale so the SWR reader serves
  // the prior grid while one recompute warms it.
  if (opts?.evict) {
    caches.insightsDerived.deleteByPrefix(`${userId}|`);
  } else {
    caches.insightsDerived.markStaleByPrefix(`${userId}|`);
  }
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
  // v1.8.5 — mood writes dirty every dimension of the mood-insights
  // aggregate (heatmap cell, distribution, weekday, tag breakdown).
  // v1.12.1 — mark stale rather than hard-evict: the mood-insights read
  // is a multi-second cold compute, so an active logger writing back to
  // back used to re-pay it on every entry. Marking stale keeps serving
  // the prior aggregate (within the SWR window) while a single
  // background recompute warms a fresh one.
  caches.moodInsights.markStaleByPrefix(userId);
  // v1.16.8 — READINESS folds the mood series into the derived batch,
  // so a mood write dirties the cached grid. Mark stale (not evict):
  // the wellness strip is a glanceable aggregate, and the background
  // recompute lands the new entry within one read cycle.
  caches.insightsDerived.markStaleByPrefix(`${userId}|`);
}

/**
 * Invalidate every cache that may reflect a user's medication state.
 *
 * Covers the medications cache, the medication-intake compliance cache
 * (cached daily), the per-medication compliance payload, and achievement
 * progress.
 *
 * v1.16.8 — `evict` splits the SWR buckets (medications, the
 * per-medication compliance payload, analytics) by write origin, the
 * `invalidateUserMeasurements` pattern. Interactive writes (a card take /
 * skip, a CRUD edit, an intake edit / delete / purge / import, AND the
 * iOS bulk-intake endpoint — it carries the phone user's own doses) pass
 * `{ evict: true }`: the user must see their own action on the very next
 * read, and a stale-serveable entry would hand back the pre-write body.
 * Background paths (the auto-miss cron, slot dedup) keep the default
 * mark-stale so a high-frequency pass never busts the buckets into
 * inline cold-rebuild storms — the `cachedSwr` readers serve the prior
 * payload while one coalesced recompute warms each cell.
 */
export function invalidateUserMedications(
  userId: string,
  opts?: { evict?: boolean },
): void {
  if (opts?.evict) {
    caches.medications.deleteByPrefix(userId);
    // v1.15.20 — the per-medication compliance payload is cached 15 min;
    // an interactive intake / medication / schedule write must flush it
    // so the card rates and the heatmap reflect the action on the next
    // read.
    caches.medicationCompliance.deleteByPrefix(`${userId}|`);
    // v1.4.38 W-F — `/api/dashboard/summary` lives under the analytics
    // cache and reads `medicationIntakeEvent` for both today's compliance
    // tally and the 365-day streak feed. A taken / skipped event must
    // evict the user-bucket so the next iOS poll reflects the change.
    caches.analytics.deleteByPrefix(`${userId}|`);
  } else {
    // Mark-stale collapses the fresh TTL to "now": the SWR readers (the
    // medications list, both compliance routes, the dashboard snapshot)
    // serve the prior value while a single background recompute warms a
    // fresh one; the plain `cached` readers in the analytics bucket see
    // a clean miss — identical to the old evict for those keys.
    caches.medications.markStaleByPrefix(userId);
    caches.medicationCompliance.markStaleByPrefix(`${userId}|`);
    caches.analytics.markStaleByPrefix(`${userId}|`);
  }
  caches.medicationsIntake.deleteByPrefix(`${userId}|`);
  caches.achievements.deleteByPrefix(userId);
  // v1.4.36 W1 — medication writes change the MEDICATION_COMPLIANCE
  // target rollup (compliance7 / compliance30 / consistency strip).
  caches.insightsTargets.deleteByPrefix(userId);
}

/**
 * Hard-evict every server cache that can carry the derived Health Score.
 * Lab, assessment and score-notice mutations call this one bundle so the
 * analytics report, dashboard snapshot and derived batch cannot disagree.
 */
export function invalidateUserHealthScore(userId: string): void {
  caches.analytics.deleteByPrefix(`${userId}|`);
  caches.insightsDerived.deleteByPrefix(`${userId}|`);
}

/**
 * v1.16.8 — invalidate every cache whose payload derives from the user's
 * PROFILE-level settings rather than from measurement / mood / medication
 * rows. The measurement-write invalidators never fire on a settings save,
 * so before this helper a height / birth-date / gender edit, a threshold
 * override, or a source-priority reorder kept serving the pre-edit
 * targets grid (BMI band, BP-by-age range, glucose effective ranges),
 * derived scores (baseline profile: age / sex / height), and analytics
 * snapshot until the TTL lapsed.
 *
 * Hard-evict on every bucket: these are interactive Settings writes, and
 * a marked-stale SWR cell would hand the user back the pre-edit payload
 * on the very next read.
 *
 * Callers: `/api/user/thresholds` PUT + DELETE, `applyProfileUpdate`
 * (only when heightCm / dateOfBirth / gender is in the update set), and
 * `/api/auth/me/source-priority` PUT. The unit-preference toggle is NOT
 * wired in: it only drives the client-side display transform, no
 * server-cached payload reads it.
 */
export function invalidateUserProfile(userId: string): void {
  caches.insightsTargets.deleteByPrefix(userId);
  caches.insightsDerived.deleteByPrefix(`${userId}|`);
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
 * v1.16.10 — invalidate the medications list-presentation cache for a
 * single user. Called from the medications-layout PUT / DELETE
 * endpoints when the user toggles the view or saves a manual order so
 * the next /medications mount paints the new presentation.
 */
export function invalidateUserMedicationListLayout(userId: string): void {
  caches.medicationListLayout.deleteByPrefix(userId);
}

/**
 * Invalidate the analytics bucket after an illness / cycle / encounter write.
 * `resolveRestMode` (active-episode context) feeds both the analytics report
 * and the dashboard snapshot, and the daily-digest extras cell lives under the
 * same bucket — all keyed `${userId}|…`. Hard-evict, mirroring the mood-write
 * posture: these are interactive single-entry writes, and a marked-stale SWR
 * cell would hand the user back the pre-write rest-mode / appointment context
 * on the very next read.
 */
export function invalidateUserHealthContext(userId: string): void {
  caches.analytics.deleteByPrefix(`${userId}|`);
}

/** Invalidate surfaces whose server decision includes pattern dismissal. */
export function invalidateUserCorrelationPatterns(userId: string): void {
  caches.analytics.deleteByPrefix(`${userId}|`);
  caches.moodInsights.deleteByPrefix(userId);
  caches.insightsDerived.deleteByPrefix(`${userId}|`);
}

/**
 * v1.16.9 — full per-user cache eviction for the wipe / restore paths.
 * A data wipe or a backup restore replaces (or removes) every row the
 * cached payloads were built on, so every per-user bucket hard-evicts —
 * a marked-stale SWR cell would keep serving the pre-wipe body.
 */
export function invalidateUserData(userId: string): void {
  caches.analytics.deleteByPrefix(`${userId}|`);
  caches.medications.deleteByPrefix(userId);
  caches.medicationCompliance.deleteByPrefix(`${userId}|`);
  caches.medicationsIntake.deleteByPrefix(`${userId}|`);
  caches.achievements.deleteByPrefix(userId);
  caches.insightsTargets.deleteByPrefix(userId);
  caches.insightsDerived.deleteByPrefix(`${userId}|`);
  caches.moodAnalytics.deleteByPrefix(userId);
  caches.moodInsights.deleteByPrefix(userId);
  caches.workouts.deleteByPrefix(`${userId}|`);
  caches.dashboardWidgets.deleteByPrefix(userId);
  caches.insightsLayout.deleteByPrefix(userId);
  caches.medicationListLayout.deleteByPrefix(userId);
}

/**
 * v1.16.9 — bucket-wide clear for the admin all-user wipe. Every cache
 * empties; the next read per user is a cold build over the (now empty /
 * restored) tables. Acceptable for an operation this rare.
 */
export function invalidateAllCaches(): void {
  for (const cache of Object.values(caches)) {
    cache.deleteByPrefix("");
  }
}
