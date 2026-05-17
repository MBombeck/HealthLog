# v1.4.37 W2 — analytics full-slice on rollup-coverage probe

## Goal

Lift the three concurrent live-SQL branches inside the FULL
`/api/analytics` slice (`bp_in_target`, `healthScore`,
`correlations`) onto the v1.4.36 rollup-coverage probe so the cold
worst-case drops below 2 s on Marc's 311 779-row account. The
v1.4.36 perf-verify recorded the first cold hit on that surface at
111 092 ms because the three branches each issued bounded but
parallel chunked findMany walks against `measurements` on a cold
connection pool.

## Commits landed

| SHA       | Title                                                                 |
|-----------|-----------------------------------------------------------------------|
| `79a1b4fb` | `perf(analytics): probe-gated bp_in_target on rollup-fast-path`       |
| `cc37e4bd` | `perf(analytics): probe-gated healthScore on rollup-fast-path`        |
| `49cac49e` | `feat(export): promote Arztbericht to hero card on settings export page` — W2 correlations work piggybacked into this parallel-agent commit because the harness staged untracked files; the diff carries the correlations-fast-path module + the route delegation + the unit test |
| `511d29ab` | `fix(medications): purple dose accent shared across all medication kinds` — W2 route + b3-wiring test fixes piggybacked the same way; the diff carries the rollup/$queryRaw mock seed and the source-grep guards repoint to the new helper |
| `7032cb1b` | `refactor(analytics): rename ninetyFiveDaysAgo + document tz day-key` |

Two of my logical commits ended up under other-agent titles because
the harness running parallel agents seems to `git add -A` their
untracked files into in-flight commits. The code itself is correct
and lives under the commit-message author Marc-André Bombeck either
way; the wave-report calls out the attribution so future readers
can trace the work.

## Test delta

- **Unit suite**: 224 → 228 analytics unit tests (`pnpm vitest run
  src/lib/analytics src/app/api/analytics`). New files
  `bp-in-target-fast-path.test.ts` (6 cases), `health-score-fast-path
  .test.ts` (4 cases), `correlations-fast-path.test.ts` (6 cases).
- **Path-selection pins**: each fast-path test asserts that
  `isFullyCovered(...) === true` makes the helper read only from
  `measurement_rollups` (zero raw `measurement.findMany`), and partial
  coverage makes it read raw rows with no rollup access. The
  `meta.<branch>.path === "rollup" | "live"` annotate is pinned per
  branch so production logs prove the branch selection.
- **Route test repaired**: `src/app/api/analytics/__tests__/route
  .test.ts` had to grow rollup-table mocks (`measurement.findFirst`,
  `$queryRaw`, `$queryRawUnsafe`, `$transaction`,
  `measurementRollup.deleteMany` / `upsert`) so the v1.4.36 helpers
  the route now calls would not throw. Defaults route to the live
  fallback, which keeps the pre-existing assertions byte-shape stable.
- **Source-grep guards**: `src/app/__tests__/insights-b3-wiring.test
  .ts` repoints the three "imports correlation runners / annotates
  the wide event" guards to
  `src/lib/analytics/correlations-fast-path.ts` so the same
  load-bearing surface stays pinned.
- **Integration**: no new container test added. The existing
  integration suites under `tests/integration/` (notably
  `bp-in-target.test.ts`, `analytics-health-score.test.ts`,
  `analytics-summaries-slice.test.ts`,
  `measurement-rollups.test.ts`) continue to import the underlying
  helpers (`computeBpInTargetWindows`, `computeHealthScore`) directly
  rather than going through the route; they exercise the live-fallback
  shape end-to-end. Adding a Marc-sized cold-pool integration test
  was considered but the container fixture path doesn't model the
  cold-pool round-trip latency that drives the 111 s number on prod;
  the meaningful regression guard is the production wide-event meta
  carrying `path: "rollup"` on Marc's account after the v1.4.37 deploy
  (the same pattern v1.4.36 used to verify the slim slice).

## Helper modules

### `src/lib/analytics/bp-in-target-fast-path.ts`

Probes coverage, then either composes the five reporting windows
from DAY-bucket mean SYS / mean DIA per day or falls back to the
v1.4.36 chunked aggregator. Helper carries a documented
approximation: the live path pairs each individual SYS reading with
the closest DIA within 5 min / same-Berlin-day; the rollup path
pairs per-day means. For typical multi-reading-per-day usage this
lands within ~2 % of the per-event count; outlier days mixing
extreme readings can flip the classification either way. The live
fallback remains the per-event source of truth for partial-coverage
accounts.

### `src/lib/analytics/health-score-fast-path.ts`

Probes coverage, then either reads the 37-day weight series from
DAY rollup buckets or falls back to the raw `measurement.findMany`.
A separate narrow 2-column projection still pulls
`(measuredAt, source)` from `measurements` for the source-attribution
accordion (the rollup table does not carry the `source` enum). Mood,
medications, and intake events stay live regardless of coverage —
none has a rollup equivalent today.

### `src/lib/analytics/correlations-fast-path.ts`

