# v1.4.40 QA — Product-Lead Review

Reviewer: Product Lead (read-only, strategic).
Inputs: 11 wave reports (W-POOL, W-RSC, W-INSIGHTS, W-DELETED,
W-WMY-WIRE, W-GHOSTS, W-INFRA, W-PRIVACY, W-CONSENT, W-AASA,
W-APNS-NOTIFY), the v1.4.39 architecture-QA quadrology
(`round-v1439-arch-qa-{frontend,infra-db,ghosts,organization}.md`),
`round-v1439-empirical-trace.md`, `round-v1440-backlog.md`,
`git log c9d5479b..HEAD` (54 commits on `develop`).

## Strategic posture

v1.4.40 is the first **architecture-debt-close** release of the cycle:
the four parallel auditors that ran post-v1.4.39 surfaced a coherent
"sound-with-debt" picture (rollup tier landed; half the read surface
never migrated; per-chart fan-out blocks paint; soft-delete half-wired;
WMY write-only; dead-code accretion across five marathons), and Marc
explicitly directed "don't defer Critical+High to a later release." The
marathon delivered against that directive — every Critical from every
audit closed in-band, plus the v1.4.39.4 compliance-rollup hook gap
that surfaced mid-marathon, plus SB-3/4/5/6/7/10 from the iOS team's
server-backlog. The shape of the release is structurally different
from v1.4.36-39 (which were perf-tier shipments inside a stable
architecture): v1.4.40 is a **read-path retrofit + soft-delete
invariance + organizational umbrella** release, with the iOS-foundation
work (consent receipts, AASA, time-sensitive APNs, per-event status
ledger) landing as touch-disjoint side-cars rather than the main payload.

