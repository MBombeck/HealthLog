# W10 Architectural-Correctness Review — v1.4.37 reconcile

Scope: full diff `v1.4.36..HEAD` on `develop` (~50 commits, 98 files,
+8954 / -1306 lines). Read-only architectural lens — no file mutations
outside this report.

Severity legend: **Critical** (block tag) / **High** (fix before tag if
cheap, otherwise track for v1.4.38) / **Medium** (track for v1.4.38) /
**Low** (nice-to-have, sweep at convenience).

---

## Critical

_None_. The release is internally consistent on the architecture axis.

---

## High

### H1 — `groupBy=day` branch silently drops pagination (`offset` hard-coded to 0, no `total` count)

- **Files**
  - `src/app/api/measurements/route.ts:123-222`
  - `src/lib/validations/measurement.ts:281` (the schema accepts
    `groupBy` + `offset` together)

- **Concern**: When a client sends `?groupBy=day&offset=25&limit=25`,
  the route's collapsed branch ignores the offset entirely
  (`measurements.length` / `offset: 0` in the response meta) and the
  `meta.total` is the **post-collapse bucket count of the page** rather
  than the true total bucket count for the user's window. The legacy
  per-sample list path on the same route honours `offset` + a real
  `prisma.count(where)`, so consumers that thread the v1 pagination
  contract through (admin tools, future iOS list views) will break
  silently on cumulative types — the UI paints "showing 1-25 of N"
  with the wrong N. The drill-down branch above
  (`route.ts:82-117`) has the same shape (`offset: 0`, no count).

- **Recommendation (v1.4.38)**: either (a) reject `offset > 0` at the
  validator when `groupBy=day` / `dayKey` is present, or (b) implement
  real pagination — group inside Postgres via
  `date_trunc(<truncUnit>, measured_at)` + `LIMIT/OFFSET` and add a
  `prisma.measurement.findMany({ distinct: ["dayKey"] })`-style count.
  Option (a) is the smaller change and matches the W7c intent
  (initial-page-only drill-down). Document the restriction in the
  schema doc comment.

### H2 — `dayKey` validation accepts impossible dates and silently shifts the window

- **Files**
  - `src/lib/validations/measurement.ts:287-290`
  - `src/app/api/measurements/route.ts:95` (`canonicalDailyTimestamp(dayKey, tz)`)
  - `src/lib/measurements/drain-per-sample-cumulative.ts:113-145`

- **Concern**: The schema validates `dayKey` against
  `^\d{4}-\d{2}-\d{2}$` only. A request with `dayKey=2026-02-30` (or
  `2026-13-01`) passes the regex; `new Date("2026-02-30T12:00:00.000Z")`
  silently overflows to `2026-03-02`, and the drill-down returns rows
  from the wrong calendar day. No 422 is emitted; the response is
  syntactically well-formed and points at a different day than the
  user asked for. The same helper feeds the drain via the admin route,
  so a malformed CLI invocation has the same blast radius.

- **Recommendation**: tighten the validator with a real date refine —
  `.refine((s) => { const d = new Date(`${s}T00:00:00Z`); return s ===
  d.toISOString().slice(0, 10); }, "dayKey must be a real date")`. Add
  a single test case for `2026-02-30`.

### H3 — Two cumulative-type constants live in different modules with no cross-check

- **Files**
  - `src/lib/measurements/apple-health-mapping.ts:342-348` —
    `CUMULATIVE_HK_TYPES: ReadonlySet<MeasurementType>`
  - `src/lib/measurements/cumulative-day-sum.ts:77-83` —
    `CUMULATIVE_DAY_SUM_TYPES: readonly [...]`
  - `src/lib/measurements/__tests__/apple-health-mapping.test.ts:426`
    (only checks `CUMULATIVE_HK_TYPES` ↔ HK identifier coverage)
  - `src/lib/measurements/__tests__/cumulative-day-sum.test.ts:97`
    (only checks `CUMULATIVE_DAY_SUM_TYPES` reflex)

