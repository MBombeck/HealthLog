# v1.4.34 R-Cache — Server-Side Aggregation Cache Blueprint

Status: research handoff for IW-G (implementation).
Scope: in-process LRU layer in front of the slow-tail GET routes the
v1.4.33 HAR capture flagged.
Companion docs: `.planning/round-v1433-audit-perf.md` (§3.3 motivated
the Coach snapshot LRU), `.planning/round-v1434-prod-slowness-
investigation.md` (HAR + pool-starvation reading).

## 1. Brief

The dashboard mount fans out to eight Prisma-bound GET routes in
parallel. Even with pool starvation fixed, each route still pays its
own row-walk on every load. The Coach snapshot LRU we shipped in
v1.4.33 (`src/lib/ai/coach/snapshot.ts:292–336`, commit `af17db5d`) is
the proven pattern: a hand-rolled `Map<string, { expiresAt, result }>`,
LRU-touched on read, hard-capped on insert, 60 s TTL, keyed on
`(userId, scope)`. Extending that pattern to the high-cost analytics
routes converts the dashboard wait from "fast because Postgres
answered fast" to "fast because the answer was already in RAM". The
two layers compose — a cold cache still benefits from a healthy pool,
a warm cache bypasses the pool entirely.

This document is the design IW-G can implement from directly. It
covers the cache key shape per route, the storage primitive, the
invalidation matrix tying every write endpoint to its evictions, the
helper API, single-flight, observability, and the migration path to a
triggered rollup table in v1.5.x.

## 2. Top three routes by speedup × ease

1. `/api/analytics` (thick + slim, 7.99 s combined cost on dashboard
   mount). Pure read of persisted measurements + a fixed-shape
   aggregation. Cache the route response keyed on
   `(userId, slice)`. Expected hit ratio on the dashboard re-mount
   loop is high — the dashboard root, the checklist mount, and the
   advisor all read the same payload. Even one hit per second of
   active session amortises the 5 s tail across every subsequent
   render.
2. `/api/gamification/achievements` (3.18 s × 2 on the same load).
   The route resolves achievement progress against the same metric
   snapshot every consumer needs. Two-cell duplicate today (per
   prod-slowness investigation §4) — caching by `userId` collapses
   the duplicate **and** every dashboard re-mount.
3. `/api/medications/intake?scope=compliance&days=30` (3.00 s).
   Pre-aggregated daily compliance — by definition slow-changing
   inside a 24 h window. Long TTL candidate (15 min) because intake
   events trickle in throughout the day but yesterday's row never
   moves.

These three convert ~14 s of dashboard cumulative wait time into
~150 ms of `Map.get()` + JSON return on a warm cache. Ease comes from
the routes already being pure reads with a clear `(userId, params)`
key — no auth-side-effect entanglement, no cross-user leakage risk.

Storage pick: hand-rolled `Map`-based LRU per route, in-process. Same
pattern as the snapshot cache, no new dependency. `lru-cache` is not
currently in the dependency tree — adding it for ~120 lines of
infrastructure isn't worth the supply-chain surface. The hand-rolled
shape ships in `src/lib/cache/server-cache.ts` and stays well below
that line count.

Invalidation: tag-based, per-user. Every write endpoint that touches
a measurement / mood / medication row calls one of three helpers —
`invalidateUserMeasurements(userId)`, `invalidateUserMood(userId)`,
`invalidateUserMedications(userId)` — and the helpers walk the cache
maps and delete every key whose `userId` prefix matches. We do not
try to do partial-key eviction (slice-specific or window-specific) on
write; flushing the whole user-bucket is the safe default and the
re-fill on the next read is still cheap because Prisma's pool is fast
under non-burst load.

## 3. Routes in scope — per-route cache contract

| Route | Key shape | Value | TTL | Bucket |
| --- | --- | --- | --- | --- |
| `/api/analytics` | `${userId}\|${slice ?? "thick"}` | full JSON response body | 60 s | measurements |
| `/api/medications` | `${userId}` | full JSON response body | 60 s | medications |
| `/api/gamification/achievements` | `${userId}` | full JSON response body | 60 s | measurements ∪ medications |
| `/api/dashboard/widgets` | `${userId}` | full JSON response body | 5 min | dashboard-layout |
| `/api/bugreport/status` | `singleton` (no userId — the row is global) | `{ configured, enabled, isAdmin }` per role-tier | 10 min | app-settings |
| `/api/workouts?limit=N` | `${userId}\|${limit}\|${offset}\|${since}\|${until}\|${sportType}` | full JSON response body | 60 s | workouts |
| `/api/medications/intake?scope=compliance&days=N` | `${userId}\|compliance\|${days}` | full JSON response body | 15 min | medications |
| `/api/mood/analytics` | `${userId}` | full JSON response body | 60 s | mood |