The release deliberately stays inside additive-only contracts. Zero
breaking API changes; one new table (`ConsentReceipt` from W-SCHEMA
preflight); four new endpoints (3× consent, 1× notifications/status
extension); structural moves (`src/lib/rollups/` umbrella absorbs 7
files across 3 directories, 68 import sites rewritten); perf fixes
(p-limit(4) on the 15-way analytics fan-out + `pg.Pool` max 10→20).
The "consume what we already wrote" theme runs through three waves:
W-INSIGHTS swaps three Insights routes onto the mood-rollup tier
(v1.4.39's writer-only landing), W-WMY-WIRE wires summaries-slice +
health-score onto the MONTH bucket (v1.4.34.4's writer-only landing),
W-DELETED makes 13 reader paths honour the `deletedAt` column iOS
v0.5.4 has been writing since 2026-05-11. Each is the kind of debt
that only an outside-perspective audit pass surfaces; collectively
they restore "what's written equals what's read" as an invariant.

v1.5 readiness is **green from this release's perspective**. The iOS
team is genuinely unblocked: SB-3 (privacy policy DE+EN at `/privacy`)
+ SB-4 (AASA at `.well-known/apple-app-site-association`) + SB-5
(time-sensitive APNs) + SB-6 (per-event status ledger) + SB-7
(registration-status pinning) + SB-10 (consent receipts) all shipped.
The only iOS-side caveat is **AP-2**: SB-5's time-sensitive flag is
inert until the `.p8` APNs key is installed on production Coolify
env (`APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_KEY`).
SB-8 (dashboard tile-visibility migration) is investigation-only per
the audit decision, and SB-9 (streak deprecation) is optional — neither
gates App-Store submission. iOS v0.5.4 does not break against
v1.4.40: every shipped contract change is additive (new endpoints,
extended response envelopes with backward-compatible field additions).

## Perf claim audit

| Endpoint / surface | Claim | Evidence | Confidence |
|---|---|---|---|
| `/api/analytics` thick + 6× chart-tile burst | First-paint of chart row 7.3 s → ~1.6 s (empirical trace §F1) | p-limit(4) wrap on per-type Promise.all + Prisma `pg.Pool` max 10→20 + new analytics-route concurrency test asserting `peak ≤ 4` and timing bound `40ms ≤ elapsed < calls×20ms` | **Medium** — the test pins the structural cap, but the 7.3 s → 1.6 s wall-clock is an extrapolation from the trace's pool-stall hypothesis. Post-deploy verify against Marc's tenant required. |
| `/api/analytics` thick single cold | Absolute regression 10-15 % (4 batches of 15-way work) | Audit estimate; not measured | **Medium** — accepted trade-off because the 60 s LRU collapses warm mounts to a Map lookup; only the cold first-mount pays the penalty. |
| `/api/insights/targets` cold | ≤ 500 ms (was 12 s — unbounded mood walk + 347 k-row distinct sort) | rollup-fast-path + 365-day distinct floor + 4 route tests pinning rollup-vs-coverage-fallback shape | **Medium** — extrapolation from the `/api/mood/analytics` 12.7 s→200ms parity. The distinct-sort fix is the dominant share; mood-tier swap is the second-order win. |
| `/api/insights/comprehensive` cold | 90-day mood walk → rollup tier (≤ 90 row reads) | rollup + coverage-fallback parity tests | **High** — read-shape change with parity contract. |
| `/api/insights/generate` AI feature payload | Mood block bounded to ≤ 1 800 rows (was every entry ever) | features.test.ts extended with rollup mock + warm-up stub | **High** — payload shape change with test. |
| `/api/dashboard/summary` `avg30LastYear` field | Now populated via MONTH-tier read (was hardcoded `null`) | `computeAvg30LastYearMap` helper + 4 new tests; `slim_summaries.year_over_year_types` annotate visible in production wide-events | **High** — semantic-correctness fix (UI control was unreachable). |
| `/api/health-score` weight long-window | MONTH-tier read added alongside the 37-day DAY read; `healthScore.weightLongWindow` annotate | 3 long-window tests + parallel-read shape | **High** for correctness + annotate; **N/A** for wall-clock (additive read, not replacement). |
| Dashboard cold mount HTTP requests | 10-12 parallel → 9-11 (mood-chart queryKey dedup eliminates one) | `1dd1a9a7` re-keys mood-chart to `queryKeys.moodAnalytics()` + factory-bypass test guard | **High** — TanStack dedup is deterministic when keys match. |
| Soft-delete invariance | Tombstoned rows excluded from 13 reader tiers | 3 integration tests (analytics summaries / dashboard summary / rollup recompute) pin the contract; 8 atomic fix commits | **High** — every read pin uses a 99.0 sentinel that would have exploded `max` if the filter leaked. |
| Dashboard per-tile Suspense boundaries | Per-tile streaming, no row-blocking | 5 new structural tests pin the boundaries + memoized `userTimezone` + module-scope `DASHBOARD_QUERY_OPTS` | **High** for structural guarantee; **subjective UX** for visible win — needs prod observation. |
| Dead-code purge | -1 177 source lines across 9 atomic commits | knip CI gate now enforces `files,dependencies,binaries,unlisted`; 7 dead exports + 6 i18n keys + 2 orphan routes + 1 dead pg-boss queue + 2 dup tz helpers removed | **High** — line count + knip exit-0 are deterministic. |

The pattern across the marathon is consistent: **structural pins (Suspense
boundaries, factory enforcement, concurrency caps, soft-delete filters,
queryKey dedup, rollup-tier read swaps) all have unit / integration test
coverage**, while wall-clock estimates ride the post-deploy
`round-v1440-perf-verify.md` window. This is the standard for the
"close the audit" releases (v1.4.34.4, v1.4.38, v1.4.39) — three of
those four had soft claims that the post-deploy verify caught. The
release notes should phrase chart-row first-paint as "expected ~1.6 s"
and Insights cold mounts as "expected ≤ 500 ms" until verified.

## Release-readiness verdict

- **Ship as v1.4.40: YES.** All eleven waves landed across 54 commits
  on `develop`. Quality gates green per each report (54 / 54 typecheck
  ok, 11 / 11 lint clean on touched files modulo the pre-existing
  `app/page.tsx:577` which W-INFRA Thread 2 closed at commit
  `8974e773`, and the consent route's tracked pre-existing warning).
  Test delta +85 unit (`4 631 → 4 716` per W-INSIGHTS / W-RSC /
  W-DELETED / W-WMY-WIRE / W-CONSENT / W-APNS-NOTIFY / W-PRIVACY /
  W-AASA / W-POOL contributions; W-GHOSTS removed test files for
  deletions). No new API contract breaks; one additive migration
  (`ConsentReceipt` from W-SCHEMA); structural moves under
  `src/lib/rollups/` keep public exports byte-equal (68 import sites
  rewritten cleanly per W-INFRA verification). Rollback to v1.4.39.4
  is clean — every rollup-tier read carries a documented live
  fallback; consent endpoints are append-only so revoke is reversible;
  AASA / privacy / APNs payload changes are additive.

- **Critical + High audit close — verified:**
  - **Frontend Critical C1 (per-chart fan-out)** → W-POOL caps the
    analytics fan-out at 4 concurrent + W-RSC streams chart tiles
    individually via Suspense. Empirical-trace #1 (pool starvation)
    closed.
  - **Frontend Critical C2 (chart-data not in
    `measurementDependentKeys`)** → W-RSC adds `chart-data` and
    `dashboard-medication-compliance` to the bundle + 16-assertion
    factory enforcement test.
  - **Frontend High H1 (154 bare queryKeys)** → W-RSC migrates the
    dashboard + chart subset + ships a factory-bypass test guard
    over `src/components/charts`, `src/app/page.tsx`,
    `src/hooks/use-auth.ts`. Long-tail 154-site migration deferred
    to v1.4.41 (opt-in expansion of `guardedRoots`).
  - **Frontend High H2 (no Suspense, no useSuspenseQuery)** → W-RSC
    wraps every tile + chart row in `<Suspense>` boundaries; full
    RSC migration of `app/page.tsx` deferred to v1.4.41 with
    documented migration path (Suspense boundaries are the
    prerequisite, now in place).
  - **Frontend High H4 (`getHourForTimeZone` no memo)** → W-RSC
    memoises on `userTimezone`; W-INFRA Thread 2 fixes the React
    Compiler regression that resulted.
  - **Infra+DB Critical #1 (WMY write-only)** → W-WMY-WIRE consumes
    MONTH buckets in `summaries-slice` (avg30LastYear) +
    `health-score-fast-path` (weight long-window), with
    cross-consumer routing parity test pinning the 90/365/1 095 day
    routing.
  - **Infra+DB Critical #2 (6 unbounded mood walks)** → W-INSIGHTS
    closed three (`insights/targets`, `insights/comprehensive`,
    `lib/insights/features`); deferred three (`cards` — no mood
    query; `glp1-timeline` — needs per-entry tags; `gamification/
    achievements` — needs Berlin-anchored day-key). The deferred
    three are properly explained (tier-shape mismatches that the
    v1.5 per-user-tz tier resolves), not skipped.
  - **Infra+DB Critical #3 (`Measurement.deletedAt` half-wired)** →
    W-DELETED filters 13 reader tiers (rollups recompute + 4
    summaries-slice queries + correlations + bp-fast-path + 3
    health-score + 8 comprehensive-aggregator + dashboard summary +
    measurements list + series + Coach snapshot); 3 integration
    tests pin the contract end-to-end.
  - **Infra+DB Critical #4 (compliance-rollup hook gap on bulk
    create)** → W-INSIGHTS wires `recompute` after
    `medications/intake?scope=today` and `dashboard/summary`
    `projectAndReadTodaysIntakes`. Set-coalescing prevents
    fan-out storms.
  - **Infra+DB Critical #5 (`/api/analytics` route deletedAt
    leaks)** → W-INFRA Thread 1 picked up the three sites W-POOL
    + W-DELETED both skipped (glucose context summaries, sleep-stage
    breakdown, `fetchMeasurementSeriesChunked`). Closed.
  - **Ghost-Hunter dead code** → W-GHOSTS removed 1 177 lines
    across 9 atomic commits (TELEGRAM_CLEANUP_QUEUE; orphan
    intake-summary route; duplicate monitoring/{umami,glitchtip}/test
    routes; 7 dead exports; 18 dead i18n keys across 6 locales;
    consolidated `startOfUtcDay` + `wallClockInTz`). Kept 3 false
    positives with documented rationale (`detectAnomalies`
    transitively used; `ensureUserMedicationComplianceFresh` — see
    below; `readWeek/Month/YearRollups` wired by W-WMY-WIRE).
  - **Org-audit Strategic Recommendation #1 (`src/lib/rollups/`
    umbrella)** → W-INFRA Thread 3 moved 7 files across 3
    directories under `src/lib/rollups/`; 68 import sites rewritten;
    typecheck + 93 rollup tests green; pure relocation, zero
    behavioural change.
  - **Org-audit Strategic Recommendation #2 (`src/types/` DTO
    promotion)** + **#3 (prompt directory unification)** →
    Deferred to v1.4.41 per Marc's directive in `W-INFRA`'s
    "Items deferred" section (avoid clashing with in-flight
    imports + needs its own wave). Documented carry-over.

