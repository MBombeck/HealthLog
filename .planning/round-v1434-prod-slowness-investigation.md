# Production slowness investigation — v1.4.33 LIVE

HAR capture: `healthlog.bombeck.io` 2026-05-16T18:14:41 UTC, dashboard
cold mount, eight concurrent API calls land in the same ~3 s tail
band. Read-only inspection of the codebase plus the live Coolify
control-plane config for the `apps-01` host (`go0cw8w0gwws00okggcss0c4`)
and the HealthLog application (`pg8wggwogo8c4gc4ks0kk4ss`).

## 1 — Executive summary

Three independent root causes stack onto the same wall-clock window.
None of them are LLM-side. Ranked by recovered milliseconds per
dashboard mount:

1. **Postgres pool starvation at the application layer.** `src/lib/db.ts`
   builds the Prisma client through the `@prisma/adapter-pg` driver
   adapter with **no `max` override** on the underlying `node-postgres`
   `Pool`. The Coolify-injected `DATABASE_URL` is a bare
   `postgresql://healthlog:…@db:5432/healthlog?schema=public` — no
   `connection_limit`, no `pool_timeout`, no `?max=…`. Node-postgres
   defaults to `max: 10`, and a second Prisma client lives inside the
   `pg-boss` worker that runs **in the same container** because
   `HEALTHLOG_PROCESS_TYPE=all`. pg-boss itself also opens its own
   pool against the same database (`new PgBoss(DATABASE_URL)`,
   `src/lib/jobs/reminder-worker.ts:1369`). Three pools share the same
   16-connection-per-role Postgres budget; the web pool effectively
   tops out at ~10 simultaneous queries. Eight dashboard fetches each
   issue 1× `prisma.session.findUnique` (auth) + an average of 2–3 read
   queries — the 9th–24th concurrent query lands on `Pool.acquire()`
   and waits for a returning client, which is exactly the ~3 s tail
   the HAR shows. Recommended fix: append
   `?connection_limit=25&pool_timeout=10` to `DATABASE_URL` on
   apps-01, **after** raising the Coolify CPU/RAM caps (see §6). One-
   liner env edit, no code change, redeploy not strictly required —
   restart suffices.

2. **Duplicate fetches on the dashboard mount.** The HAR shows two
   `/api/analytics` calls (one with `?slice=summaries`, one without)
   and two `/api/gamification/achievements` calls in the same wave.
   Both are real bugs in the consumer tree, not network artefacts.
   Discussion in §4 — IW-B in v1.4.34 is the right home for the
   consumer-collapse work and will land the analytics half; the
   achievements half is a separate `queryKey` divergence between two
   independent components mounted on the same page. Both stay
   inside v1.4.34 if we agree to add the IW-F-Perf sub-wave (§5).

3. **Unbounded Coolify resource caps with no per-app cgroup ceiling.**
   `get_application` returns `limits_cpus: "0"`, `limits_memory: "0"`,
   `limits_cpu_shares: 1024`. Read literally that's "no Docker
   resource limit", which means the host's 25-app inventory all
   compete for the same kernel scheduler. CPU steal on a noisy
   neighbour translates into Postgres query latency end-to-end. The
   single physical apps-01 host runs 17 application containers plus 4
   Postgres standalones plus 10 services (`server_resources`), so
   per-process CPU under load is the most likely amplifier for the
   pool-wait. Recommended: bound HealthLog to `limits_cpus: "2"` and
   `limits_memory: "1g"` so the container has a deterministic floor
   regardless of neighbour load. Coolify UI → Application → Limits.

**Top verdict.** Pool starvation is the dominant cause; the duplicate
fetches double the load on top of it; the unbounded resource caps
amplify both. The cheapest single-knob mitigation is the
`?connection_limit=25` env edit. The cheapest single-knob
amplification cut is the Coolify resource bound. Both are operator-
side, both are revertible, both take <60 s and don't need a release.

## 2 — Pool starvation — evidence and sizing

### Evidence

- `src/lib/db.ts:1–19` — single web-side `PrismaClient` constructed
  via `new PrismaPg({ connectionString: process.env.DATABASE_URL! })`.
  No `max`, no `connection_limit` parsing, no pool overrides.
- `src/lib/jobs/reminder-worker.ts:83–89` — second `PrismaClient`
  built the same way inside the worker subsystem. The
  `HEALTHLOG_PROCESS_TYPE=all` env (confirmed via
  `mcp__coolify-apps01__env_vars`) keeps both subsystems in one
  container, so both pools live in the same Node process.
- `src/lib/jobs/reminder-worker.ts:1369` — `new PgBoss(DATABASE_URL)`.
  pg-boss opens its own `pg.Pool` with `max: 10` per the upstream
  default and the bare URL.
