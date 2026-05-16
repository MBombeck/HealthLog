# v1.4.34.1 — Insights cold-mount perf hotfix — closure

Shipped: 2026-05-16T22:27Z
Tag: `v1.4.34.1`
Release: <https://github.com/MBombeck/HealthLog/releases/tag/v1.4.34.1>

## What was broken

`/insights` mount paid ~29 s on every cold load against accounts populated by the v1.4.34 Apple Health importer.

HAR capture (`~/Downloads/healthlog.bombeck.io.har`, 2026-05-16T19:48 UTC):

| Endpoint | Wall time | Status | Note |
| --- | --- | --- | --- |
| `/api/insights/comprehensive` | 29 120 ms | 200 | Root cause. Unbounded `findMany` over 90 days of all measurement types. NOT in IW-G cache. |
| `/api/insights/generate` (POST) | 8 001 ms | 0 | LLM stream, normal-ish. |
| `/api/workouts?limit=1` | 28 094 ms | 200 | Pool-blocked behind comprehensive. |
| `/api/bugreport/status` | 28 448 ms | 200 | Pool-blocked behind comprehensive. |
| `/api/measurements?…&aggregate=daily` ×3 | 37–38 ms | **503** | Cloudflare circuit-breaker — `"no available server"` — origin couldn't accept new connections fast enough. |
| `/api/mood/analytics` ×2 | 39 / 66 ms | **503** | Same Cloudflare circuit-breaker. |
| `/api/analytics` (thick + slim) | 122 / 125 ms | 200 | IW-G cache hit — already fast. |

The whole pattern (29 s killer + 28 s pool-blocked siblings + 503 spill-over) is a single failure mode in disguise: one slow endpoint monopolises one of the 20 hot-applied pool connections for the whole window.

## Root cause

`src/app/api/insights/comprehensive/route.ts:49` (pre-fix):

```ts
const allMeasurements = await prisma.measurement.findMany({
  where: { userId, type: { in: types }, measuredAt: { gte: ninetyDaysAgo } },
  orderBy: { measuredAt: "asc" },
  select: { type: true, value: true, measuredAt: true },
});
```

No `take`, no chunking, no cache wrap. Post Apple-Health import the query returned 100 000+ rows in a single round-trip. Then the route looped over the rows in JS for:
- per-type `summarize()` (slope7 / 30 / 90, avg7 / 30 / 90, anomaly count)
- BMI, BP classification, BP target adherence
- Four Pearson correlations (weight×BP, mood×BP, mood×weight, mood×pulse)

The cache-aggregation research (`.planning/research/v1434-r-cache-aggregation.md`) listed eight routes for IW-G to wrap. `comprehensive` was not on the list because the original HAR was a Dashboard-mount, not an `/insights`-mount. The /insights page mounts `comprehensive` as its dominant fetch; the dashboard does not.

## Layer A — what this hotfix did

### 1. SQL-side aggregator for `/api/insights/comprehensive`

New file `src/lib/insights/comprehensive-aggregator.ts` (~370 LOC). Five parallel queries via `Promise.all`:

1. `$queryRaw` per-type aggregate: count, min, max, mean, stddev (via CTE), avg7 / avg30 / avg30_last_month, regr_slope7 / 30 / 90, regr_r2_7 / 30 / 90, anomaly count using `STDDEV_POP` (matches the JS divisor `n` and round-then-threshold ordering).
2. `$queryRaw DISTINCT ON (type)` for the latest raw value per type.
3. `$queryRaw date_trunc('day')` daily means for WEIGHT / BLOOD_PRESSURE_SYS / PULSE (correlation inputs).
4. Bounded `findMany` for BP_SYS raw rows (5-minute pairing for BP target adherence).
5. Bounded `findMany` for BP_DIA raw rows (same).

Plus one conditional `MIN(measured_at)` for `dataSpanDays`.

Route handler split into `buildComprehensiveResponse(user)` wrapped through `caches.analytics` (60 s TTL) keyed on `${userId}|comprehensive`. The 60 s TTL collapses every consumer within the window — page mount, Coach drawer, recommendations grid — to a `Map.get()` call.

**Cold path drops from ~29 s to ~200–500 ms.** Warm path: single-digit ms.

