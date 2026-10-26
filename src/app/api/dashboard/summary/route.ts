/**
 * GET /api/dashboard/summary
 *
 * Aggregator endpoint for the iOS DashboardSummary view. Combines
 * greeting, intake-day streaks, today's medication compliance, the
 * highlighted insight, and per-metric latest+sparkline+trend.
 *
 * The shape is fixed for the iOS client and intentionally normalised —
 * `kind` is iOS-friendly (camelCase), unlike the canonical Prisma enum
 * (BLOOD_PRESSURE_SYS etc.).
 *
 * Cold-mount performance (v1.4.38 W-F)
 * ------------------------------------
 * The legacy shape ran an unbounded `prisma.measurement.findMany` over
 * the trailing 7 days plus a second unbounded `findMany` over the
 * trailing 365 days for the streak-day set. On a power-user account
 * (Apple Health step samples ≈ thousands per day) those two queries
 * dominated the wall-clock at ~4.6 s cold even though the DOWNSTREAM
 * JS code only ever needed:
 *   - the latest value per type within the 7-day window
 *   - a small sparkline (≤7 daily aggregates) per type
 *   - the set of YYYY-MM-DD day-keys with any activity in 365 days
 *
 * v1.4.38 swaps the two unbounded reads for SQL aggregates:
 *   - one row per type carrying the latest value + measuredAt
 *     (≤ N_metrics rows). REG-11 (v1.4.44) dropped the trailing-7-day
 *     window from the WHERE clause; the tile now surfaces the all-time-
 *     latest reading per type so a 60-day-old BP measurement still feeds
 *     the tile (paired with the stale-caption hint built off
 *     `lastSeenAt`). v1.38.5 replaced the `DISTINCT ON (type)` that
 *     produced those rows with a LATERAL join over the type list; both
 *     per-type reads now live in `@/lib/dashboard/summary-reads`.
 *   - `measurement_rollups` DAY buckets keyed `(user_id, type,
 *     granularity, bucketStart)` → at most 7 buckets per metric × N_metrics rows.
 *     Sparkline points become the bucket means rather than individual
 *     raw samples, which is a *smoother* trend signal for high-volume
 *     metrics like ACTIVITY_STEPS and bounded for every other metric.
 *     REG-11 (v1.4.44) switched the calendar-window filter for a
 *     `ROW_NUMBER() OVER (PARTITION BY type ORDER BY bucket_start
 *     DESC)` window so the sparkline takes the last `SPARK_DAYS`
 *     buckets per type regardless of age.
 *   - `SELECT DISTINCT date_trunc('day', measured_at)::date` over the
 *     365-day window → at most 365 dates (vs. up to 100k raw rows).
 *
 * The whole response is wrapped in the 60 s analytics LRU cache so
 * subsequent iOS polls inside the window hit memory. Invalidation runs
 * via the existing `invalidateUserMeasurements` + the v1.4.38-extended
 * `invalidateUserMedications` hooks.
 *
 * Module gate: the emitted `metrics` array is filtered against the account's
 * module map before it leaves the handler, so a card whose measurement type
 * belongs to a disabled module never ships. The decision comes from the same
 * map the shared snapshot builder uses (`disabledSummaryTypes`); the filter
 * runs OUTSIDE the cache because a module toggle does not evict it.
 *
 * The builder lives in `src/lib/dashboard/summary/`.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { validTimezoneOr } from "@/lib/tz/format";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { resolveModuleMap } from "@/lib/modules/gate";
import { gateMetricCardsByModules } from "@/lib/dashboard/widget-modules";
import {
  buildDashboardSummary,
  buildSummaryContext,
} from "@/lib/dashboard/summary/build";

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");
  annotate({ action: { name: "dashboard.summary" } });

  // v1.4.25 — anchor every day-bucket call to the user's display
  // timezone. Falls back to Europe/Berlin when the column is somehow
  // missing (defensive — the schema's NOT NULL default normally pins
  // it).
  const userTz = validTimezoneOr(user.timezone, DEFAULT_TIMEZONE);

  // v1.4.38 — wrap the whole response in the analytics LRU.
  // Subsequent iOS polls inside the TTL hit memory; measurement /
  // mood / medication writes invalidate the user-bucket via the
  // existing `invalidateUserMeasurements` + the v1.4.38-extended
  // `invalidateUserMedications` hooks.
  //
  // v1.18.11 — read via `cachedSwr`. The `analytics` bucket
  // already provisions a 1 h `staleTtlMs` window, but this endpoint read
  // through plain `cached` and so ignored it: the iOS client polls every
  // 60 s, and a plain read past the 60 s fresh TTL re-paid the full cold
  // rebuild on every poll. `cachedSwr` serves the prior body instantly
  // inside the stale window and warms one background recompute instead.
  // Writes still mark/evict the bucket, so a user's own action is
  // reflected on the very next read — the window only bounds wall-clock
  // drift (the same self-correcting `nextDueOverdue`/tally drift the
  // snapshot read already tolerates).
  const body = await cachedSwr(
    caches.analytics as ServerCache<
      Awaited<ReturnType<typeof buildDashboardSummary>>
    >,
    `${user.id}|dashboard-summary`,
    async () =>
      buildDashboardSummary(user.id, userTz, await buildSummaryContext(user)),
    annotate,
  );

  // ── module gate ───────────────────────────────────────────────────
  // This route builds its own payload instead of going through
  // `readDashboardSnapshotCached`, so it never picked up the module gate
  // the shared snapshot builder applies — it emitted glucose and sleep
  // tiles on data presence alone, while `/api/dashboard/snapshot` correctly
  // withheld them for the same account.
  //
  // OMIT, NOT 403 — matching the snapshot sibling and the sync feed. This is
  // an aggregate of ten metric cards across several domains; refusing the
  // whole request would blank the iOS dashboard because one module is off.
  // The card simply does not appear, which is exactly what a disabled module
  // means on every other dashboard surface.
  //
  // Applied AFTER the cache read, deliberately. The analytics LRU is keyed
  // `<userId>|dashboard-summary` with a 60 s fresh / 1 h stale window, and
  // toggling a module does not evict it — gating inside the builder would
  // leave the disabled tile served for up to an hour after the user turned
  // it off. Filtering the cached body makes the toggle effective on the very
  // next request.
  const modules = await resolveModuleMap(user.id);
  const metrics = gateMetricCardsByModules(body.metrics, modules);
  annotate({
    meta: {
      metrics_emitted: metrics.length,
      metrics_gated: body.metrics.length - metrics.length,
    },
  });

  return apiSuccess({ ...body, metrics });
});