Notes per row:

- `bugreport/status` is the outlier — the data is global app settings
  (GitHub-token presence, enabled flag) gated on user role. Cache the
  raw `(configured, enabled)` shape by the constant `"singleton"`
  key, then layer `isAdmin` from the request's user on top. Eviction
  is `invalidateAppSettings()` called from the `PATCH /api/admin/
  app-settings` handler.
- `medications/intake?scope=today` is **not** cached. The "today"
  view changes every time the user marks a dose taken — the cache
  would either be racy or have a near-zero TTL anyway. Compliance
  (`scope=compliance&days=30`) is the cached variant; today's view
  reads through.
- `workouts?limit=3` is the dashboard hot-spot. Other workout queries
  (`/insights/workouts` with high limits, the iOS app draining
  history) share the same cache but with their own keys — they
  rarely hit the dashboard's `limit=3` slot, so the cache stays
  segmented naturally.

We **don't** negative-cache 404 / 422. The Coach snapshot pattern
returns a real object on every successful path; 404 / 422 means the
auth gate, the param validator, or the rate limiter rejected the
request before any read. Caching the rejection would mean a follow-up
write would have to know to evict it, and the slow-tail risk doesn't
exist here — a 422 returns in single-digit milliseconds.

## 4. Storage primitive

`src/lib/cache/server-cache.ts` ships one class:

```ts
class ServerCache<T> {
  private readonly map = new Map<string, { expiresAt: number; value: T }>();
  private readonly pending = new Map<string, Promise<T>>();
  constructor(private readonly opts: { maxEntries: number; ttlMs: number }) {}
  // get(key) — null on miss / expired
  // set(key, value) — evicts oldest if over capacity
  // delete(key) — single-key eviction
  // deleteByPrefix(prefix) — bulk eviction (the userId-prefix path)
  // wrap(key, builder) — read-through + single-flight
}
```

`wrap()` is the only public read path. Its contract:

1. If `map.get(key)` returns a non-expired entry, touch (delete +
   re-insert moves the key to the end of the `Map`'s insertion order,
   which is the LRU end), return `value`.
2. Else if `pending.get(key)` exists, await it. A second caller for
   the same key inside the build window does **not** start a second
   build — this is the single-flight guarantee.
3. Else: call `builder()`, register the in-flight promise on
   `pending`, on resolve `set(key, value)` and delete from `pending`,
   on reject delete from `pending` (so the next caller retries).

Per-route eviction caps: 1000 entries each. At ~5 KB per
analytics response and 8 cached routes, the theoretical worst case
is ~40 MB for 50 active users × 10 routes × 5 KB — well inside the
Coolify container memory budget. The 1000-entry cap is a
single-process limit; LRU eviction makes the real working set track
the active-user count.

Memory pressure mitigation: each `ServerCache<T>` instance lives in
module-scope; the `Map` is bounded by `maxEntries`; when the cap is
hit we evict the oldest entry by deleting `map.keys().next().value`.
Same recipe as `src/lib/ai/coach/snapshot.ts:319–325`.

The cache is process-local. Coolify currently runs a single
`apps-01` container per deployment, so all traffic lands in the same
process. If a future deploy moves to multi-instance (horizontal
scale-out behind a load balancer), each instance keeps its own cache;
writes from instance A do not evict reads on instance B. We accept
that trade today — the cost is "instance B serves the pre-write value
for up to TTL after a write" which is bounded and not silent
(provenance + cache-key hash logged on every response). The Redis
migration path is sketched in §7.

## 5. Helper API

