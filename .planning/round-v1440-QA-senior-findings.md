# v1.4.40 Senior-dev review — findings

Scope: `git diff v1.4.39.4..develop` (55 commits, ~8 100/2 265 lines,
140 files) across 11 waves (`W-POOL`, `W-DELETED`, `W-INFRA`,
`W-INSIGHTS`, `W-PRIVACY`, `W-AASA`, `W-APNS-NOTIFY`, `W-CONSENT`,
`W-RSC`, `W-WMY-WIRE`, `W-GHOSTS`).

Review method: read all 11 wave reports + 5 v1.4.39 architecture-QA
anchors; spot-checked the highest-risk diffs (`api/analytics/route.ts`,
`lib/db.ts`, `lib/rollups/measurement-rollups.ts`, `app/page.tsx`,
`lib/notifications/senders/apns.ts`, `.well-known/apple-app-site-association/route.ts`);
swept every production `prisma.measurement.*` call site for `deletedAt:
null`; verified five random importer rewrites under the new
`@/lib/rollups/*` umbrella; ran `pnpm typecheck`, `pnpm lint`, `pnpm
knip`, the rollup test suite (93/93), the wave-focused subset (320/320
across 8 + 32 files), and `pnpm test --run` (full unit suite).

---

## Critical (release-blocking)

### C1 — Full unit suite is RED on develop: 1 failing test (W-RSC ↔ W-INFRA Thread 2 drift)

`pnpm test --run` reports **`1 failed | 4725 passed | 1 skipped`** at
HEAD `8e9a7891`. The failure is in
`src/app/__tests__/dashboard-suspense-boundaries.test.ts:78`:

```js
expect(src).toMatch(
  /const\s+hour\s*=\s*useMemo\([\s\S]*?\[\s*user\?\.timezone\s*\][\s\S]*?\);/,
);
```

W-RSC (commit `3cacfcf9`) wrote the dashboard memo as `useMemo(() =>
…, [user?.timezone])`. W-INFRA Thread 2 (commit `8974e773`) had to
lift `const userTimezone = user?.timezone` to a local *before* the
memo to satisfy React Compiler's
`preserve-manual-memoization` rule (optional-chain expression
inferred a less specific property than declared). The post-fix code
at `src/app/page.tsx:577-580` reads `useMemo(…, [userTimezone])`,
which the regex (`user\?\.timezone`) cannot match.

The W-RSC and W-INFRA reports both flagged "cross-agent commit-message
drift" as a recurring pattern; this is the same pattern producing an
actual test failure, not just a misattributed commit. Marc directive
explicitly requires `pnpm test` to be green at tag time.

**Fix:** widen the regex to accept `[userTimezone]` as the dep array,
or update both reads to `userTimezone` and lift the local before the
memo so the canonical form is single-source. Either is a one-line
edit; the test was specifically written to be structurally
load-bearing, so updating it without re-introducing the assertion's
purpose is correct.

**Severity rationale:** every release marathon to date enforces
"green CI" as a gate. Shipping with a red suite would breach Marc's
PII/CHANGELOG/release discipline and erode trust in the gate.

---

## High (must-fix before tag)

### H1 — Soft-delete leaks remain in the Insights cluster reader surface

W-DELETED explicitly excluded `src/app/api/insights/**` and
`src/lib/insights/{glp1-plateau,pulse-status,features,…}.ts` with the
note that W-INSIGHTS was "actively modifying for the mood-rollup
swap" and would filter on re-touch. The W-INSIGHTS phase report does
not mention adding `deletedAt: null` to any of the seven
`prisma.measurement.findMany` sites in the cluster.

Confirmed by spot-grep (production callers, excluding generated +
tests):

| File | Line | Status |
| --- | --- | --- |
| `src/app/api/insights/targets/route.ts` | 181, 205, 1195 | **no `deletedAt: null`** |
| `src/app/api/insights/cards/route.ts` | 73 | **no `deletedAt: null`** |
| `src/app/api/insights/generate/route.ts` | 136 | **no `deletedAt: null`** |
| `src/lib/insights/features.ts` | 378 | **no `deletedAt: null`** |
| `src/lib/insights/glp1-plateau.ts` | 72 | **no `deletedAt: null`** |
| `src/lib/insights/pulse-status.ts` | 157 | **no `deletedAt: null`** |
| `src/lib/insights/comprehensive-aggregator.ts` | (raw SQL) | filtered |
| `src/lib/ai/coach/snapshot.ts` | 495-500 | filtered |