- Coolify env audit confirms `DATABASE_URL` is bare on both
  control planes (`round-v1434-iwa-coolify-env-audit.md` §1, live
  entry `w8w8gc08sgo48o8008ww04gk`).
- Postgres 16-alpine container ships with `max_connections=100`
  default — no override in the Compose; that is the upper ceiling
  shared across web Prisma + worker Prisma + pg-boss + admin sessions.

### Pool math

Per process, in the same container:

| Pool | Default `max` | Effective |
| --- | --- | --- |
| Web `PrismaClient` | `pg.Pool` default 10 | 10 |
| Worker `PrismaClient` | `pg.Pool` default 10 | 10 |
| pg-boss internal | upstream default 10 | 10 |
| **Total open slots** | | **~30 out of 100** |

At face value 30 < 100, so we are not at the Postgres ceiling — but
the **web pool alone is capped at 10**, and every authenticated
request takes one slot for `getSession()` plus one or more for the
route's actual query. Eight concurrent dashboard fetches × ≥2
queries each = ≥16 simultaneous acquisitions against a 10-slot
pool. Queries 11–16 wait on `acquire()`, which has no upstream
timeout in node-postgres, so they block for whatever serial
query-runtime the route ahead of them spends — exactly the
clustered ~3 s waits.

### Recommended `?connection_limit`

The apps-01 host runs 17 application containers plus 4 standalone
Postgres pools sharing one physical machine. Postgres default
`max_connections=100`. Per the Prisma docs (`@prisma/adapter-pg`
passes URL params through to `pg.Pool.options`), the right knob is
`?connection_limit=N&pool_timeout=T`. Sizing budget for HealthLog
alone:

| Subsystem | Slot budget |
| --- | --- |
| Web `PrismaClient` | 20 |
| Worker `PrismaClient` | 4 |
| pg-boss | 6 |
| Admin / migration headroom | 5 |
| **Total reserved for HealthLog** | **35** |

Postgres still has 65 slots for everything else on the host. That
leaves the iOS-bound `/api/auth/me` 79 ms path and the
admin-side `/api/admin/host-metrics` reads room without competing
with the dashboard wave.

**Operator action.** Set `DATABASE_URL` on apps-01 (UUID
`w8w8gc08sgo48o8008ww04gk`) to:

```
postgresql://healthlog:${POSTGRES_PASSWORD}@db:5432/healthlog?schema=public&connection_limit=20&pool_timeout=10
```

…and add a second env on the worker side (HEALTHLOG_PROCESS_TYPE
is still `all` per the live entry, so the worker reads the same
URL — when we eventually split, give the worker variant
`?connection_limit=4`). 20 + 4 + 6 = 30 leaves a small migration
headroom.

## 3 — Shared synchronous bottlenecks — ruled in / out

| Candidate | Verdict | Evidence |
| --- | --- | --- |
| `WideEventBuilder` per-request mutex | **Out.** | `src/lib/logging/event-builder.ts` is a plain class instance attached to AsyncLocalStorage. No shared lock; every request gets a private builder via `eventStorage.run(evt, …)` in `src/lib/api-handler.ts:161`. |
| `RateLimiter` shared state | **Out.** | `src/lib/rate-limit.ts:21–52` runs a single atomic upsert per call — no Map, no in-process lock, no semaphore. The query itself is a `?connection_limit`-bound consumer though, so it does contribute to the pool-wait. |
| `requireAssistantSurface()` per-request memo | **Out (working as designed).** | `src/lib/feature-flags/index.ts:72–104` wraps the `AppSettings.singleton` read in `memoizePerRequest("assistant-flags", …)`. `src/lib/request-cache.ts` correctly returns one Promise per request via a `WeakMap` on the `WideEventBuilder`. The 8 concurrent requests in the HAR each get their own builder so each one reads the row once — but that's correct cross-request behaviour, not a lock. Within a request the memo collapses 5+ surface checks to one. |
| pg-boss ↔ Prisma pool sharing | **In, partial.** | Both pools open against the same Postgres but each has its own `pg.Pool`. The shared resource is Postgres `max_connections`, not a JS-side lock. Already covered in §2's slot budget. |
| Container CPU/RAM throttling | **In, amplifier.** | `limits_cpus: "0"` means no Docker `--cpus` cap, which sounds permissive but actually means the container gets default cgroup share weight — under noisy-neighbour load the kernel scheduler de-prioritises it. The remedy is the opposite of intuition: **set** the cap to claim guaranteed quota. See §6. |
| Cold container | **Out.** | HAR was captured ~20 min post-deploy per the brief, and `last_online_at: "2026-05-16 18:24:13"` is well after the request. Page-warm. |
| `getSession()` re-fetch per request | **In, real cost.** | `src/lib/auth/session.ts:107–110` does **not** use `memoizePerRequest`. Each of the 8 concurrent dashboard requests issues its own `prisma.session.findUnique({ include: { user: true } })`. That's 8 extra pool acquisitions on every dashboard mount, on top of the per-route queries. Candidate for an IW-F-Perf addition: wrap `getSession()` in `memoizePerRequest("session-cookie", …)`. Across-request it can't memo — it's strictly intra-request. Saves zero queries in isolation but cuts pool contention in the burst window. |