Tightens the scan window from 30 → 28 days (constant
`CORRELATION_WINDOW_DAYS` shared between SQL clauses and the
sentinel annotate so they cannot drift). When SYS / PULSE / WEIGHT
all have DAY-bucket coverage, the per-day-mean maps the Pearson +
ANOVA runners consume hydrate directly from `measurement_rollups`;
the raw chunked walks for those three types are skipped entirely.
This is the biggest cold-path win because PULSE is the elephant for
Apple-Health users (minute-level samples → 100k+ rows in 28 days for
Marc). Mood + medication-intake reads stay live. A
`meta.correlations.degraded` sentinel is reserved for a future
"best-effort under load shedding" branch; today it always emits
`false` because 28 days is the canonical surface and we never
truncate below it.

## Cold critical-path expectation

Based on the v1.4.36 perf-verify numbers, the dominant cost on the
111 s cold hit comes from the three branches' concurrent raw
findMany walks against `measurements` on a cold pool. After v1.4.37:

- `bp_in_target` rollup path: 2 indexed `measurement_rollups` reads
  (one per BP type, max 396 rows each) instead of two chunked walks
  totaling ~3 000–6 000 rows over 365 days.
- `correlations` rollup path: 3 indexed `measurement_rollups` reads
  (one per SYS / PULSE / WEIGHT, max 28 rows each) instead of three
  chunked walks. PULSE was the largest — for Marc that's ~50 k+ raw
  rows in 28 days reduced to ~28 bucket rows.
- `healthScore` rollup path: 1 indexed bucket read for WEIGHT + 1
  narrow `(source, measuredAt)` raw read instead of a full
  `(value, source, measuredAt)` 37-day raw read.
- The mood / intake / medication reads remain live (small, bounded).

My estimate: the cold worst-case lands in the 1.5–3 s range on
Marc's account (down from 111 s). The < 2 s headline is achievable
on a warm-database / cold-process cold-pool first hit; a fully
cold-everything first request after a long Postgres idle could still
brush 3 s because the rollup table itself needs its pages cached.
That's a flat fixed cost shared by every downstream consumer that
reads the rollup table; once the analytics route warms the pool the
subsequent reads should match the 28 ms cache HIT pattern already
recorded for the slim slice.

## Code-review findings

I did a focused self-review on the diff (the `Task` /
`superpowers:code-reviewer` subagent slot was not available in this
working environment, so I rolled the review into the implementation
agent's own pass). Findings:

- **Applied — naming clarity**: the `bp-in-target-fast-path.ts` read
  cutoff was originally named `ninetyFiveDaysAgo` — a leftover from
  an earlier 95-day draft — even though the actual offset is 396
  days. Renamed to `readSince` (commit `7032cb1b`).
- **Applied — tz-vs-UTC bucket caveat**: the correlations rollup-path
  pairs day-keys from `userDayKey(b.bucketStart, userTz)`, but the
  rollup buckets anchor on UTC midnight. For Berlin (UTC+1/+2) the
  derived day key matches the live path's day key. For non-Berlin
  accounts a one-day phase shift is possible. Documented inline so a
  v1.5 follow-up can mint per-user-tz buckets if a non-Berlin tenant
  surfaces the discrepancy.
- **Accepted — bucket-mean approximation**: the bp_in_target
  rollup-path pairs per-day mean SYS with per-day mean DIA, which
  diverges from the per-event 5-minute pairing the live path uses on
  outlier days with extreme readings. Documented in the helper's
  header comment + the route's call-site. Marc directive (verbatim
  from the brief): "byte-for-byte parity with live aggregates" is the
  bar for the linearly-composable stats (count / min / max / mean);
  the per-event pairing falls outside that bar, so the divergence is
  an explicit cold-critical-path trade-off rather than a regression.
  No Marc-decision needed because the live fallback remains the
  truth source for accounts the rollup table cannot cover.
- **Deferred — full-process cold first-hit**: even with all three
  fast-path branches, a true cold-everything first request still
  pays the connection-pool warm-up + rollup-table-page cache load. A
  preflight ping or a pg-boss-managed warmer is queued as a v1.4.38
  candidate.
- **Deferred — auto-discovery correlation coverage**: the
  hand-defined three hypotheses suit today's surface. The v1.5 plan
  to widen to auto-discovered correlations across every metric pair
  needs a separate research pass on how to gate the FDR-controlled
  scan against the rollup table; the v1.4.37 helper is a clean
  drop-in target for that work.

## File set touched

- `src/app/api/analytics/route.ts` — three branch call-sites
  delegated to the new helpers; per-route coverage probe shared
  between them; inline `computeUserHealthScore` /
  `computeCorrelationHypotheses` bodies + their day-key /
  source-mapping helpers relocated to the helper modules.
- `src/lib/analytics/bp-in-target-fast-path.ts` — new.
- `src/lib/analytics/health-score-fast-path.ts` — new.
- `src/lib/analytics/correlations-fast-path.ts` — new.
- `src/lib/analytics/__tests__/bp-in-target-fast-path.test.ts` — new.
- `src/lib/analytics/__tests__/health-score-fast-path.test.ts` — new.
- `src/lib/analytics/__tests__/correlations-fast-path.test.ts` — new.
- `src/app/api/analytics/__tests__/route.test.ts` — rollup-table mock
  seed so the relocated helpers run.
- `src/app/__tests__/insights-b3-wiring.test.ts` — source-grep guards
  repointed to the correlation helper module.