These are user-facing surfaces (tile rendering, AI Coach prompts,
GLP-1 plateau alerts, pulse-status insight). Once iOS soft-deletes
its first reading, the tombstoned row still contributes to:

- `/api/insights/targets` 30-day average + 1-year "latest ever" tile
  values (the audit's Critical Finding #2 fix that landed for the
  distinct-floor only).
- `/api/insights/cards` the 90-day mood/BP/weight/pulse window the
  iOS-adapter card stream consumes.
- `/api/insights/generate` the AI feature payload (so the model
  grounds against deleted data).
- The GLP-1 plateau detector + pulse-status helper that feed Coach
  + the dashboard tile-strip.

This is the same bug class the audit's Critical Finding #3
documented; W-DELETED closed the dashboard + analytics + summaries
+ rollup tiers; the Insights cluster is the only family left
leaking. Either W-INSIGHTS missed the secondary directive or
W-DELETED's deferral note wasn't picked up.

**Fix:** add `deletedAt: null` to all six `findMany` `where` clauses
above. Three of them already have an `m."deleted_at" IS NULL` sibling
in their adjacent rollup-tier branch (comprehensive-aggregator), so
the team-style pattern is locked in. One commit, one test (extend the
existing `tests/integration/measurement-soft-delete.test.ts`).

**Severity rationale:** iOS sync ships in v1.5 P1 against locked
contracts. A tombstone leak in Insights would manifest the moment a
user soft-deletes their first reading from the iOS app and refreshes
the dashboard. The W-DELETED integration test pins three contracts;
extending to insights/targets is the cheapest closure of the gap.

---

## Medium (should-fix; otherwise v1.4.41 backlog)

### M1 — `Promise.all` over `recomputeMedicationComplianceForEvent` is correct, but the comment in the route is misleading

`src/app/api/medications/intake/route.ts:177-186` +
`src/app/api/dashboard/summary/route.ts:362-376` both call
`Promise.all(recomputeJobs)` with no outer try-catch.

The comment "best-effort: errors stay caught inside the helper" is
accurate — `recomputeMedicationComplianceForEvent` swallows every
error in its internal try-catch at line 261 and logs an annotate
+ console.error. The helper's signature returns `Promise<void>`
that never rejects. So `Promise.all` is safe in practice.

**Issue:** the contract is implicit — a future refactor that changes
the helper to re-throw (or a sibling helper added with the same shape
but different error handling) would silently break both bulk write
paths. The convention in `by-external-ids/route.ts:135-137` is the
opposite — an explicit `try { … } catch (err) { console.warn(…) }`
wrapper around the loop.

**Fix:** either (a) mirror the by-external-ids wrapper pattern for
symmetry, or (b) add an inline comment pointing at line 261 of
`medication-compliance-rollups.ts` so the implicit contract is
discoverable. Cheap follow-up; not release-blocking.

### M2 — Insights cluster's measurement findMany sites are also unbounded windows in places

`src/lib/insights/features.ts:378-383` walks `measurement.findMany`
with a conditional `sinceCutoff` — when the caller passes no
`sinceDays`, the query is unbounded. The W-INSIGHTS report claims
the post-swap fallback is 1-year-bounded; the actual code still
admits an unbounded path. Same pattern as the audit High Finding 2
that the wave was meant to close.

`src/app/api/insights/generate/route.ts:136-140` likewise has no
`measuredAt` filter at all — it walks every measurement for the
type per AI generation call.

`src/lib/insights/glp1-plateau.ts:72-80` is windowed (90-day
`PLATEAU_WINDOW_DAYS`).

`src/lib/insights/pulse-status.ts:157-168` is bounded by `take: 365`.

**Fix:** wave's stated 1-year floor needs to be enforced in
`features.ts` (else `extractMeasurementFeatures()` walks 5-year
history on every Coach prompt mint) and ideally in `generate/route`
(or document why generate intentionally walks the full history —
which may be load-bearing for trend math). Defer to v1.4.41 unless
Marc wants to fold into the H1 fix above.

### M3 — Compliance-rollup recompute calls fire in serial within Promise.all but the helper itself runs serially against pg