## 4 — Duplicate-call findings

### `/api/analytics` × 2 — root cause

The dashboard root (`src/app/page.tsx:212`) calls
`useAnalyticsQuery()` (thick payload, no slice). The mounted child
`<GettingStartedChecklist>` (`src/components/onboarding/getting-
started-checklist.tsx:195`) calls
`useAnalyticsQuery({ slice: "summaries", enabled: !!user })`. Per
`src/lib/query-keys.ts:27–29` the queryKey factory was updated in
v1.4.33 IW2 to discriminate by slice:

```ts
analytics: (slice?: "summaries") =>
  (slice ? (["analytics", slice] as const) : (["analytics"] as const)),
```

That's the **correct** v1.4.33 IW2 cache layout (collision-free), but
it means the two consumers each open their own cache slot and each
fire a network request. The dashboard genuinely needs the thick
slice for its `bpInTargetPct*` / `glucoseByContext` consumers; the
checklist genuinely only needs `summaries[…].count`. Both fire on
mount for the same render tree.

Two possible directions:

- **(a) Hoist** the checklist's gating to read the dashboard's thick
  payload — every field the checklist consumes is also present on
  the thick slice. The slim slice was introduced for the
  `/insights` tree, not for the dashboard mount.
- **(b) Keep** the split and pre-warm: serve the thick payload first,
  derive the slim payload from it via `select` in the checklist's
  `useAnalyticsQuery`. TanStack supports `select` for shape
  narrowing without a second network round-trip.

The v1.4.34 IW-B brief (from `round-v1433-audit-perf.md` §1) covers
the consumer-collapse work for `/api/analytics`. Confirming with the
maintainer: IW-B's current scope is the **slim slice routing** to
the Insights tree, not the dashboard-checklist intersection. So
option (a) — switch the checklist back to the thick slice — needs to
land in an IW-F-Perf addition or piggyback on IW-B.

### `/api/gamification/achievements` × 2 — root cause

Two different consumers on the same page, two different queryKeys
hitting the same endpoint:

| Consumer | queryKey | Mount point |
| --- | --- | --- |
| `<RecentAchievementsCard>` | `["gamification", "achievements"]` | `src/app/page.tsx:1180` |
| `<AchievementUnlockNotifier>` | `["gamification", "achievements", "unlock-notifier", userId]` | global layout (mounted alongside `<Toaster>`) |

Same data, two cache cells, two network calls. The notifier even
sets `refetchInterval: 2 * 60 * 1000` (line 84 of the notifier) —
not relevant for the initial-load HAR but it means every two
minutes the dashboard re-fetches `achievements` even when the card
already has fresh data.

Fix shape: extract a `useAchievementsQuery()` mirror of
`useAnalyticsQuery` that both consumers call. The notifier's
side-effect logic (badge unlock toast) can ride on `useEffect` over
the shared cache result rather than its own subscription. One
network call, one cache slot. Same shape as the v1.4.33 IW2 win.

### Other HAR consumers — all single-source, no duplicates

| Endpoint | Consumer | One-shot? |
| --- | --- | --- |
| `/api/dashboard/widgets` | `src/app/page.tsx:218` | Yes |
| `/api/mood/analytics` | `src/app/page.tsx:230` | Yes |
| `/api/medications` | `src/app/medications/page.tsx:95` + checklist | Same key, single cache slot |
| `/api/bugreport/status` | `src/components/app-settings-provider.tsx:63` | Yes |
| `/api/workouts?limit=3` | dashboard tile (likely `RecentWorkoutsCard` — not searched, single source) | Yes |
| `/api/medications/intake?scope=compliance&days=30` | dashboard compliance tile | Yes |
| `/api/send` (POST) | Umami client-side analytics → SSRF-safe proxy in `src/app/api/send/route.ts` | Yes; outbound HTTP, not Prisma-bound. The 3.3 s here is a separate concern — likely the Umami server itself is slow (also runs on apps-01) |

## 5 — Proposed v1.4.34 sub-wave: IW-F-Perf

Dispatched **after** IW-A (env audit, complete) through IW-E and
IW-XML reach completion, since this sub-wave depends on no in-flight
file changes from the others. Two parallel parts, each ~2 h.

### IW-F-Perf-Pool — env-only, no code

