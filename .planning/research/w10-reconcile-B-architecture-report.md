# v1.4.25 W10 Reconcile B — Architecture Fixes Report

**Scope:** Senior-dev + Code-review High + Medium findings touching
analytics, source-priority, and schema-level concerns. Fix-A (low-risk
cosmetics) and Fix-C (auth + Coach + measurement-batch) own the
remaining buckets.

**Branch:** `develop` @ `/Users/marc/Projects/HealthLog`
**Commits this session:** 5
**Quality gates:** `pnpm typecheck` clean · `pnpm lint` clean ·
`pnpm test` 2644 passed / 1 skipped · `pnpm test:integration` clean
for every relevant suite.

---

## Findings addressed

### Senior-dev H-1 — Batch-ingest race reconciliation logically inverted
Status: **Not applied (Fix-C scope).**
`src/app/api/measurements/batch/route.ts:240–278` is on Fix-C's exclusive
file list; this agent did not touch it.

### Senior-dev H-2 — Picker's mixed-MeasurementType bucket comment didn't match code
Status: **Applied.**
Commit: `db5e07a` — *fix(source-priority): resolve device-type ladder
per row in mixed-type buckets.*

Picked option (a): make the code match the comment. The picker now
groups present device-types per row-type, resolves each type's ladder
from the existing `ladderCache`, and picks the winning device-type
independently per type. Single-type buckets (today's only call site)
exhibit identical behaviour; mixed-type buckets (future Coach evidence
rollup, doctor-PDF section, correlations engine) preserve every type's
winner instead of testing against the wrong ladder.

Two new tests in `src/lib/analytics/__tests__/source-priority.test.ts`:
  - per-row ladder resolution preserves each type's winner
  - per-type fall-through when a custom ladder is unreachable

Also added the determinism precondition (Sr-M-1) to the JSDoc on
`pickCanonicalSourceRows` — same commit, same docblock.

### Senior-dev M-1 — Source-priority determinism depends on input order
Status: **Applied** (folded into the H-2 commit).
Added a JSDoc precondition to `pickCanonicalSourceRows` documenting
that input rows must be in a deterministic order (typically
`ORDER BY measuredAt ASC, id ASC`).

### Senior-dev M-2 — `parseSourcePriority` silently swallows malformed JSON
Status: **Applied.**
Commit: `2bb49ae` — *chore(source-priority): observable parse failures
+ frozen resolved blob.*

Emits a wide-event tag (`sourcePriority.parse: "failed"` +
`issueCount` + `firstIssuePath`) via `annotate()` when the Zod
safeParse fails. `annotate()` is a no-op outside a request context so
static settings-page renders and unit tests stay side-effect-free. A
future schema-tightening that silently nukes a user's saved ladder
will now surface in ops dashboards.

### Senior-dev M-3 — Workout uniqueness key collides across sources
Status: **Applied (TODO, not strategy change).**
Commit: `cf5d6c4` — *docs(workout): TODO for cross-source workout
dedup at v1.5 iOS landing.*

Picked the TODO route rather than extending `pickCanonicalSourceRows`
to workouts in this release: workouts have no consumer surface yet
(W8d is schema-only; no detection worker, no dashboard tile), no iOS
client exists, and a workout-canonical-picker would design
prematurely. The model-level docblock points at `pickCanonicalSourceRows`
as the symmetric helper the v1.5 P1 sprint should build against.

### Senior-dev M-4 — `/api/personal-records` GET has no pagination
Status: **Applied.**
Commits: `eb49d8a` (route) + `3dff934` (tests).

Default 100, max 500 via `?limit=`. Matches the
`listMeasurementsSchema` ceiling so every ingest-and-read endpoint
shares one upper bound. Garbage values silently clamp to default
rather than 400-ing (same defence-in-depth posture the `metricType`
parse already uses). Five test cases cover default, valid limit,
clamp, and garbage-input fallback.

### Code-review H1 — `berlinIsoWeekday()` hard-coded Europe/Berlin
Status: **Applied.**
Commit: `71745b4` — *fix(analytics): thread user timezone through the
weight-weekday correlator.*

W7's per-user-tz sweep missed the weight-weekday correlator. Replaced
the module-level `Intl.DateTimeFormat` with a per-tz memoised lookup,
renamed `berlinIsoWeekday()` → `isoWeekdayInTz(d, tz)`, renamed the
misleading `dateFromBerlinKey()` → `dateFromDayKey()`, and threaded
`userTz` through the call site.

New integration test `tests/integration/analytics-weekday-tz.test.ts`:
  - seeds 28 weight readings at a UTC instant where Berlin and
    Auckland weekdays disagree, against an `Pacific/Auckland`-tz user;
    confirms the correlator received every row and reached the `n >=
    20` gate against the user's tz.
  - Berlin-tz fallback path locks in the no-regression contract.

### Code-review M1 — `parseSourcePriority` alias-vs-copy invariant
Status: **Applied** (folded into the M-2 commit).
Deep-freeze the resolved blob: every ladder array, every
`deviceTypePriority` container value, the `merged` object, the
`deviceTypePriority` root, and the `resolved` root. A caller mutating
`resolved.metricPriority.weight = […]` post-parse now trips at
runtime in strict mode instead of silently desyncing the two views.

### Code-review M2 / M3 / M4 / M5
Status: **Not applied (Fix-C scope).**
M2 (`src/lib/insights/glp1-plateau.ts`), M3
(`src/lib/ai/coach/glp1-snapshot.ts`), M4
(`src/lib/validations/measurement.ts`), and M5 (`src/lib/api-handler.ts`)
all sit on Fix-C's exclusive file list. The reconcile-B prompt named
them explicitly except for M5 (`api-handler.ts`), which the
exclusive-file list still claims; flagged here so Fix-C's report can
pick them up.

---

## Commits in order

1. `db5e07a` — fix(source-priority): resolve device-type ladder per row in mixed-type buckets *(H-2 + Sr-M-1 docstring)*
2. `71745b4` — fix(analytics): thread user timezone through the weight-weekday correlator *(Code-H1)*
3. `2bb49ae` — chore(source-priority): observable parse failures + frozen resolved blob *(Sr-M-2 + Code-M1)*
4. `cf5d6c4` — docs(workout): TODO for cross-source workout dedup at v1.5 iOS landing *(Sr-M-3)*
5. `eb49d8a` — fix(personal-records): clamp findMany result count via ?limit pagination *(Sr-M-4)*
6. `3dff934` — test(personal-records): coverage for limit clamp + default value *(Sr-M-4 test)*

Six atomic commits — within the ~4–6 expected range; the M-4 fix was
split into route + test commits because the test surface needed three
new cases rather than a tweak to one assertion.

---

## Tests added / updated

  - `src/lib/analytics/__tests__/source-priority.test.ts` — two new
    cases for H-2 mixed-type bucket and per-type fall-through.
  - `tests/integration/analytics-weekday-tz.test.ts` — new file, two
    cases (non-Berlin user + Berlin default).
  - `src/app/api/personal-records/__tests__/route.test.ts` — three new
    cases (explicit limit, clamp, garbage fallback) + assertion updates
    on the three existing cases for the new default `take: 100`.

---

## Files modified

  - `src/lib/analytics/source-priority.ts`
  - `src/lib/analytics/__tests__/source-priority.test.ts`
  - `src/lib/validations/source-priority.ts`
  - `src/app/api/analytics/route.ts`
  - `src/app/api/personal-records/route.ts`
  - `src/app/api/personal-records/__tests__/route.test.ts`
  - `prisma/schema.prisma` (TODO comment only — no migration; `prisma
    validate` clean)
  - `tests/integration/analytics-weekday-tz.test.ts` (new file)

No files outside this list were modified by this agent. The working
tree at hand-off contains unstaged edits from Fix-C / Fix-D agents
(messages JSON, GLP-1 surfaces, sub-page-shell, etc.) — those belong
to the parallel agents' commits, not this one.

---

## Quality gates at hand-off

```
pnpm typecheck     — clean
pnpm lint          — clean
pnpm test          — 295 files / 2644 passed / 1 skipped
pnpm test:integration source-priority-two-axis · analytics-sleep-stages
   · analytics-weekday-tz · analytics-bp-aggregate-paged
   · analytics-health-score — 5 files / 12 passed
```