`recomputeMedicationComplianceForEvent` (line 245) does one
`prisma.medicationIntakeEvent.findMany` + one `prisma.medicationCompliance*.upsert`
per call. With 5 meds × 3 schedules × 1 day, the wave's `Set<dayKey>`
coalesce already reduces to N=5 (one per medication). N=5 parallel
upserts to pg is well within budget. No issue today; flag because
the comment in W-INSIGHTS' phase report claims "worst case
medications × 1" — true for the coalesce step, but the parallel pg
write fan-out is N, not 1, and shares the same `pg.Pool` that W-POOL
just raised to 20. The combined cold-mount fan-out (analytics × 4 +
compliance × 5 + slim/thick × 2 + tile-strip × 6) stays under the
ceiling. No fix needed.

### M4 — Knip's `exports` + `types` baseline (487 + 52 historic) is deferred

W-INFRA Thread 4 deliberately omits `exports` and `types` from the
knip failure set this release to avoid red CI on day one. The
ignored backlog is sizeable. The wave intent is "enforce
incrementally". Risk: a new dead export today sits in the noise
unnoticed for waves. Not release-blocking; the gate is additive over
the previous zero-coverage state.

**Fix:** open a v1.4.41 wave that picks one slice (`src/lib/analytics`,
say) and turns on `exports` + `types` enforcement scoped to that
slice via `knip.json` per-workspace config. The current
`ignore`/`ignoreDependencies` pattern already proves the per-slice
opt-in approach works.

---

## Low (cosmetic / future-proofing)

### L1 — AASA route has no charset preservation test for non-ASCII operator names

The AASA test pins `Content-Type: application/json` exactly (no
charset). The current response body is pure ASCII so there's no
encoding hazard. If a future maintainer adds umlauts (e.g. an
operator field carrying "Nürnberg"), the JSON response would still
serialise UTF-8 by default but the missing `charset` could trip a
DPA reviewer's parser. Out of band for AASA itself (Apple's
`swcd`/aasa-validator refuse `charset` annotations), but worth a
comment in the route file noting the deliberate omission.

### L2 — Privacy policy `data-slot` markers good for tests but unwired in UI

W-PRIVACY notes `data-slot="privacy-last-updated"` is "the canonical
hook for any in-app 'policy updated' surface (currently unwired —
would be a v1.5 nice-to-have)". Carrying a test contract for an
unwired UI hook is fine, but if v1.5 doesn't ship the consumer the
hook drifts. Schedule the consumer wire-up alongside the v1.5 iOS
sprint.

### L3 — Cross-agent commit drift acknowledged in 3 wave reports

W-APNS-NOTIFY, W-WMY-WIRE, W-RSC each flag commit-attribution drift.
The C1 finding above shows the pattern producing real test breakage,
not just message-level confusion. W-RSC's suggested mitigation
(`git worktree`-per-wave) is the right structural fix. Flag for the
v1.4.41 marathon kick-off directive — single-shared-cwd model leaves
the index race open whenever two parallel agents' `git add`s land in
the same second.

### L4 — Knip whitelist carries 3 files for a future "delete with their test" pass

`e2e/setup/test-helpers.ts`, `compliance-line-chart.tsx`,
`src/lib/logging/index.ts`. W-INFRA notes the deletion of these is
deferred pending verification that their dedicated tests are also
removable. Cheap follow-up.

---

## Wave-by-wave verdict

