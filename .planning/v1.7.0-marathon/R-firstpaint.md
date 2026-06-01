# R-firstpaint — Unified Dashboard Snapshot (v1.7.0)

Research + design for the dashboard cold-load stagger. Goal: every above-the-fold
tile paints together on first byte, TTFB stays low, and no AI text is ever
generated synchronously during a page load.

READ-ONLY research. This document is a design, not an implementation.

---

## 1. Current dashboard data path (the stagger root cause)

The dashboard is `src/app/page.tsx` (there is no `(app)` route group). It is a
single `"use client"` component, ~1516 LOC, top-to-bottom client-fetched. The
iOS `/api/dashboard/summary` route is **NOT used by the web dashboard at all** —
it serves the SwiftUI client only (`src/app/api/dashboard/summary/route.ts:1-11`).
That route is a useful template for the shape but is not on the web path.

### 1a. The serial auth gate (primary stagger cause)

Every dashboard query carries `enabled: isAuthenticated`. `isAuthenticated`
comes from `useAuth()` (`src/hooks/use-auth.ts:63-82`), which is itself a
`useQuery` against `GET /api/auth/me` (`:44-46`). It flips true only **after**
`/api/auth/me` resolves. So the cold load is:

```
boot JS  →  /api/auth/me  (round-trip 1, gating)
              └─▶ THEN fan-out (round-trips 2..N, parallel):
                    /api/analytics?slice=summaries   (tile headlines)
                    /api/analytics                   (thick: bpInTargetPct, glucose)
                    /api/mood/analytics              (mood tile + chart)
                    /api/dashboard/widgets           (layout / visibility / order)
                    + per-chart fetches inside each <HealthChartDynamic>
```

The mood tile "appears first" because `/api/mood/analytics` is a small, fast,
single-purpose endpoint, while the per-type measurement tiles wait for the slim
`/api/analytics?slice=summaries` slice. When both analytics slices are cold
(LRU evicted / new process), the tile strip shows the skeleton
(`src/app/page.tsx:1324-1327`, `1391-1414`) and then all measurement tiles
"pop in" as one burst the moment the slim slice resolves — exactly the
"~1 second later all tiles pop in staggered" symptom.

### 1b. Per-tile / per-query independence (secondary stagger cause)

The tile data and the layout/visibility data resolve from **independent** query
cells that complete at different times:

| Source | Drives |
|---|---|
| `data` (merge of slim+thick analytics, `page.tsx:217-247`) | per-type tile values, BD-Zielbereich, glucose |
| `moodData` (`page.tsx:261-274`) | mood tile + mood chart |
| `layoutData` (`page.tsx:249-259`) | which tiles/charts are visible + order |
| `user` (`useAuth`) | greeting, height/age/gender-derived target bands |

Tiles only render once **both** `data` (or `moodData`) **and** `layoutData`
have resolved, because `isTileVisible()` / `widgetOrder()` read `layoutData`
(`page.tsx:356-364`). Four independent cells with four independent completion
times = four independent paint moments.

### 1c. The per-tile `<Suspense>` boundaries are NOT the cause

`page.tsx:1467-1477` wraps each trend card and `:1507` each chart in its own
`<Suspense>`. The comments (`:1457-1466`, `:1483-1506`) confirm these are
structural no-ops today — tile bodies are synchronous, chart skeletons live
inside the `next/dynamic` factory. The stagger is the **upstream query
waterfall**, not Suspense resolving independently. (Charts below the fold are a
separate, acceptable concern — they each fetch their own `["chart-data", …]`.)

### Tile inventory (above the fold)

Every tile in the strip, its data source, and where it renders:

| Tile | Source field | Endpoint | Gate |
|---|---|---|---|
| Weight | `summaries.WEIGHT` | `/api/analytics?slice=summaries` | `page.tsx:288,367,400` |
| BP systolic | `summaries.BLOOD_PRESSURE_SYS` | slim analytics | `:289,368,401` |
| BP diastolic | `summaries.BLOOD_PRESSURE_DIA` | slim analytics | `:290,401` |
| Pulse | `summaries.PULSE` | slim analytics | `:291,369,402` |
| Body fat | `summaries.BODY_FAT` | slim analytics | `:292,370,403` |
| Mood | `moodData.summary` | `/api/mood/analytics` | `:299,371,404` |
| Sleep | `summaries.SLEEP_DURATION` | slim analytics | `:293,372,405` |
| Steps | `summaries.ACTIVITY_STEPS` | slim analytics | `:294,373,406` |
| VO₂ max | `summaries.VO2_MAX` | slim analytics | `:298,374,407` |
| BD-Zielbereich | `bpInTargetPct*` | `/api/analytics` (THICK) | `:390-397,408` |
| Glucose ×N | `glucoseByContext[ctx]` | `/api/analytics` (THICK) | `:434-445` |
| Layout/order for all | `layoutData` | `/api/dashboard/widgets` | `:249-259` |

The BD-Zielbereich + glucose tiles ride the **thick** slice, which is the
slowest of the analytics reads — they arrive last today by design (the
v1.4.39.2 slim/thick split, `page.tsx:197-216`).

### 1d. Analytics route internals (rollup tier)

`GET /api/analytics` (`src/app/api/analytics/route.ts`):
- `?slice=summaries` → `computeSummariesSlice(user.id)` (2 SQL passes), wrapped
  in `caches.analytics` keyed `${user.id}|summaries`, 60 s TTL
  (`route.ts:51-60`, `server-cache.ts:210-214`).
- default (thick) → `ensureUserRollupsFresh` + `probeRollupCoverage`, then
  `computeBpInTargetFastPath` / `computeUserHealthScoreFastPath` /
  `computeCorrelationHypothesesFastPath` (all imported `route.ts:11-15`). These
  read DAY/WEEK/MONTH/YEAR `measurement_rollups` with a live-SQL fallback on a
  coverage miss (CLAUDE.md read-swap). **None of these is an LLM call** — health
  score and correlations are deterministic SQL, despite the AI-sounding names.

So the snapshot can assemble every tile field server-side from the rollup tier +
the mood-analytics read + the widget layout, with no LLM in the path.

---

## 2. AI pre-generation audit

The ONLY LLM-generated text in the product is the comprehensive insight, which
carries the `dailyBriefing` + `trendAnnotations` blocks. The per-status cards
(BP/weight/pulse/bmi/mood/compliance) are also LLM, cached in `audit_logs`. The
Coach is SSE chat. Health-score + correlations are **not** LLM.

### Audit table

| Artifact | Generated by | Cached where | On-demand at load? |
|---|---|---|---|
| Comprehensive insight + `dailyBriefing` + `trendAnnotations` | `POST /api/insights/generate` (`src/app/api/insights/generate/route.ts:181-570`) — LLM via provider chain | `User.insightsCachedText` + `insightsCachedAt`, 24 h TTL (`route.ts:212-238,530-536`) | **YES — fires on `/insights` mount.** `useInsightsAdvisorQuery(isAuthenticated)` (`use-insights-advisor.ts:149-160`) auto-POSTs on mount; the POST is cache-or-generate (`route.ts:212-238`). On a cache MISS (>24 h old, or never generated) it **synchronously calls the LLM inside the request**, bounded by an 8 s client `AbortController` (`use-insights-advisor.ts:63,75-90`). This is the stall the maintainer fears — but it is on `/insights`, NOT the dashboard. |
| Per-status cards (bp/weight/pulse/bmi/mood/compliance) | `/api/insights/{scope}-status` routes (LLM) | `audit_logs` rows `insights.<scope>-status.<locale>`, per-day eviction (`generate/route.ts:59-83`) | YES on `/insights` sub-cards; same cache-or-generate pattern. Not on the dashboard. |
| Coach chat | `POST /api/insights/chat` SSE | `CoachMessage.encryptedContent` | On user send only — never on page load. |
| Health score | `computeUserHealthScoreFastPath` (SQL, `analytics/route.ts:14`) | `caches.analytics` 60 s | No LLM. Deterministic. Thick analytics only. |
| Correlations | `computeCorrelationHypothesesFastPath` (SQL, `analytics/route.ts:15`) | `caches.analytics` 60 s | No LLM. Deterministic. |