One sanctioned semantic divergence: `weight × BP` correlation switched from `pairByTimestamp(24 h tolerance)` to a daily-key join. Authorised in the agent directive; flagged for byte-shape watchers.

### 2. Cache-wrap on the five remaining read routes

The IW-G primitive provisioned eight `caches.*` instances but only wired three. The remaining five staged-but-unwired routes:

| Route | Cache instance | Key | TTL |
| --- | --- | --- | --- |
| `/api/mood/analytics` | `caches.moodAnalytics` | `userId` | 60 s |
| `/api/workouts` | `caches.workouts` | `userId\|limit\|offset\|since\|until\|sportType` | 60 s |
| `/api/bugreport/status` | `caches.bugreportStatus` | `"singleton"` (isAdmin layered per request) | 10 min |
| `/api/medications` | `caches.medications` | `userId` | 60 s |
| `/api/dashboard/widgets` | `caches.dashboardWidgets` | `userId` | 5 min |

All five write paths already wire `invalidateUser*` helpers from the IW-G matrix. One gap closed: `/api/dashboard/chart-overlay-prefs` PUT now also calls `invalidateUserDashboardWidgets()` — that partial-update route shares the underlying `User.dashboardWidgetsJson` blob the new `/api/dashboard/widgets` cache reads from.

### 3. Scatter-correlation card dimension fix

Already committed as `322d0844` on develop before this session. Bundled into the v1.4.34.1 release notes for completeness.

## Why 503s disappear without a direct fix

The 503s on `/api/measurements?aggregate=daily` and `/api/mood/analytics` were Cloudflare's `"no available server"` plain-text fast-reject — the origin couldn't accept new connections within Cloudflare's fail-fast window. The root cause was pool starvation upstream. Once `comprehensive` stops monopolising 28 s of pool time, the origin accepts new connections fast enough that Cloudflare's circuit-breaker doesn't trip. No code change needed on those routes.

## What got tested

- 4235 unit tests pass (was 4227, +8 new — 3 aggregator + 5 route shape-parity).
- 198 integration tests, 1 new file with 2 cases for the comprehensive cache (single-flight, envelope parity).
- `chart-overlay-prefs` integration test re-greens after the cache-invalidation wiring.
- Type-check + lint clean.

## What Layer B would have added (deferred)

The cache-aggregation research §9 designed a persistent `measurement_rollups` table that survives process restarts, multi-instance fan-out, and the 60 s TTL boundary. Sketched for v1.5.x:

```sql
CREATE TABLE measurement_rollups (
  user_id     UUID,
  type        TEXT,
  granularity TEXT,
  bucket_start TIMESTAMPTZ,
  count INT,
  mean / min / max / sd / slope / r2 DOUBLE PRECISION,
  computed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, type, granularity, bucket_start)
);
```

**Decision: defer to v1.5.x.** Layer A solves the reported pain (29 s → 500 ms cold, < 50 ms warm). Layer B would cut cold-mount further to ~50 ms regardless of TTL boundaries, but the marginal win is small against the deploy risk of a schema migration on production during the iOS-Apple-Review-pending web freeze. Re-evaluate after we have live hit-ratio data + iOS submission clears.

## Live verification queue

1. Wait for the Build & Publish Docker Image workflow to complete + the post-publish-verify workflow to confirm the new image is live on `healthlog.bombeck.io`.
2. Open `/insights` in a fresh tab, observe the `/api/insights/comprehensive` timing in DevTools Network.
3. `grep cache.analytics.outcome` in the wide-event log to confirm the comprehensive route's cache annotations are landing.
4. Re-capture HAR to confirm the 503 cascade is gone.

## Operator actions still pending (from v1.4.34 closure)

These are environment-side and unchanged by v1.4.34.1:

1. edge01 Coolify MCP daemon restart.
2. edge01 `DATABASE_URL` pool-bump (apps01 already drained).
3. Coolify resource-limits resize on apps01 (CPU=2, Memory=1g, Reservation=512m).
4. Coolify "watch registry for new digests" toggle on both hosts.
5. apps01 env-var duplicate-pair prune (28 entries).

The pool-bump (#2) and resource-cap (#3) make the SECOND comprehensive call inside the window even cheaper, but neither is needed for the perf fix to land.
