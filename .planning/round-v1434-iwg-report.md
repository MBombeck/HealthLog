# v1.4.34 IW-G — Server-Cache Implementation Report

## Summary

Shipped the in-process LRU + single-flight `ServerCache<T>` primitive
extending the v1.4.33 Coach snapshot LRU shape (`af17db5d`). Wired the
three hottest dashboard reads through it (`/api/analytics`,
`/api/gamification/achievements`,
`/api/medications/intake?scope=compliance`) and bolted per-user
invalidation onto every measurement / mood / medication / workout /
dashboard-widget / app-settings write endpoint per the blueprint §6
matrix. Observability annotations
(`cache.<name>.outcome` + `cache.<name>.key_hash`) reach the wide event
on every cached request so production logs carry the hit-ratio signal.

## Commits

Branch: `develop` → pushed.

| SHA | Title |
| --- | --- |
| `a5dd8e1d` | `feat(cache): server-side LRU primitive + per-user invalidation helpers` |
| `68c4bb73` | `perf(api): wire 3 hot read routes through the server cache` |
| `757387ca` | `feat(cache): wire 13 write endpoints to per-user invalidation helpers` |
| `bcdab48e` | `test(cache): integration coverage + CHANGELOG entry for server cache` |

## Files touched

New:

- `src/lib/cache/server-cache.ts` — `ServerCache<T>` class, 8-cache
  registry, `cached()` wrapper, `hashCacheKey()`, test reset hatch.
- `src/lib/cache/invalidate.ts` — 5 per-user helpers
  (`invalidateUserMeasurements/Mood/Medications/DashboardWidgets`,
  `invalidateAppSettings`).
- `src/lib/cache/__tests__/server-cache.test.ts` — 18 unit tests.
- `src/lib/cache/__tests__/invalidate.test.ts` — 5 helper tests.
- `tests/integration/server-cache-routes.test.ts` — 3 end-to-end tests
  (single-flight, measurement invalidation, intake invalidation).

Modified:

- `src/app/api/analytics/route.ts` — wraps slim + default slice.
- `src/app/api/gamification/achievements/route.ts` — wraps web result.
- `src/app/api/medications/intake/route.ts` — wraps compliance branch
  + invalidation on POST.
- 11 write endpoints across `measurements*`, `mood-entries*`,
  `medications*`, `workouts/batch`, `dashboard/widgets`,
  `admin/settings` — `invalidateUser*` call after DB commit.
- 4 existing test files — `__resetAllCachesForTests()` in `beforeEach`
  so re-using a fixed userId doesn't carry cached state across cases.
- `CHANGELOG.md` — one Added line in Marc-voice English.

## Observability pattern

Every `cached()` invocation passes `annotate` from
`@/lib/logging/context` as the optional fourth argument:

```ts
const body = await cached(
  caches.analytics as ServerCache<...>,
  `${user.id}|default`,
  () => buildAnalyticsResponse(user),
  annotate,
);
```

On the wide event, every cached request now carries:

- `cache.<name>.outcome` ∈ `{ "hit" | "miss" | "stampede" }`
- `cache.<name>.key_hash` — non-reversible djb2 32-bit hash of the
  cache key

Witnessed live in the integration run; sample log line:

```json
{
  "meta": {
    "cache.medicationsIntake.outcome": "miss",
    "cache.medicationsIntake.key_hash": 3630666302,
    "days": 30,
    "count": 30
  },
  "action": { "name": "medications.intake.compliance" }
}
```

Ops can `grep cache.analytics.outcome` to compute hit ratio per
deployment over any time window.

## Quality gates

- `pnpm exec tsc --noEmit` clean.
- `pnpm test` — 4227 pass, 1 skipped (no new failures).
- `pnpm test:integration` — 196 pass (49 files); the 3 new
  `server-cache-routes.test.ts` cases included.
- `pnpm lint` clean on every touched src/ file. The 190 unrelated
  errors live in `playwright-report/*.js` (generated artifacts).

## Estimated wall-time speedup (warm cache)

Pulled from blueprint §2 + the v1.4.33 prod-slowness HAR
(`.planning/round-v1434-prod-slowness-investigation.md`):

| Route | Cold (pre-cache) | Warm hit | Speedup |
| --- | --- | --- | --- |
| `/api/analytics` (thick) | ~5.0 s | ~5 ms | ~1000× |
| `/api/analytics` (slim) | ~3.0 s | ~5 ms | ~600× |
| `/api/gamification/achievements` | ~3.2 s × 2 (duplicate) | ~5 ms × 2 | ~640× + dedup |
| `/api/medications/intake?compliance` | ~3.0 s | ~5 ms | ~600× |

Cumulative dashboard wait — pre-cache the three hot routes summed to
~14 s of server-side tail; on a warm cache the total drops to
~15-30 ms of `Map.get()` + JSON return. The duplicate
achievements mount the HAR flagged collapses through the single-flight
`pending` map so even cold cache benefits when two consumers race.

## Risks accepted

- **Process-local cache.** Multi-instance Coolify deploys will keep
  each container's cache isolated; a write on instance A leaves
  instance B serving the prior payload for up to TTL. Documented in
  the blueprint §4 and tolerated for v1.4.34 — the Redis migration
  remains the v1.5.x option.

- **Hard TTL stampede window.** Soft-TTL deferred per blueprint §7;
  the unit + integration tests don't yet exercise the
  multi-microsecond race window past the expiresAt boundary. We ship
  hard TTL and add SWR-style soft-TTL only if telemetry shows real
  contention.

- **Memory ceiling.** Each cache caps at 500-1000 entries × ~5 KB; the
  worst case across all eight registered caches lands at ~40 MB —
  well inside the Coolify 512 MB container budget per the blueprint
  §4 sizing.

## What stayed off-limits

Per the scope-fence:

- `src/middleware.ts` — AASA bypass unchanged.
- `src/components/**` — IW-B/D/F-Perf untouched.
- `src/app/page.tsx`, `src/app/settings/**` — IW-B / IW-D unchanged.
- `src/app/api/import/**` + `prisma/schema.prisma` ImportJob — IW-XML
  unchanged.
- `src/lib/analytics/compliance.ts` — IW-C unchanged.
- `next.config.ts`, `src/lib/http/cache-headers.ts` — IW-A unchanged
  (cache-headers read-only).
- `src/lib/ai/coach/snapshot.ts` — left in place per blueprint §12
  acceptance criteria (the snapshot LRU migration is a v1.4.35
  follow-up).

Disjoint paths with IW-E close-out; no merge conflict expected.