### Critical finding (answers the maintainer's worry directly)

**Is any AI text generated synchronously during a DASHBOARD load? NO.** The
dashboard (`src/app/page.tsx`) does not import `use-insights-advisor`, does not
render `<DailyBriefing>`, and does not call `/api/insights/generate`. The
v1.4.27 B1 change retired the dashboard's `<InsightsCardPreview>`
(`page.tsx:276-280`). The dashboard cold-load slowness is 100 % the
auth-gated query waterfall (§1), with zero LLM exposure.

**Is AI text generated synchronously on a PAGE load anywhere? YES, on
`/insights`.** First visit (or after the 24 h cache expires), the mount-time
advisor POST cache-misses and blocks on the provider chain inside the request
handler. There is **no pg-boss cron** that pre-generates the briefing — search
of `src/lib/jobs/` shows workers for reminders, mood-reminder, step-consolidation,
PR-detection, geo-backfill, inventory-expire, idempotency/audit cleanup,
apple-health-import, offhost-backup — but **no insight/briefing generation
worker**. The maintainer's belief that "we said we'd pre-generate those" is
**not yet implemented**: every briefing is lazily generated on first request and
merely cached for 24 h afterward. This is a real gap, and §4 below proposes the
cron to close it.

---

## 3. Design: `GET /api/dashboard/snapshot`

One `apiHandler`-wrapped GET that assembles every above-the-fold tile field in a
single server round-trip from the rollup tier + the mood read + the widget
layout + pre-generated AI artifacts (embedded, never generated). Tiles paint
together because one query resolves them all.

### 3.1 Endpoint

`src/app/api/dashboard/snapshot/route.ts`

```ts
export const dynamic = "force-dynamic";
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "dashboard.snapshot" } });
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;
  const body = await cached(
    caches.analytics as ServerCache<DashboardSnapshot>,
    `${user.id}|dashboard-snapshot`,
    () => buildDashboardSnapshot(user, userTz),
    annotate,
  );
  return apiSuccess(body, NO_STORE_BUT_BFCACHE);
});
```

`buildDashboardSnapshot` runs ONE `Promise.all` over the existing helpers (reuse,
do not re-implement):
- `computeSummariesSlice(user.id)` → per-type `summaries` + `lastSeenByType`
  (slim slice, already cached internally; the snapshot read shares the cell).
- `computeBpInTargetFastPath(...)` → `bpInTargetPct*`.
- glucose-by-context block (lift the existing thick branch from
  `analytics/route.ts:326+`).
- mood-analytics read (lift from `/api/mood/analytics`) → `mood.summary` +
  `mood.entries`.
- resolved widget layout (`resolveDashboardLayout` over `user.dashboardWidgetsJson`,
  same as `widgets/route.ts`) → `layout`.
- the user-profile fields the page derives target bands from (`heightCm`,
  `dateOfBirth`, `gender`, `glucoseUnit`, `timezone`, `username`,
  `onboardingTourCompleted`) — already on `requireAuth().user`.
- AI artifact read-ONLY: `prisma.user` `insightsCachedText` + `insightsCachedAt`.
  Parse + lift `dailyBriefing` via `dailyBriefingSchema.safeParse`. **Never call
  the LLM here.** If absent/stale → `briefing: null` + `briefingState:
  "preparing"` and the cron (§4) fills it.

Each sub-read is `time()`-wrapped (mirror `summary/route.ts:394-400`) and
surfaced under `meta.snapshot.sub_*_ms` so a regression is attributable without
re-instrumenting.

### 3.2 Response shape (single envelope `{ data, error, meta }`)