- **Carry-overs to v1.4.41:**
  - W-INSIGHTS deferred swaps (`cards/route.ts` no-op; `glp1-timeline`
    mood-tag aggregation; `gamification/achievements` Berlin-anchored
    day-key) — gated on v1.5 per-user-tz mood tier.
  - W-INSIGHTS SB-7 follow-up: `/api/auth/check-user` discovery
    branches (the directive's mention of user-exists / passkey-only
    / email-fallback maps to that route, not `/registration-status`
    which W-INSIGHTS pinned).
  - W-RSC RSC migration of `app/page.tsx` — Suspense scaffolding is
    in place; the migration is now a one-pass composition swap.
  - W-RSC custom ESLint `no-restricted-syntax` rule for queryKey
    factory — test-based guard substitutes today; rule is the
    long-term enforcement.
  - W-RSC 154-site queryKey factory migration long tail (admin,
    settings, medications, integrations directories) — opt-in
    expansion of `guardedRoots`.
  - W-INFRA Thread 3 follow-up: `src/types/` DTO promotion + prompt
    directory unification.
  - W-INFRA Thread 4 follow-up: enforce knip on `exports` + `types`
    once the historic 487 unused exports / 52 unused types are
    cleared incrementally; delete the 3 ignored barrel files
    (`e2e/setup/test-helpers.ts`, `compliance-line-chart.tsx`,
    `src/lib/logging/index.ts`) once their dedicated tests can also
    be removed.
  - W-CONSENT iOS Settings hook-up (iOS-side) + AI feature gate
    read-side using `latestActiveReceipt(userId, kind)`.
  - W-APNS-NOTIFY `NotificationDispatch` table for the other 6 event
    types (only `MOOD_REMINDER` has a ledger today; the other six
    return `null` until the table lands).
  - W-WMY-WIRE: `computeLongWindowSummary` still has no production
    consumer (the in-marathon wire-in fans out through internal
    helpers, not the v1.4.39 public export). Production-call-site
    on the export remains the v1.5 multi-year UI consumer's job.
  - F-M-02 (rollup writers' dead `tx` parameter from v1.4.39
    backlog), F-M-03 (partial index `sum_value IS NULL`), F-M-05
    (`RollupBucketRow` shape consolidation), Specialist-M01
    (drop legacy-NULL UNION arm post-convergence), Simplifier
    dead exports (`isCumulativeType`, `readCumulativeDaySums`,
    `resolveBucketSum`, `ensureUserMedicationComplianceFresh`) —
    rolled forward from v1.4.39 backlog; none of these gate iOS work.
  - v1.5 architectural backlog (cross-tz per-user-tz bucketing, P5
    per-source rollup, P8 slope-window SQL move) — unchanged from
    v1.4.38 closure.