| Wave | Verdict | Notes |
| --- | --- | --- |
| W-POOL | Ship | `pLimit(4)` correctly preserves 60s LRU cache wrap (per-call instance, not module-level). `pg.Pool max=20` interaction safe (5 × 20 = 100 = Postgres `max_connections` default). |
| W-DELETED | Ship | Scoped to the audit's user-facing critical surfaces. The deferred export/admin/doctor-report/withings + iOS-sync paths are correctly out of scope. **But the W-INSIGHTS hand-off (insights/**) leaked — see H1.** |
| W-INFRA | Ship | Umbrella move clean (zero orphan re-exports — verified by grep on `@/lib/measurements/rollups` etc.). All 93 rollup tests pass post-restructure. Random 3-file importer spot-check (`insights/targets`, `mood-entries`, `insights/comprehensive`) all bind to `@/lib/rollups/mood-rollups`. Knip CI gate scoped sensibly. **Thread 2 broke W-RSC's test — see C1.** |
| W-INSIGHTS | Patch then ship | Mood-rollup swap on the three target routes lands cleanly + compliance-rollup hook gap closed with proper coalescing + SB-7 pinned. **But missed `deletedAt: null` on every prisma.measurement findMany in the cluster — see H1.** |
| W-PRIVACY | Ship | Bilingual paired-section pattern is the right call (legal documents must not depend on JS for locale switching). 17 tests cover the 9 SB-3 requirements + PII discipline. |
| W-AASA | Ship | Payload matches `S8WDX4W5KX.dev.healthlog.app` exactly. App-ID-parity assertion guards against split rotation. Content-Type discipline (no charset) honoured for Apple's swcd. |
| W-APNS-NOTIFY | Ship | Conditional `interruption-level: time-sensitive + priority 10` scoped to MEDICATION_REMINDER only. Parameterised test pins all 6 other event-types do NOT bypass Focus. Backwards-compat `events` map preserves channels shape. **AP-2 .p8 env-var caveat correctly flagged for release notes.** |
| W-CONSENT | Ship | Append-only invariant pinned in test; revoke-then-regrant leaves both rows; idempotent DELETE returns 200 + `receipt: null`. |
| W-RSC | Patch then ship | Per-tile Suspense boundaries genuinely stream independently (the parent gate is the slim/thick analytics merge, which is now correctly split per the v1.4.39.2 commit; the Suspense layer is structural-future-proofing for the v1.4.41 RSC migration). `mood-chart` queryKey dedup eliminates one round-trip. Factory-bypass guard test is a smart cheaper-than-ESLint move. **C1 affects this wave's test asset.** |
| W-WMY-WIRE | Ship | Three previously-dead WMY readers now have production traffic via `summaries-slice` + `health-score-fast-path`. Linear-composability parity test pins the cross-consumer routing contract. |
| W-GHOSTS | Ship | Net ~1 177 lines removed across 9 atomic commits. False positives correctly kept (`detectAnomalies` transitively reachable, the three WMY readers wired by sibling wave). `startOfUtcDay` + `wallClockInTz` consolidation eliminates a sibling-drift risk. |

---

## Quality gates (run during this review)

| Gate | Status | Notes |
| --- | --- | --- |
| `pnpm typecheck` | green | clean, no errors |
| `pnpm lint` | green | zero warnings, zero errors |
| `pnpm knip --include files,dependencies,binaries,unlisted` | green | zero output, exit 0 |
| `pnpm test --run src/lib/rollups/__tests__` | green | 93/93 passing |
| `pnpm test --run` (full unit) | **RED** | 1 failed / 4725 passed / 1 skipped — see C1 |
| `pnpm test --run` wave subsets | green | 320/320 across analytics, db, notifications, consent, well-known, privacy, insights, medications, dashboard, registration-status |

---

## Brief-back (≤200 words)

**v1.4.40 is one fix away from ship-ready.** The full unit suite is
red on `develop` because W-INFRA Thread 2 lifted `userTimezone` to a
local in `app/page.tsx` to satisfy the React Compiler memo rule, but
the W-RSC dashboard-suspense-boundaries test still pins the original
`[user?.timezone]` dep shape (C1). One-line regex update or one-line
code edit fixes it.

The structural release is otherwise solid: 11 waves landed touch-
disjoint, the umbrella move under `@/lib/rollups/*` is clean with
zero orphan imports, AASA payload matches the iOS contract, the
APNs time-sensitive opt-in is correctly scoped to MEDICATION_REMINDER
only, the consent CRUD + append-only invariant pins SB-10, the
per-tile Suspense boundaries are structurally sound, and the
WMY-reader wire-in finally lights up the previously-dead MONTH
buckets.

The one substantive scope gap is **H1** — the Insights cluster
(`/api/insights/targets`, `cards`, `generate` + the
`lib/insights/{features,glp1-plateau,pulse-status}` helpers) still
walks `prisma.measurement.findMany` without `deletedAt: null`,
because W-DELETED deferred to W-INSIGHTS and W-INSIGHTS missed the
secondary directive. Cheap to close (6 sites, one commit, one test).

**Ship-readiness verdict:** patch C1 + H1, then tag.