```ts
interface DashboardSnapshot {
  user: {
    username: string;
    timezone: string;
    heightCm: number | null;
    dateOfBirth: string | null;        // ISO
    gender: "MALE" | "FEMALE" | null;
    glucoseUnit: string | null;
    onboardingTourCompleted: boolean;
    greetingHour: number;              // server-computed in userTz (kills the
                                       // client Intl.DateTimeFormat hour call)
  };
  layout: DashboardLayout;             // resolved widgets[] with visible/tileVisible/order + comparisonBaseline
  summaries: Record<string, DataSummary>;     // every per-type tile headline
  lastSeenByType: Record<string, { lastSeenAt: string; daysAgo: number } | null>;
  bpInTargetPct: number | null;
  bpInTargetPct7d: number | null;
  bpInTargetPct30d: number | null;
  bpInTargetPctAllTime: number | null;
  bpInTargetPctPriorMonth: number | null;
  bpInTargetPctPriorYear: number | null;
  glucoseByContext: Record<string, DataSummary>;
  mood: {
    summary: DataSummary | null;
    entries: Array<{ date: string; score: number; samples: number }>;
  };
  briefing: DailyBriefing | null;      // pre-generated, embedded read-only
  briefingState: "ready" | "preparing" | "disabled";
  briefingUpdatedAt: string | null;
  generatedAt: string;                 // ISO
}
```

The Zod source schema lives under `src/lib/openapi/` and feeds
`docs/api/openapi.yaml` via `pnpm openapi:generate` (CI gate).

### 3.3 Page consumption — RECOMMENDATION

**Recommend: one client `useSnapshotQuery()` that hydrates ALL tiles, replacing
the four independent per-tile/layout/mood/thick cells.** Keep the page a
`"use client"` component (it owns the quick-entry sheets, dropdowns, dialog
state — converting to RSC is a far larger rewrite and risks the warm-feel). But
collapse the data layer to a single query so all tiles share one completion
moment.

Why one client query and NOT an RSC server-fetch for v1.7.0:
- The page is already client. An RSC `page.tsx` + server fetch would require
  splitting interactive chrome into a client island and hydrating, a large diff
  that risks the "blazing fast warm" feel the maintainer prizes. Defer to a
  later milestone if TTFB needs the SالسSR boost.
- One client query still fixes the stagger: tiles arrive together because there
  is exactly one cell, one completion.
- Warm navigation stays instant: `staleTime: 60_000` means a return-to-dashboard
  within a minute is a free cache hit, identical to today's
  `DASHBOARD_QUERY_OPTS` (`page.tsx:56-59`).

To also kill the **auth-gate waterfall** (§1a — the single biggest first-byte
win): make the snapshot query **NOT** gated on `isAuthenticated`. It runs
`requireAuth()` server-side and returns 401 if the cookie is absent; on the
dashboard route the cookie is always present (the user is past the
`src/proxy.ts` onboarding/auth redirect). Firing `/api/dashboard/snapshot` in
parallel with `/api/auth/me` instead of after it removes round-trip 1 from the
critical path. The page reads `snapshot.data.user` for greeting/bands and uses
`useAuth()` only for the global nav/coach gating it already needs elsewhere.

Query key (factory contract, `src/lib/query-keys.ts`):
```ts
dashboardSnapshot: () => ["dashboard", "snapshot"] as const,
```
Add to the factory; the in-repo `healthlog/queryKey-factory` ESLint rule
(`error`) forbids the bare array.

### 3.4 Embedding pre-generated AI text (never generate in this path)

- The snapshot reads `User.insightsCachedText` and lifts `dailyBriefing` only.
  It NEVER POSTs `/api/insights/generate` and NEVER calls a provider.
- If `insightsCachedText` is null/unparseable/older than 24 h →
  `briefing: null`, `briefingState: "preparing"`. The UI paints a graceful
  shimmer/empty card (reuse `<DailyBriefing loading>` / empty-state at
  `daily-briefing.tsx:283-361`). The cron (§4) refills; the user sees real text
  on the next visit without ever blocking a paint.
- If the operator disabled the Coach surface (`requireAssistantSurface("coach")`
  semantics) or `user.disableCoach` → `briefingState: "disabled"`, card hidden.