- **Concern**: Both constants enumerate the same five types
  (`ACTIVITY_STEPS`, `ACTIVE_ENERGY_BURNED`, `WALKING_RUNNING_DISTANCE`,
  `FLIGHTS_CLIMBED`, `TIME_IN_DAYLIGHT`), but live in two modules and
  have no shared test that pins them as a single set. The cumulative-
  day-sum doc comment explicitly says "Once Apple-Health passthrough
  lands and the sleep ladder needs the same shared treatment it can
  fold into this list", which implies the two sets are intended to
  diverge — but today they do not, and a contributor adding a new
  cumulative type would have to remember to update two files. Per the
  caller brief: "CUMULATIVE_HK_TYPES is single-source-of-truth (not
  duplicated in features.ts, drain, route, and UI separately)".

- **Recommendation**: pick one as the source of truth (probably
  `CUMULATIVE_HK_TYPES`, since it is referenced by the drain, the
  importer, the route, and the chart already), drop the duplicate, and
  re-export an alias `CUMULATIVE_DAY_SUM_TYPES` if the doc-comment
  divergence ever lands. Until then, add a single equivalence test:
  `expect(new Set(CUMULATIVE_DAY_SUM_TYPES)).toEqual(CUMULATIVE_HK_TYPES)`.

### H4 — Coach-cascade invariant fixture asserts a hard-coded count without enumerating cross-cut gates

- **Files**
  - `src/lib/feature-flags/__tests__/coach-cascade.test.tsx:101-162`
    (`COACH_SURFACES` fixture)
  - `src/lib/feature-flags/__tests__/coach-cascade.test.tsx:205-215`
    (`expect(COACH_SURFACES.length).toBe(6)`)
  - Cross-cut gates owned by other invariants:
    `src/app/__tests__/targets-coach-mount.test.tsx`,
    `src/components/targets/__tests__/target-card.test.tsx`

- **Concern**: The fixture covers six in-band surfaces (HeroStrip ×3,
  CoachLaunchButton, LayoutCoachFab, LayoutCoachMount) and explicitly
  delegates two cross-cut gates (page-level `<CoachDrawer>` on
  `/targets`, per-card CTA in `<TargetCard>`) to separate tests. The
  contract comment "when a new Coach-bearing surface lands, add to the
  fixture" only enforces in-band additions; a new sub-page Coach mount
  (e.g. an `/insights/<metric>` page that adds its own `<CoachDrawer>`)
  would not trip the fixture count and could leak the affordance
  without anyone noticing. The brief explicitly asks: "the
  invariant-test fixture is complete (the COACH_SURFACES list matches
  every actual Coach-bearing component)" — it does not.

- **Recommendation (v1.4.38)**: either (a) absorb the cross-cut gates
  into the same fixture so the count is genuinely complete, or (b)
  back the count with a grep-based test that enumerates every
  `flags.coach` short-circuit in the codebase and asserts the fixture
  + cross-cut tests cover them. Option (b) is fragile but catches
  drift; option (a) requires the fixture to import `/targets/page` and
  `TargetCard` and exercise them with non-trivial fixtures.

---

## Medium

### M1 — BP fast-path windowing uses UTC-midnight `bucketStart` vs `now`-anchored boundaries

- **Files**
  - `src/lib/analytics/bp-in-target-fast-path.ts:212-235`
    (`sevenDaysAgo`, `thirtyDaysAgo`, … all computed from `now`)
  - `src/lib/analytics/bp-in-target-fast-path.ts:266-294`
    (`bucketWindow` compares `p.day.getTime() < fromMs`)

- **Concern**: `p.day` is the rollup `bucketStart` (UTC midnight), but
  `from` / `to` are `now - N*DAY_MS` (some mid-day instant). For a
  request at 12:34 UTC, "30 days ago" lands at 12:34 UTC the boundary
  day, which means that boundary day's UTC-midnight bucket falls
  OUTSIDE the window (00:00 < 12:34 ⇒ excluded). The live path uses
  per-event `measuredAt` so it would include any reading on the
  boundary day before 12:34 UTC. Result: the two paths differ by
  ±1 day's worth of pairs at the boundary. The doc inside
  `bp-in-target-fast-path.ts:33-42` says "lands within ±2% of the
  per-event count"; the boundary slip is additive on top of that.