- **v1.5 readiness:** unblocked.
  - SB-3 / SB-4 / SB-5 / SB-6 / SB-7 / SB-10 closed.
  - SB-8 deferred as investigation-only per audit decision (not a
    blocker).
  - SB-9 optional (streak deprecation has no functional dependency).
  - AP-2 caveat: SB-5's time-sensitive APNs flag is inert until the
    `.p8` key is installed on production. **Release notes must
    carry this verbatim** so the iOS team / Marc don't chase the
    code when "medication reminders don't break through Focus"
    surfaces post-deploy.
  - iOS v0.5.4 compatibility verified: every shipped contract is
    additive (new endpoints, backward-compatible response envelope
    extensions). No new breaking endpoints.
  - Coolify auto-deploy fix from v1.4.38.4 is still in effect; the
    knip CI gate W-INFRA added runs on `push to main` + PRs targeting
    `main`, so the gate does not interfere with develop velocity.

## Risk register

- **Wall-clock perf wins are audit estimates, not measurements** —
  empirical-trace #1 (7.3 s pool stall → 1.6 s) is grounded in a
  Playwright-driven local trace against a Marc-shape fixture (82 490
  measurements × 8 types) but not against the production tenant.
  Mitigation: post-deploy `round-v1440-perf-verify.md` against Marc's
  tenant; release-notes phrase wins as "expected" until verified;
  rollback to v1.4.39.4 is clean (rollup reads have live fallback;
  Suspense boundaries are additive; concurrency cap is per-request).