> Note: the dashboard does not render the briefing today (§2). Embedding it in
> the snapshot is OPTIONAL for v1.7.0 — include the field so the shape is
> future-proof and so a future "briefing on dashboard" toggle is a pure UI
> change. The `/insights` page keeps its own advisor query.

### 3.5 Cache strategy + invalidation

- Reuse `caches.analytics` (60 s TTL, `server-cache.ts:210-214`), per-user key
  `${user.id}|dashboard-snapshot`. Same bucket family the slim/thick analytics
  + mood reads already use, so a single eviction sweep covers it.
- Wire the snapshot key into the existing invalidators in
  `src/lib/cache/invalidate.ts`:
  - `invalidateUserMeasurements(userId)` (`:30`) → also drop
    `${userId}|dashboard-snapshot`.
  - `invalidateUserMood(userId)` (`:48`) → drop it (mood block lives in the
    snapshot now).
  - `invalidateUserMedications(userId)` (`:63`) → drop it.
  - `invalidateUserDashboardWidgets(userId)` → drop it (layout changed).
  - On a fresh insight write (`generate/route.ts:530-536`) → drop it so the next
    snapshot embeds the new briefing.
- A measurement/insight write therefore evicts both the legacy analytics cells
  AND the snapshot, preserving CLAUDE.md "invalidate on new content".

---

## 4. The pre-generation cron (closes the §2 gap)

New pg-boss worker `src/lib/jobs/insight-pregenerate.ts`, registered in the
worker bootstrap alongside the existing crons (see `reminder-worker.ts:160-232`
for the registration pattern; add the queue to `allQueues` — the v1.4.37 W10 QA
catch proves an unregistered queue ships silently).

- Cadence: nightly, staggered per the 03:xx/04:00 cleanup-cron convention
  (`feedback-aggregator.ts:4`, `medication-inventory-expire.ts:25`). Pick a free
  slot (e.g. 04:30 Europe/Berlin).