- **Recommendation**: align the rollup-path window boundaries with day
  edges — compute `from = startOfDay(now - 30d, "Europe/Berlin")` and
  `to = startOfDay(now, "Europe/Berlin")`. Same shape for the prior-
  month / prior-year windows. This keeps the rollup-path stable across
  request times and removes a ~3% noise floor from the per-day
  classification.

### M2 — Correlations fast-path uses `userDayKey(bucketStart, userTz)` against UTC-midnight buckets — misaligns in western-hemisphere zones

- **Files**
  - `src/lib/analytics/correlations-fast-path.ts:151-163`
    (`dailySysMean.set(userDayKey(b.bucketStart, userTz), b.mean)`)
  - `src/lib/analytics/correlations-fast-path.ts:225-275` (mood +
    intake reads use `userDayKey(rawTimestamp, userTz)` on per-event
    rows)

- **Concern**: The rollup table's `bucketStart` is at UTC midnight.
  For a Berlin user (UTC+1/+2), `userDayKey(2026-05-17T00:00:00Z,
  "Europe/Berlin")` returns `"2026-05-17"` — same as the raw events'
  user-day keys, so pairing works. For a user in `Pacific/Honolulu`
  (UTC-10), `userDayKey(2026-05-17T00:00:00Z, "Pacific/Honolulu")`
  returns `"2026-05-16"`, but a mood entry made at 09:00 Hawaii on
  2026-05-17 (= 19:00 UTC 2026-05-17) keys to `"2026-05-17"`. The two
  streams misalign by a calendar day in negative-offset zones, and
  the BP-pulse × mood pairing under-counts. The helper comment
  (`correlations-fast-path.ts:141-150`) acknowledges this is benign
  for Berlin-only tenants — the production tenant is Berlin today, so
  this is deferred not broken. Brief still flags it under "the
  dayKey is parsed/validated as ISO date in user TZ (not UTC),
  preventing date-window leakage".

- **Recommendation (v1.5)**: when the multi-tenant geographic spread
  grows beyond Berlin, mint per-user-tz rollup buckets (separate
  table or a tz column) or run a per-tz aggregation at read time. The
  `n >= 20` surface gate absorbs the single-day phase shift for now;
  document the limitation in the rollups README so a future tenant
  in `America/*` doesn't quietly get wrong correlations.

### M3 — Drill-down `take: Math.min(limit, 1000)` silently overrides the schema's 5000 cap

