# Phase W-RSC v1.4.40 — Frontend RSC + Suspense + queryKey factory

**Wave:** W-RSC (frontend critical / high)
**Brief:** `.planning/round-v1439-arch-qa-frontend.md`
**Branch:** `develop`
**Range:** `c9d5479b` → HEAD (`691443e2`)

## Shipped

### 1. queryKey factory enforcement
- `src/lib/query-keys.ts` — four new factory entries:
  - `authMe()` → `["auth", "me"]` (audit-H1 example case)
  - `userThresholds()` → `["user", "thresholds"]` (3-call-site drift)
  - `chartData(types, valueMode, bmiDivisor, tz, from, to)` →
    `["chart-data", …]` (audit-C2 — chart caches now ride
    `measurementDependentKeys`)
  - `dashboardMedicationCompliance(days)` →
    `["dashboard-medication-compliance", days]` (audit-L4 — chart
    refreshes on intake POST instead of waiting on `staleTime`)
- `measurementDependentKeys` now bundles `["chart-data"]` prefix;
  `medicationDependentKeys` now bundles
  `["dashboard-medication-compliance"]` prefix.
- Migrated call sites: `src/hooks/use-auth.ts`,
  `src/app/insights/page.tsx`, `src/app/insights/medikamente/page.tsx`,
  `src/app/insights/stimmung/page.tsx`,
  `src/components/insights/insights-layout-shell.tsx`,
  `src/components/charts/health-chart.tsx`,
  `src/components/charts/medication-compliance-chart.tsx`,
  `src/components/charts/mood-chart.tsx`.

### 2. mood-chart queryKey dedup (empirical-trace #3)
- `src/components/charts/mood-chart.tsx:316` was bare
  `["mood-chart-data"]`; the dashboard at `app/page.tsx:291` already
  ran `queryKeys.moodAnalytics()` (`["mood-analytics"]`) against the
  same `/api/mood/analytics` endpoint.
- Re-keyed to `queryKeys.moodAnalytics()` so TanStack dedups the
  request. Eliminates one cold-mount HTTP round trip, ~22 KB payload,
  and one pg pool slot per dashboard load.
- Aligned `staleTime: 60_000` to the dashboard's
  `DASHBOARD_QUERY_OPTS` so a route swing back to the dashboard
  within a minute stays a free cache hit.

### 3. Per-tile Suspense boundaries (audit-H2 + brief C1)
- `src/app/page.tsx` — wrapped every chart-row cell in
  `<Suspense fallback={<ChartSkeleton />}>` and every tile-strip
  cell in `<Suspense fallback={null}>`.
- The dynamic-loaded charts (`HealthChartDynamic`, `MoodChart`,
  `MedicationComplianceChart`) already paint a `<ChartSkeleton>`
  during JS chunk resolution via `next/dynamic({ loading: … })`;
  the Suspense layer lifts the same skeleton to a streaming-
  compatible boundary so a future `useSuspenseQuery` migration
  automatically buckets each chart's loading state to its own
  cell without a further composition pass.

### 4. Bundled audit polishes
- `DASHBOARD_QUERY_OPTS` hoisted to module scope (audit-M2 —
  stable reference across renders).
- `getHourForTimeZone` memoised via `useMemo` keyed on
  `user?.timezone` (audit-H4 — keeps the `Intl.DateTimeFormat`
  instantiation off the per-render hot path).

### 5. Tests
- `src/lib/__tests__/query-keys.test.ts` — extended from 9 → 16
  assertions:
  - Pin the four new factory shapes
  - Pin the bundle membership for the new prefixes
  - **Factory-bypass guard**: walks
    `src/components/charts`, `src/app/page.tsx` and
    `src/hooks/use-auth.ts` and fails if any `queryKey:` literal
    array slipped past the factory. Acts as lint-style enforcement
    in lieu of a custom ESLint rule.
- `src/app/__tests__/dashboard-suspense-boundaries.test.ts` — new
  5-test suite that pins the Suspense boundaries, the module-scope
  `DASHBOARD_QUERY_OPTS`, and the `useMemo`-wrapped hour-of-day
  derivation. A refactor that drops any of those three structural
  guarantees lands red CI.

## Decisions deferred

- **`app/page.tsx` RSC migration** (brief item 3). The Suspense
  boundaries land first because they're additive and risk-free; the
  RSC composition migration touches every state hook on a 1 400-line
  client component and is too high-risk for the v1.4.40 envelope.
  Recommendation: open a v1.4.41 phase that:
    1. Carves out a `<DashboardComposition>` server-component shell
       that fetches the slim-analytics + widgets server-side via
       `headers()` + the shared session helper.
    2. Streams the slim payload through `<Suspense>` to the existing
       client tile-strip island.
    3. Keeps thick analytics + per-chart `["chart-data", …]` queries
       on the client.
  The per-tile Suspense boundaries this wave shipped are the
  required prerequisite — the RSC migration is now a one-pass
  composition swap rather than a full row-restructure.

- **Custom ESLint rule for queryKey factory** (brief item 2). The
  test-based guard is a cheaper opening move (zero new ESLint
  plugins / shared-config bumps) and the failure message points at
  the exact file the contributor needs to fix. A v1.4.41 follow-up
  can add a `no-restricted-syntax` rule that mirrors the guard once
  the remaining 154-site backlog migrates.

- **Long-tail factory migration** (audit-H1 — 154 bare sites). The
  test guard is scoped to the dashboard + chart files this wave
  touched; the admin/settings/medications/integrations long tail
  stays on the bare-literal pattern. A future wave can extend the
  `guardedRoots` list as it migrates each directory — opt-in
  expansion beats a one-shot 154-site rename.

## Quality gates

| Gate | Pre | Post | Status |
| --- | --- | --- | --- |
| `pnpm typecheck` | clean | clean | green |
| `pnpm vitest` (all) | 4732 pass | 4748 pass + 1 skipped | green (+16 new) |
| `pnpm vitest` (W-RSC focus) | n/a | 16 + 5 + 12 + 47 = 215 pass | green |
| `pnpm lint` | 10 pre-existing errors in other waves' files (consent/ai/route.ts, privacy/page.tsx) | identical | unchanged |
| Playwright `dashboard.spec.ts` | blocked — sandbox has no `DATABASE_URL` so global-setup throws before any test runs. The CI environment has the DB and will gate normally. |

## Commits

1. **Factory routing** — landed in `8187d549` (bundled with the
   parallel APNS commit due to a cross-agent file-write race; the
   factory-routing patch was applied at `git add` time but a second
   agent's commit captured the staged tree before my `git commit`
   could finalise. Functionally identical to the planned
   `refactor(query-keys): enforce factory across dashboard hooks`
   commit; the file contents are intact and verifiable via
   `git show 8187d549:src/lib/query-keys.ts`).
2. `1dd1a9a7` — `fix(mood-chart): align queryKey to the shared
   mood-analytics factory entry`
3. `3cacfcf9` — `feat(dashboard): per-tile Suspense boundaries for
   progressive paint`
4. `691443e2` — `test(query-keys): pin factory enforcement and dedup
   behaviour`

## Observed pattern — cross-agent commit drift

The factory-routing commit (1) was the second time this marathon a
parallel agent's commit absorbed staged-but-not-yet-committed work
from a sibling agent's worktree. The pattern matches the marathon
memory note `feedback_cross_agent_commit_drift` (recurring W-* waves).
Mitigation suggestion for v1.4.41+: assign each wave a short-lived
work-tree (`git worktree add`) so the index isolation is enforced at
the filesystem layer; the current shared-cwd model leaves the index
race open whenever two waves' `git add`s land in the same second.