- Discovery query: users with a configured provider chain AND
  (`insightsCachedAt IS NULL` OR `insightsCachedAt < now() - interval '20 hours'`)
  AND assistant surface enabled AND `disableCoach = false`. Bounded batch with
  per-user budget gate (reuse `runRawCompletionWithFallback` + the existing
  rate-limit/budget plumbing so a cron run can't blow the LLM budget).
- Effect: by the time a user opens `/insights` (or, later, sees the dashboard
  briefing), the cache is warm → the mount-time advisor POST is a pure
  cache-read, no synchronous LLM. This is the "pre-generate everywhere" the
  maintainer expects.
- Must NOT run inside the request lifecycle and must NOT use `pnpm tsx`
  (CLAUDE.md DO-NOTs); it is a recurring pg-boss task.

This cron is independent of the snapshot endpoint and can ship in the same
release or a follow-up. The snapshot's `briefingState: "preparing"` already
degrades gracefully if the cron has not run yet.

---

## 5. Test list

Unit / integration (Vitest):
1. `snapshot.route.test.ts` — envelope shape `{ data, error }`; every tile field
   present; `requireAuth` 401 when unauthenticated.
2. Snapshot assembles all tiles in ONE `Promise.all` — assert sub-query count
   and that no LLM client is reachable from the builder (mock provider chain →
   assert never invoked).
3. Cache hit/miss: second call within 60 s hits `caches.analytics`; a
   measurement write evicts `${userId}|dashboard-snapshot`.
4. `briefingState` matrix: ready (fresh cache) / preparing (null or >24 h) /
   disabled (coach off) — and the builder NEVER calls `/api/insights/generate`.
5. Invalidation: `invalidateUserMeasurements/Mood/Medications/DashboardWidgets`
   each drop the snapshot key (extend existing `invalidate.test.ts`).
6. queryKey factory: `queryKeys.dashboardSnapshot()` exists; ESLint
   `healthlog/queryKey-factory` passes (no bare array in `page.tsx`).
7. Parity test: snapshot `summaries` byte-match `computeSummariesSlice` output;
   `bpInTargetPct*` match the thick fast-path; mood block matches
   `/api/mood/analytics`.
8. OpenAPI: `pnpm openapi:check` green after adding the snapshot Zod schema.
9. Cron `insight-pregenerate.test.ts` — discovery query selects only
   provider-configured, stale-cache, coach-enabled users; respects budget gate;
   queue is in `allQueues`.

E2e (Playwright, behind the flag):
10. Cold dashboard load with flag ON: assert all visible tiles appear within one
    paint frame of each other (no mood-first-then-burst), via a single
    `/api/dashboard/snapshot` network event (not 4 separate analytics/mood/widget
    requests).
11. Warm navigation away-and-back within 60 s makes zero snapshot network calls
    (cache hit) — guards the "blazing fast warm" feel.
12. Axe pass on the snapshot-driven dashboard (no regression vs. today).

---

## 6. Rollout (low-risk, reversible)

1. **Land the endpoint + cron first, no UI change.** Ship
   `GET /api/dashboard/snapshot` + the Zod schema + OpenAPI regen + the
   pre-generate cron. Inert until the page consumes it. Validate in prod via the
   `meta.snapshot.sub_*_ms` annotations and the cron's wide-event.
2. **Flag the page swap.** Add a feature flag (reuse the existing
   `src/lib/feature-flags/` infra). Flag OFF → the page keeps the four
   independent queries (today's behaviour, zero risk). Flag ON → the page mounts
   the single `useSnapshotQuery()` and reads every tile from it.
3. **Preserve the warm feel:** `staleTime: 60_000` + `refetchOnWindowFocus:
   false` + `refetchOnMount: false`, identical cadence to `DASHBOARD_QUERY_OPTS`
   (`page.tsx:56-59`). Keep the tile-strip skeleton (`page.tsx:1391-1414`) as the
   single-cell loading state so the layout footprint is reserved.
4. **Verify, then default-on, then remove the legacy queries.** Once the flag is
   ON in prod and the stagger is gone (e2e #10 + manual), flip the default, then
   delete the `analyticsSlimQuery` / `analyticsThickQuery` / `moodData` /
   `layoutData` cells from `page.tsx` (no back-compat shim — CLAUDE.md DO-NOTs).
5. **Auth-gate win:** in step 2, fire the snapshot query un-gated by
   `isAuthenticated` (server-side `requireAuth` is the real gate) so round-trip 1
   leaves the critical path. This is the largest TTFB improvement and is
   independently reversible via the flag.

### Risks

- **Biggest risk — the thick block (BD-Zielbereich + glucose + bpInTarget) is
  the slowest read and now sits inside the unified snapshot.** Today the page
  paints measurement tiles from the slim slice FIRST and lets the thick block
  stream in afterward (the deliberate v1.4.39.2 progressive-paint split,
  `page.tsx:197-216`). Collapsing slim+thick into one snapshot means the WHOLE
  strip waits for the slowest sub-query — on a cold rollup-coverage miss the
  thick fast-path falls back to live SQL and can be multi-second, which would
  make EVERY tile late instead of just the BD/glucose tiles. Mitigation: keep the
  builder's `Promise.all` so thick runs concurrently with slim; gate the snapshot
  behind rollup-coverage being warm (the boot `rollup-full-backfill` queue
  converges new accounts); and consider a `tiles` (slim, fast) + `extras` (thick)
  two-phase field in the snapshot where `extras` may arrive `null` on the first
  payload and the tile shows a per-tile shimmer — preserving "everything else
  together" while not regressing to a blocked-then-burst on the thick path. This
  trade-off (paint-together vs. slowest-wins) is the core design tension and must
  be measured on a power-user account before default-on.
- Secondary: un-gating from `isAuthenticated` must be verified to never fire on
  the unauthenticated shell (proxy redirect should prevent the dashboard from
  rendering pre-auth, but confirm in e2e).
- Tertiary: the pre-generate cron must respect the LLM budget gate or a nightly
  fan-out across all users could spike provider cost.