- **Cross-agent commit-attribution drift — 4th recurring occurrence
  (process bug)** — W-APNS-NOTIFY's SB-6 work landed inside W-DELETED's
  `1bcaae47` dashboard-summary commit when the pre-commit hook
  absorbed staged-but-not-yet-committed parallel-wave changes.
  W-WMY-WIRE caught and reset a similar staging accident before push
  (`git reset --soft HEAD~1` recovery). W-RSC's factory-routing
  commit `8187d549` similarly drifted into the parallel APNS commit.
  This is the 4th recurring occurrence (also flagged in
  `project_v1437_final_web_release.md`, v1.4.38 marathon, v1.4.39
  product-lead review). **Mitigation for v1.4.41 marathon: per-agent
  `git worktree` is now a hard rule, not a recommendation.** Marc-Voice
  memory `feedback_marathon_worktree_isolation.md` does not exist yet;
  recommend creating it with the directive "every parallel wave runs in
  a dedicated worktree via `git worktree add`; no shared cwd across
  agents." Add worktree-per-wave to the `release-marathon` skill's
  standard flow. The release-notes / CHANGELOG sweep for v1.4.40 needs
  to pull SB-6 details from `1bcaae47` even though the commit message
  says `fix(dashboard-summary): exclude soft-deleted in sparkline and
  streak queries` — the diff carries +67 lines on the notifications
  status route + a new 181-line test file beyond what the title
  suggests.

- **Soft-delete contract — coverage gap on out-of-scope readers** —
  W-DELETED explicitly punted on read-only export / admin /
  doctor-report / gamification / reminder-worker / pr-detection-worker
  / withings paths. Risk: a v1.5 export bug-report could include
  tombstoned rows in a CSV; the doctor-report PDF could show a
  tombstoned reading. Mitigation: documented in W-DELETED's "NOT
  touched" section; schedule a v1.4.41 W-DELETED-2 sweep covering the
  read-only surfaces. Low user-facing impact today (Marc has not
  reported soft-delete usage), but iOS v0.5.4's by-external-ids sync
  is already capable of writing `deletedAt`.

- **APNS `.p8` env-var gap (AP-2)** — SB-5's time-sensitive
  interruption-level is inert until the production Coolify env has
  `APNS_KEY_ID` + `APNS_TEAM_ID` + `APNS_BUNDLE_ID` + one of
  `APNS_KEY` / `APNS_KEY_FILE`. The dispatcher gates every send on
  `loadApnsConfig()` returning non-null. Mitigation: release-notes
  must carry the AP-2 dependency verbatim; the iOS team should not
  attempt to verify the time-sensitive flag until the env is
  installed. Recommend: pre-deploy Coolify env check as a release-day
  gate.

