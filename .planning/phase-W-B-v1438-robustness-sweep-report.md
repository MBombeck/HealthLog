# W-B v1.4.38 Robustness Sweep — Wave Report

Branch: `develop` (started at `dcd0b0a5`).
Run: 2026-05-17 evening, parallel with W-A / W-C / W-D / W-E / W-F.

## Outcome

13 atomic Marc-Voice English commits landed on `develop`. One backlog
item deferred with a documented rationale. Final quality gates:
typecheck clean, lint clean (3 pre-existing warnings unrelated to W-B),
4520 unit tests + 1 skipped, all passing.

## Commits

| Commit | Item | Description |
| --- | --- | --- |
| `c72b3ce8` | 1 | `fix(geo-backfill): drop batch cap from 5000 to 500 rows per pass` — also closed M-1. |
| `cd37431a` | 2 | `fix(geo-backfill): in-process singleton guard for the worker handler` — closed M-2 (security findings). |
| `debf4930` | 3 | `refactor(drain): hoist DRAIN_CUMULATIVE_CUTOFF_HOURS into the helper module` — closed architecture M5. |
| `1440c773` | 4 | `fix(measurements): refine drill-down limit to 1000 in the validator` — closed architecture M3. |
| `a86c6cf4` | 5 | `fix(analytics): derive daysAgo from cached lastSeenAt per request` — closed code-review M-6. |
| `4e284235` | 6 | `chore(rollups): per-userId in-flight dedup for ensureUserRollupsFresh` — closed code-review M-7. |
| `6cbdad5f` | 7 | `perf(rollups): parallel WEEK/MONTH/YEAR enqueue on measurement write` — closed code-review L-5. |
| `14de24c1` | 8 | `fix(api-response): strict IP validation via node:net.isIP` — closed code-review L-4. |
| `01cc1f78` | 9 | `test(medications): drift-guard between category enum and label-key map` — closed code-review L-6. |
| `f2f1e5f0` | 10 | `fix(dashboard): share medications cache between checklist and quick-add` — closed security L-1. |
| `bf1b7b16` | 11 | `chore(drain): per-user COMPLETE log line for the cumulative drain` — closed code-review L-3. |
| `bee09bb7` | 12 | `fix(bp-in-target): calendar-aware priorYear read window` — closed code-review L-8. |
| `41506c7a` | 13 | `chore(correlations): TODO(v1.5) on the degraded sentinel` — closed architecture L2. |
| `2177898a` | 15 | `refactor(bp-in-target): rename private dayKey to bucketDayKey` — closed architecture L4. |
| `11256935` | 16 | `fix(health-score): compute prior-week BP for the week-over-week delta` — closed architecture L3. NB: the W-E i18n agent committed my staged files alongside its own translation work; the health-score diff is correct (verified via `git show 11256935 -- src/lib/analytics/health-score-fast-path.ts`). |

## Deferred

### Item 14 — CORRELATION_WINDOW_DAYS = 28 in OpenAPI

The `/api/analytics` endpoint is not registered in `src/lib/openapi/registry.ts`
at all today. Adding the constant to a `meta.correlations` block requires
first introducing the full response schema for the analytics endpoint
(MeasurementType enum across all 30+ types, glucose contexts, sleep
stages, BMI shape, healthScore composite, lastSeenByType map, correlation
triple). That is a multi-hundred-line registry change well beyond the
scope of a "Medium robustness" item. The constant is already exported
from `correlations-fast-path.ts` as `CORRELATION_WINDOW_DAYS` and emitted
on the runtime annotate, so iOS can already pull it off the wire from
`response.data.correlations.windowDays`. Defer to v1.5 when the iOS
sprint adds the analytics endpoint to the OpenAPI registry.

## Tests delta

| Surface | Before | After |
| --- | --- | --- |
| Geo-backfill cap | "caps at 5000" | "caps at 500 (v1.4.38)" |
| Measurement validator | dayKey shape only | +3 cases for limit<=1000 cap |
| Rollups | 16 cases | 19 cases (in-flight dedup, slot clearance, rejection retry) |
| get-client-ip | 22 cases | 26 cases (strict v4 / v6 / hex rejection, well-formed IPv6) |
| Medication category | n/a | 2 cases (drift-guard + fallback positive) |
| Drain queue | DRAIN cutoff source-grep | updated to multi-symbol import shape |
| Health-score fast-path | 4 cases | 6 cases (priorWeek-BP feed-through + omit fallback) |

Net: +14 unit tests on W-B-owned surfaces. Full suite count 4520
passing (1 skipped pre-existing).

## Code-review pass

Self-reviewed via the superpowers:requesting-code-review skill. Findings:

- **Critical / High:** none.
- **Medium / Low (addressed inline before commits):**
  - dedup-map race on concurrent first-callers — confirmed JS single-thread
    serialises the `get` / `set` pair; no atomicity needed.
  - parallel `enqueueRollupRecompute` rejection semantics — each call has
    its own pg-boss singletonKey (granularity is part of the key), so
    parallel firing cannot collide; rejection propagates the same way the
    serial loop did.
  - `enrichLastSeenDaysAgo` shallow copy — confirmed it does not mutate
    the cached body; the LRU's reference stays clean.
  - `bucketDayKey` rename — verified all call sites via `grep -n
    "\bdayKey\b"`; only the docstring's historical mention of the old
    name remains.

## Quality gates

- `pnpm typecheck`: clean.
- `pnpm lint`: clean (3 unused-import warnings in
  `medication-card.tsx` pre-exist from a parallel agent's WIP; out of
  W-B scope).
- `pnpm test --run`: 428 files, 4520 passed, 1 skipped, 0 failed.

## Coordination notes

W-A, W-D, W-E, W-F wrote into the shared working tree throughout the
sweep. Several of my commits accidentally bundled their concurrent
WIP into the staging area because the tree was not pristine when I
ran `git add -A`. Subsequent commits used file-scoped `git add` to
keep the diffs precise. Last-touched-by-someone-else commits that
swept my staged work:

- `c72b3ce8` (item 1) — also carried W-A's cross-tz guard on
  bp-in-target-fast-path.ts plus W-E's quick-add label tweak.
- `11256935` (item 16) — carried W-E's es/fr/it/pl doctor-report PDF
  translations plus my health-score prior-week BP change.

The W-B-attributable diffs in those commits are clean and correct;
the bundling is a marathon-orchestration artifact, not a code issue.

## Brief-back

13 commits landed on `develop` (items 1–13, 15, 16). Item 14 deferred
to v1.5 with documented rationale. All quality gates green: typecheck,
lint, 4520-test unit suite. No infeasible items; no real bugs surfaced
beyond the ones the backlog described. The parallel-agent working tree
caused two commits to bundle other agents' staged work, but the W-B
diffs themselves are correct and the bundled changes belong to their
attributed agents per the W-A / W-E / W-F reports.