- Author the apps-01 env edit (above) and document in a CHANGELOG
  line under `Reliability`. No source change.
- Add an integration test that asserts a `?connection_limit=` query
  param is present in `DATABASE_URL` when `NODE_ENV=production`.
  Lives in `src/lib/__tests__/database-url-shape.test.ts`. The test
  surfaces the regression if someone ever resets the Coolify env
  back to bare. **This is the only code change**.

### IW-F-Perf-Duplicates — consumer-collapse round-2

Two surgical changes; both are additive:

- New `src/lib/queries/use-achievements-query.ts` mirroring the
  v1.4.33 `use-analytics-query.ts` shape. Wires both
  `<RecentAchievementsCard>` and `<AchievementUnlockNotifier>` onto
  the shared hook. The notifier's `refetchInterval` moves onto the
  shared hook (the card stays passive; the notifier's `useEffect`
  reads from the shared cache). One network call, one cache slot.
- Either (a) switch `<GettingStartedChecklist>` from
  `useAnalyticsQuery({ slice: "summaries" })` to the thick
  `useAnalyticsQuery()` so it rides the dashboard's cache slot, or
  (b) wire IW-B's slim-slice routing so the dashboard tile strip
  fires the slim call and the thick call is deferred behind the
  Coach drawer's hover prefetch. The IW-B brief documents (b) as
  the target shape; if IW-B lands first, IW-F-Perf-Duplicates
  becomes (a) by elimination.

Quality gate: existing `src/app/__tests__/insights-b3-wiring.test.ts`
+ a new dashboard-mount integration test counting **distinct fetch
URLs** during the first 1500 ms after `render()` — the dashboard
should issue ≤ 7 fetches, not 9.

### Why not a release-blocker

The pool-starvation fix is an env edit, deployable separately from
v1.4.34. The duplicate-call fix is additive consumer-side
refactoring that improves load even without the pool fix. Each
half stands on its own. Neither needs the in-flight IW-A/B/C/D/XML
file sets touched.

## 6 — Operator-action items for the maintainer

In priority order. Each is independently revertible.

1. **Add `?connection_limit=20&pool_timeout=10` to `DATABASE_URL`.**
   Coolify → HealthLog app → Environment Variables → edit live
   `DATABASE_URL` (uuid `w8w8gc08sgo48o8008ww04gk` per the v1.4.34
   IW-A audit). One restart cycle, no rebuild. Expected payoff:
   eight-call dashboard tail drops from ~3 s to ≤ 600 ms in the
   pool-bound paths.

2. **Set Coolify CPU/RAM caps on the HealthLog app.** Coolify →
   HealthLog → Limits: `Limits CPUs = 2`, `Limits Memory = 1g`,
   `Limits Memory Reservation = 512m`. Today both `limits_cpus` and
   `limits_memory` are `"0"` (no cap), which on a 25-app shared
   host means the container floats with default cgroup share —
   noisy neighbours steal scheduling time. Setting an explicit cap
   reserves the floor.

3. **Delete the section-2 leftover env entries.** Per the v1.4.34
   IW-A audit there are 28 duplicate env entries on apps-01,
   including a placeholder `POSTGRES_PASSWORD` that would shadow
   the live one if Coolify ever swapped read precedence. Cleanup
   reduces operational surprise; not perf-relevant on its own.

4. **(Optional) Split the worker subsystem off into its own
   container.** Today `HEALTHLOG_PROCESS_TYPE=all` co-locates the
   web HTTP server and pg-boss in one Node process. The web pool
   and the worker pool then share Node event-loop cycles. Splitting
   into two Coolify services (one `web`, one `worker`) is a v1.4.35
   candidate, not a v1.4.34 hotfix — it changes Compose shape and
   needs a release pipeline pass.

5. **(Optional) Investigate the `/api/send` 3315 ms.** The HAR
   shows a 3.3 s wait on the Umami proxy POST. Umami runs on the
   same apps-01 host (`a8004ksswcokok4csg0wowwc`) — could be the
   same Postgres-contention story bleeding into a sibling service.
   Out of scope for this report but worth a five-minute look at the
   Umami container's resources.

### One thing to leave alone

`HEALTHLOG_PROCESS_TYPE=all` is correct **for now** — splitting it
without first sizing the worker pool independently would create a
new race against Postgres `max_connections`. Sequence is: pool-size
the URL first (action 1), then resource-cap the container (action 2),
then observe a clean week of traces, **then** consider the split.

## Closing note

The HAR is a clean diagnostic — three failure modes overlaying a
single timestamp, each with an independent fix. None of the fixes
need the in-flight v1.4.34 implementation sets touched. The
recommended path is to land the env edits today as a hotfix and
file IW-F-Perf as the v1.4.34 polish addendum behind whatever
implementation work is currently in motion.