```ts
// src/lib/cache/server-cache.ts
export const caches = {
  analytics:        new ServerCache<unknown>({ maxEntries: 1000, ttlMs:    60_000 }),
  medications:      new ServerCache<unknown>({ maxEntries: 1000, ttlMs:    60_000 }),
  achievements:     new ServerCache<unknown>({ maxEntries: 1000, ttlMs:    60_000 }),
  dashboardWidgets: new ServerCache<unknown>({ maxEntries:  500, ttlMs:   300_000 }),
  bugreportStatus:  new ServerCache<unknown>({ maxEntries:   10, ttlMs:   600_000 }),
  workouts:         new ServerCache<unknown>({ maxEntries: 1000, ttlMs:    60_000 }),
  medicationsIntake:new ServerCache<unknown>({ maxEntries: 1000, ttlMs:   900_000 }),
  moodAnalytics:    new ServerCache<unknown>({ maxEntries: 1000, ttlMs:    60_000 }),
};

export async function cached<T>(
  cache: ServerCache<T>,
  key: string,
  builder: () => Promise<T>,
): Promise<T> {
  return cache.wrap(key, builder);
}

// Bulk eviction — by user, optionally narrowed to one cache.
export function invalidateUserMeasurements(userId: string): void {
  caches.analytics.deleteByPrefix(`${userId}|`);
  caches.achievements.deleteByPrefix(`${userId}`);
  caches.workouts.deleteByPrefix(`${userId}|`);
  // mood-analytics is invalidated separately because mood writes are
  // a different write surface and we don't want to over-evict.
}
export function invalidateUserMood(userId: string): void {
  caches.moodAnalytics.deleteByPrefix(`${userId}`);
  caches.achievements.deleteByPrefix(`${userId}`);
  caches.analytics.deleteByPrefix(`${userId}|`);
}
export function invalidateUserMedications(userId: string): void {
  caches.medications.deleteByPrefix(`${userId}`);
  caches.medicationsIntake.deleteByPrefix(`${userId}|`);
  caches.achievements.deleteByPrefix(`${userId}`);
}
export function invalidateUserDashboardWidgets(userId: string): void {
  caches.dashboardWidgets.deleteByPrefix(`${userId}`);
}
export function invalidateAppSettings(): void {
  caches.bugreportStatus.deleteByPrefix("");
}
```

Each route handler wraps its body. Example for `/api/analytics`:

```ts
const data = await cached(
  caches.analytics,
  `${user.id}|${slice ?? "thick"}`,
  () => buildAnalyticsResponse(user.id, slice, userTz),
);
return apiSuccess(data);
```

The route function carrying the actual aggregation moves into
`buildAnalyticsResponse()`. The route stays the cache miss / hit
boundary. The wrap matches the snapshot pattern's two-function shape
(`buildCoachSnapshot` → `buildCoachSnapshotImpl`).

## 6. Invalidation matrix

Every write endpoint calls the appropriate `invalidateUser*` helper
**after** its successful database commit, **before** the response is
returned. The helpers are cheap (`Map.delete` over a bounded prefix
scan); we accept the minor latency penalty on writes to keep reads
consistent. Failure to invalidate poisons the cache for one TTL
cycle, which is exactly the failure mode the snapshot pattern
already accepts.

| Write endpoint | Invalidations |
| --- | --- |
| `POST /api/measurements` | `invalidateUserMeasurements(userId)` |
| `POST /api/measurements/batch` | `invalidateUserMeasurements(userId)` |
| `PUT /api/measurements/[id]` | `invalidateUserMeasurements(userId)` |
| `DELETE /api/measurements/[id]` | `invalidateUserMeasurements(userId)` |
| `DELETE /api/measurements/by-external-ids` | `invalidateUserMeasurements(userId)` |
| `POST /api/mood-entries` | `invalidateUserMood(userId)` |
| `PATCH /api/mood-entries/[id]` | `invalidateUserMood(userId)` |
| `DELETE /api/mood-entries/[id]` | `invalidateUserMood(userId)` |
| `POST /api/mood-entries/bulk` | `invalidateUserMood(userId)` |
| `POST /api/medications` | `invalidateUserMedications(userId)` |
| `PUT /api/medications/[id]` | `invalidateUserMedications(userId)` |
| `DELETE /api/medications/[id]` | `invalidateUserMedications(userId)` |
| `POST /api/medications/intake` (status update) | `invalidateUserMedications(userId)` |
| `POST /api/workouts/batch` | `invalidateUserMeasurements(userId)` (workouts cache rides on the measurements bucket because achievements / analytics both read workouts) |
| `PUT /api/dashboard/widgets` | `invalidateUserDashboardWidgets(userId)` |
| `DELETE /api/dashboard/widgets` | `invalidateUserDashboardWidgets(userId)` |
| `PATCH /api/admin/app-settings` (bugreport-config toggle) | `invalidateAppSettings()` |