- **W-CONSENT iOS Settings hook-up — uncalled today** — the consent
  endpoints (`POST /api/consent/ai`, `GET /api/consent/ai/latest`,
  `DELETE /api/consent/ai/latest`) are tested + audit-logged + GDPR
  Art. 7 compliant, but no client calls them yet. Risk: app-store
  reviewer following the Privacy Policy may exercise the "AI
  deaktivieren" toggle and find it doesn't actually revoke. Mitigation:
  iOS Settings hook-up before App-Store submission; release-notes
  flag the contract for the iOS team. Documented in W-CONSENT report
  as "Notes for downstream waves".

- **`ensureUserMedicationComplianceFresh` ambiguity** — W-GHOSTS held
  this in the false-positives list per the W-INSIGHTS brief saying it
  was being wired in parallel. W-INSIGHTS's report doesn't mention
  wiring it — only the `recomputeMedicationComplianceForEvent` hook
  path lands. Risk: dead-but-undeleted export survives in production
  bundle. Mitigation: trivial follow-up grep in v1.4.41 — either drop
  or wire. No functional impact.

- **`computeLongWindowSummary` still uncalled** — v1.4.39 W-WMY's
  public export, intended for a v1.5 multi-year UI consumer, still has
  no production caller after W-WMY-WIRE's marathon (the wire-in fanned
  out through internal helpers `computeAvg30LastYearForType` /
  `computeAvg30LastYearMap` because the use case is per-type-with-data
  not single-type). Risk: dead-tested code in production bundle.
  Mitigation: noted in v1.4.39 backlog `F-M-01`; v1.5 "year-in-mood"
  tile or Coach long-window prompt is the intended consumer; cheap to
  retain.

- **knip CI gate exclusion list** — W-INFRA Thread 4 ships knip with
  `exports` + `types` deliberately excluded from the failure set
  (487 unused exports + 52 unused types historic backlog would have
  made the gate red on day one). Risk: a new dead export ships
  silently because the gate doesn't enforce `exports`. Mitigation:
  Enforce knip on `exports` + `types` once the historic backlog is
  cleared incrementally — v1.4.41 / v1.4.42 should pick one module
  slice per release for cleanup.

- **Cross-tz proper-fix still v1.5** — the v1.4.38 cheap path
  (runtime guard with live fallback for non-near-UTC) remains in
  place; v1.4.39 mood + compliance rollups inherit the UTC-anchor
  trade-off; v1.4.40 didn't touch this. Risk: non-Berlin tenants
  silently fall through to live SQL for some tiers. Mitigation:
  documented across the rollup-tier audits; v1.5 per-user-tz
  bucketing closes the gap; Marc's tenant is fine.

- **Semver call — patch bump (1.4.40) confirmed** — features added:
  1 new table (`ConsentReceipt`), 4 new endpoints (3× consent, 1×
  notifications/status extended response), structural moves (umbrella
  rollups directory, queryKey factory entries), perf fixes
  (concurrency cap, pg.Pool max bump), 11 wave reports' worth of
  audit-debt closure. Zero API contract breaks. Per Marc's
  conservative-semver doctrine
  (`feedback_semver_conservative.md` — bugfix-heavy releases with
  additive-only features stay on patch), this is squarely additive
  inside the existing minor cycle → **v1.4.40 is the correct call**
  (v1.5 stays reserved for the iOS Swift sprint).

- **Release-marathon retrospective items** — beyond the worktree
  isolation directive above:
  - Eleven-wave dispatch with touch-disjoint partitioning worked
    cleanly (one collision caught + reset before push; one
    pre-commit-hook fold absorbed across waves but no functional
    loss). The "DO NOT touch" sections in each wave brief were the
    load-bearing discipline.
  - The W-INFRA Thread 1 pickup of W-POOL + W-DELETED gaps proves
    the value of a sequential cleanup pass after the parallel
    waves land. Recommend: every multi-wave marathon ends with a
    `W-INFRA`-shape cleanup wave that re-walks the audit findings
    against the merged state.
  - knip CI gate (W-INFRA Thread 4) is the structural answer to
    "another marathon, another 1 000+ lines of dead code". The
    gate now enforces forward; the historic backlog needs a
    cleanup cadence.