- **Files**
  - `src/app/api/measurements/route.ts:107`
  - `src/lib/validations/measurement.ts:252` (schema's `limit.max(5000)`)

- **Concern**: The Zod schema validates `limit ≤ 5000`, but the
  drill-down branch caps `take` at 1000 with no surface in the
  response meta and no `degraded` flag. A client that asks for
  `limit=2000` thinks it received 2000 rows when in fact it received
  up to 1000. The cap is documented as a comment in the route but
  not echoed back; the caller cannot detect truncation without
  comparing `measurements.length` to `meta.limit`.

- **Recommendation**: either (a) move the 1000 cap into the validator
  for the drill-down branch via a `.refine()` on `(limit, dayKey)`
  so the 422 surfaces, or (b) echo the effective cap as
  `meta.limit` so the client can detect truncation. Option (a) is
  the cleaner architectural fix.

### M4 — Geo-backfill writes to `audit_log` without invalidating any cache; admin sign-in geo column may stale-render

- **Files**
  - `src/lib/jobs/geo-backfill.ts:118-122`
  - (no corresponding `invalidate*` call)

- **Concern**: The geo-backfill updates `audit_log` rows in-place but
  no cache key is invalidated. If the admin sign-in geo column is
  ever fronted by a server cache (today it isn't — the admin pages
  read fresh — but the audit-log surface is on the v1.4.38 backlog
  for sub-page status caching), the backfill would not flush the
  affected rows. The current behaviour is correct; the gap is in
  the contract — the helper documents nothing about cache
  invariants.

- **Recommendation**: add a docstring note on `runGeoBackfill`
  documenting that consumers must not cache audit-log rows by IP
  without listening for backfill events. Optional follow-up: fire a
  lightweight `invalidateAdminAuditLog()` no-op now so the
  invalidation hook exists when the audit-log cache lands.

### M5 — Drain queue: 36 h cutoff is hardcoded in `reminder-worker.ts`, not in the helper signature

- **Files**
  - `src/lib/jobs/reminder-worker.ts:179`
    (`const DRAIN_CUMULATIVE_CUTOFF_HOURS = 36`)
  - `src/lib/measurements/drain-per-sample-cumulative.ts:80-94`
    (`cutoffHours` optional, no default)

- **Concern**: The helper's `cutoffHours` is parameterised (good),
  but the production cron passes 36 from a module-level constant
  inside the worker file. The admin route at
  `/api/admin/drain-per-sample-cumulative` and the CLI both default
  to `undefined` (drain everything). The 36 h grace-window invariant
  for "completed-and-stable day" lives in three places: the worker
  constant, the W7c phase report, and the helper docstring — three
  copies, no shared constant. A future contributor changing the
  grace window on the worker side will leave the admin route's
  manual run mismatched.

- **Recommendation**: lift `DRAIN_CUMULATIVE_CUTOFF_HOURS` into the
  helper module as an exported constant
  (`export const DRAIN_DEFAULT_CUTOFF_HOURS = 36`); import it from
  the worker and the admin route. Keep the parameter optional so
  the CLI can still override.

### M6 — `requireAssistantSurface` server-side gate is wired on Coach API routes, but not enumerated against the `coach-cascade` fixture

- **Files**
  - `src/app/api/insights/chat/route.ts:134, 512`
  - `src/app/api/insights/comprehensive/route.ts:32`
  - `src/app/api/insights/generate/route.ts:187`
  - (no test asserts the set of routes gated by `"coach"`)

- **Concern**: The brief asks: "the server-side
  `requireAssistantSurface` gate (referenced in the W5 report) is
  actually wired on every Coach API route". It is wired on
  chat / comprehensive / generate — these are the only three Coach-
  scoped routes today. But there is no invariant test asserting the
  set: a future Coach API addition could omit the gate and the only
  protection would be the per-route unit test (which the author of
  that route would write). The client-side `flags.coach` gate is
  a UX guard; the server-side gate is the actual security boundary.

- **Recommendation**: add a discovery-style test that greps every
  route under `src/app/api/insights/**` for either
  `requireAssistantSurface("coach")` or an explicit allowlist entry,
  matching the pattern in the `coach-cascade.test.tsx` fixture.

---

## Low

### L1 — `CORRELATION_WINDOW_DAYS = 28` is exported but undocumented in OpenAPI / docs site

- **Files**
  - `src/lib/analytics/correlations-fast-path.ts:68`
  - `docs/api/openapi.yaml` (no entry for the window)

- **Concern**: The constant is exported, reusable, and the helper
  emits it on the meta dict (`window_days: 28`). The brief lists
  this as one of the things to verify; the export is correct. The
  only gap is documentation — the public OpenAPI does not surface
  the window, so a third-party client cannot read it without
  inspecting the meta dict at runtime.

- **Recommendation**: add `correlations.windowDays` to the analytics
  response schema in `docs/api/openapi.yaml` so iOS / docs site can
  quote the truthful window without scraping.

### L2 — `degraded: false` sentinel on correlations is forward-looking; no path sets it true today

- **Files**
  - `src/lib/analytics/correlations-fast-path.ts:288-309`

- **Concern**: The helper always emits `degraded: false`. The doc
  says it is reserved for a future "best-effort under load shedding"
  branch. The wire shape carries an always-false boolean today; a
  client checking it gets no signal. Either the sentinel should be
  removed until it is actually variable, or the v1.4.37 release
  notes should call out that the field is reserved.

- **Recommendation**: keep the field (forward-compat is cheap), add a
  docstring note that it is reserved and may flip in a later
  release; add a TODO comment near the always-false return.

### L3 — `health-score-fast-path`'s `bpInTargetPct` is pinned across current and previous windows; week-over-week delta only reflects three of four pillars

- **Files**
  - `src/lib/analytics/health-score-fast-path.ts:339, 363-364`
    (`bpInTargetRate: bpInTargetPct` on both `current` and
    `previous`)

- **Concern**: The legacy route already had this contract — the
  delta does NOT reflect BP-in-target movement. The fast-path
  helper preserves the legacy behaviour, but documents it only in a
  one-line comment ("the route does not pay for a second historical
  pair-search"). The Personal Health Score's "vs last week" delta
  the UI surfaces is therefore truthfully week-over-week for three
  pillars (weight, mood, compliance) and zero for BP. Pre-existing
  behaviour — flagged here for visibility, not a regression.

- **Recommendation (v1.5)**: compute the prior-week BP-in-target
  using the rollup path (cheap once the fast-path is in) so the
  delta is honest across all four pillars.

### L4 — `bp-in-target-fast-path` line 296 `dayKey(d: Date)` is local to this file but duplicates the pattern used elsewhere

- **Files**
  - `src/lib/analytics/bp-in-target-fast-path.ts:296-298`
  - `src/lib/tz/resolver.ts` (canonical `userDayKey`)

- **Concern**: The helper uses `d.toISOString().slice(0, 10)` for
  the bucket day-key — different shape from the rest of the
  codebase's `userDayKey(d, userTz)`. Since the rollup buckets are
  UTC midnight, the UTC slice is correct for SYS-DIA pairing
  inside this file. But the helper signature is module-local and
  not exported; a future refactor that lifts the pairing logic
  could accidentally use `userDayKey` with the bucket and get a
  per-tz day key that no longer pairs cleanly.

- **Recommendation**: rename the private helper to
  `bucketDayKey()` and add a one-line docstring that explicitly
  warns "do not replace with userDayKey — the comparator must
  match the rollup table's UTC-midnight bucket convention".

---

## Cross-cutting observations

- **Migrations**: zero new Prisma migrations in this release. The
  rollup work in v1.4.35/v1.4.35.1 already shipped the
  `measurement_rollups` table; v1.4.37 only reads from it. Clean.
- **`probeRollupCoverage`**: called exactly once per request at
  `route.ts:154`, threaded as a parameter into all three fast-path
  helpers. The helpers also each accept an optional `coverage` arg
  and fall back to probing locally — defence-in-depth, not a
  duplicate query in the happy path. Verified.
- **`pg-boss` drain schedule**: registered on the cluster-wide
  scheduler at `45 3 * * *` with `tz: "Europe/Berlin"`. Worker
  uses `localConcurrency: 1`. Idempotent helper. Survives
  restart (pg-boss owns the cron). Verified.
- **Shared helpers W4b**: `reduceCurrentWindowStatus` +
  `getMedicationCategoryLabel` are imported by both card variants
  AND the new dashboard quick-add (the third call site). No
  dead second copy. Verified.

---

## Brief-back

**Per-severity count**: 0 Critical · 4 High · 6 Medium · 4 Low.

**Single most-important architectural concern**: H1 — `groupBy=day`
and `dayKey` branches on `GET /api/measurements` ignore `offset` and
emit a `total` that is the **post-collapse page-bucket count, not
the user's total bucket count**. A consumer threading the pagination
contract through (any future iOS list view or admin tool) will paint
the wrong "showing N of M" string and miss rows beyond the first
page. Cheapest fix before tag: reject `offset > 0` at the validator
when `groupBy=day` or `dayKey` is set (one `.refine()` on
`listMeasurementsSchema`), promote real pagination to v1.4.38.

**Cross-cutting recommendation for v1.4.38**: consolidate the
cumulative-type registry (`CUMULATIVE_HK_TYPES` vs
`CUMULATIVE_DAY_SUM_TYPES`) into a single exported constant with a
parity test, and use the same consolidation pass to lift the drain
grace-window (`DRAIN_CUMULATIVE_CUTOFF_HOURS = 36`) into a shared
module so the worker, admin route, and CLI default share the
constant. Both items are H3 / M5 above — they share the same root
cause (constants duplicated across modules with no cross-check) and
both can be resolved by one cleanup pass on
`src/lib/measurements/`.