A new measurement write touches the analytics aggregate, the
achievement progress, and possibly the workouts dashboard tile (if
the measurement is a workout-linked metric). That's why the
`invalidateUserMeasurements` helper evicts three caches at once
rather than just one. The conservative "evict the whole user-bucket"
matches Marc's "blazing fast" stance — a redundant eviction costs the
next reader one cache miss (cheap, the row's already paginated), an
under-eviction shows stale data which is the directive's failure
mode.

## 7. Single-flight + cache stampede

Two concurrent dashboard mounts (two browser tabs, both with cold
cache, both fetching `/api/analytics` in the same second) would
otherwise issue two builders. The `pending` map in the storage
primitive coalesces these: tab B awaits tab A's in-flight promise
and gets the same response. This is the standard single-flight /
deduplication pattern.

Cache stampede on TTL expiry: when the cached entry expires at
second 60.000 and three requests land at second 60.001, the first
request through the `wrap()` call kicks off a fresh build; requests
two and three see no live entry yet (it's about to be set) **but**
also see no pending promise yet — there's a race window of a few
microseconds. Mitigation (deferred — not part of IW-G unless the
metrics show it's needed): **soft-TTL**. Keep the entry available
past `expiresAt` for one additional refresh window; mark it stale on
read and trigger a background rebuild for the first reader past the
soft-TTL; subsequent readers in the next 1 s window serve the stale
entry. This is the standard SWR-server pattern. For v1.4.34 we ship
the hard-TTL variant (cleaner semantics, simpler tests) and add
soft-TTL only if telemetry shows real stampedes.

## 8. Observability

Every cache hit / miss is annotated on the active wide-event
builder:

```ts
const event = getEvent();
event?.addMeta("cache.analytics.outcome", hit ? "hit" : "miss");
event?.addMeta("cache.analytics.key_hash", djb2(key));
```

The `key_hash` is a non-reversible 32-bit hash so we can correlate
hits without leaking userId into logs. We aggregate hit ratio per
route in the existing wide-event dashboard. The audit-log surface
already accepts arbitrary `meta` keys, so no schema change is
needed.

Per-test reset escape hatch: every `ServerCache<T>` exposes
`__resetForTests()` (matches `__resetCoachSnapshotCacheForTests` in
the snapshot pattern). Vitest setup in `vitest.config.mts` adds an
afterEach that clears all caches, identical to how the snapshot
tests handle it (`src/lib/ai/coach/__tests__/snapshot.test.ts`).

## 9. Comparison to the v1.5.x triggered-rollup table

The LRU layer is the right pick for v1.4.34: it's a single file, ships
behind a proven pattern, no schema change, no migration risk. It
trades correctness-on-write for read speed in exchange for an
aggressive invalidation policy — that's the same trade the Coach
snapshot LRU made.

A v1.5.x triggered rollup table — proposed schema sketch:

```sql
CREATE TABLE measurement_rollups (
  user_id   UUID NOT NULL,
  type      TEXT NOT NULL,
  window    TEXT NOT NULL,                -- '7d' / '30d' / '90d'
  day_key   DATE NOT NULL,                -- bucket anchor
  count     INT  NOT NULL,
  mean      DOUBLE PRECISION,
  min_val   DOUBLE PRECISION,
  max_val   DOUBLE PRECISION,
  sd        DOUBLE PRECISION,
  slope     DOUBLE PRECISION,
  r2        DOUBLE PRECISION,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type, window, day_key)
);
CREATE INDEX ON measurement_rollups (user_id, type, window);
```

Update path: a Postgres `AFTER INSERT/UPDATE/DELETE` trigger on
`Measurement` enqueues a recompute for the affected `(userId, type,
day_key)`. The recompute is a single SQL upsert per metric, runs in
the pg-boss worker (already deployed for reminder fan-out — see
`src/lib/jobs/reminder-worker.ts`), and is bounded by the number of
distinct types the write touched (typically 1–3 per measurement).
Reads from `/api/analytics` then bypass the row walk entirely and
join against the pre-computed rollup table.

Pros (rollup vs LRU):
- Survives process restarts and multi-instance deploys.
- Cross-user fan-out queries (the v1.5 admin analytics surface) can
  read directly without per-user warmup.
- Read latency drops to a single indexed lookup regardless of cache
  state.

Cons (rollup vs LRU):
- Migration introduces a new table + indexes + background worker
  contract.
- The trigger fan-out is one more thing to monitor; a stuck pg-boss
  queue leaves rollups stale (silent if not alarmed).
- Storage cost grows with measurement volume × window-count × day-
  count.

Migration path:
1. v1.4.34 — ship LRU. Land observability so we can read hit ratio
   in production.
2. v1.5.x — introduce `measurement_rollups` additively behind the
   feature flag `analytics-rollups-table`. Reads continue to land in
   the LRU; the rollup table is populated by the trigger but not
   queried.
3. v1.5.x+1 — flip the flag for one user, dual-read both paths,
   diff. When the diff is zero over 10 000 reads we cut over to the
   rollup table for that user.
4. v1.5.x+2 — promote to a single feature flag flip, deprecate the
   LRU. Keep the LRU code path as the fallback for users still on
   the legacy flag during the transition window.

## 10. Risks + mitigations

| Risk | Mitigation |
| --- | --- |
| Stale data after a write | Every write endpoint calls `invalidateUser*`. Documented in §6. The penalty for missing one is one TTL window of stale reads, not silent corruption. The pre-release checklist for v1.4.34 includes a grep gate that lists every `POST/PUT/PATCH/DELETE` handler under `/api/(measurements\|mood-entries\|medications\|workouts)` and verifies each contains an `invalidateUser*` call. |
| Multi-instance Coolify | Documented and accepted. Each instance keeps its own cache; writes don't cross-evict. The TTL bounds the staleness. Plan Redis as a v1.5.x option when the rollup table is also on the roadmap — the two together close the gap. |
| Memory pressure | Per-cache `maxEntries` cap, LRU eviction on overflow. Worst case 40 MB across all caches on the current Coolify container's 512 MB budget. |
| Cache stampede on TTL expiry | Single-flight via the `pending` map. Soft-TTL is a deferred follow-up if telemetry shows we need it. |
| Per-test pollution | `__resetForTests()` on every `ServerCache<T>` + vitest afterEach. Same recipe the snapshot tests already use. |
| Auth-side-effect entanglement | The cache key includes `userId`. The `bugreport/status` endpoint is the exception (singleton key with per-user layering); the doc here calls it out explicitly. Auth always runs before the cache `wrap()` so a stolen request that bypasses auth would not reach the cache. |
| Wide-event log growth | The hit / miss annotation reuses the existing `addMeta` carrier, two keys per request. No new log volume class. |

## 11. Implementation checklist (for IW-G)

1. Land `src/lib/cache/server-cache.ts` with the `ServerCache<T>`
   primitive, the eight `caches.*` instances, the four
   `invalidateUser*` helpers, the `invalidateAppSettings()` helper,
   and the `cached()` wrapper. Unit-test the primitive — LRU
   ordering, TTL, single-flight, prefix delete.
2. Wrap each route in §3 — `/api/analytics` first (highest payoff),
   then the rest in any order. Each wrap is two lines of edit.
3. Add `invalidateUser*` calls to every write endpoint in §6. Run
   the grep gate as part of the pre-release checklist.
4. Wire the `addMeta("cache.<name>.outcome", …)` annotations into
   each `cached()` call. Single helper that branches on hit vs miss.
5. Add integration tests for the read-through path: prime the cache,
   write through the matching write endpoint, assert the next read
   misses (i.e. the invalidation worked).
6. Document the cache in `docs/audit/v1434-summary.md` once IW-G
   merges.

## 12. Acceptance criteria

- All eight routes in §3 wrap their handler body through `cached()`.
- All write endpoints in §6 carry the matching `invalidateUser*`
  call.
- Unit tests cover LRU ordering, TTL, prefix-delete, single-flight.
- Integration test: dashboard mount with warm cache resolves
  `/api/analytics` in < 50 ms. With cold cache, parity with the
  pre-cache p95.
- `cache.<name>.outcome` annotations land on every request to a
  cached route. Dashboard hit-ratio query returns within seconds.
- No regression in the snapshot LRU (`buildCoachSnapshot`) — IW-G
  must not refactor it under the new primitive in the same wave.
  The migration is a v1.4.35 follow-up.

End of brief. IW-G can implement directly from this file. Any
ambiguity defaults to "match the v1.4.33 snapshot LRU shape" since
that is the proven pattern this design extends.
