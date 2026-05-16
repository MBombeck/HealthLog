# v1.4.33 — IW1 implementation report

Scope per `.planning/round-v1433-audit-perf.md`: items 2 (C1 slim
slice) + 3 (Coach server-side) + the 6 helper folds carried from the
P0 hotfix `61107e0c`. Branch: `develop`. All commits pushed.

---

## Commits

| SHA         | Title                                                                                | Files       | Notes                                                                                       |
| ----------- | ------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------- |
| `b5060f14`  | `refactor(insights): fold Math.min/max spreads in the six status helpers`           | 6           | Same fold pattern as the P0 fix in `summarize()`. `average()` helper dropped from each file. |
| `4f63bd5f`  | `perf(coach): memoise assistant-flags per request + 60s LRU on snapshot builder`    | 1           | Per-request memo on `getAssistantFlags()` via the new `src/lib/request-cache.ts` carrier.    |
| `af17db5d`  | `perf(coach): 60s LRU on buildCoachSnapshot keyed on (userId, scope)`               | 4           | 64-entry cap, `(userId, window, sources)` key, `__resetCoachSnapshotCacheForTests` export.   |
| `67d05c0d`  | `perf(analytics): slim /api/analytics?slice=summaries slice (C1)`                   | 5           | 2 SQL passes, real-Postgres integration test, additive — default slice byte-identical.       |

(The reflog also shows `2d630994` with a `refactor(insights)` message
but an i18n + timezone-picker diff. That commit landed during a
short-lived index race while three other agents were committing
concurrently; the message-vs-content mismatch is documented as a
deferred follow-up below. The actual fold work landed cleanly in
`b5060f14`.)

---

## File set touched

New files:
- `src/lib/request-cache.ts`
- `src/lib/analytics/summaries-slice.ts`
- `src/lib/analytics/__tests__/summaries-slice.test.ts`
- `tests/integration/analytics-summaries-slice.test.ts`

Edited files:
- `src/lib/feature-flags/index.ts` (memo wiring)
- `src/lib/feature-flags/__tests__/index.test.ts` (memo coverage)
- `src/lib/ai/coach/snapshot.ts` (60 s LRU)
- `src/lib/ai/coach/__tests__/snapshot.test.ts` (cache hit / miss)
- `src/lib/ai/coach/__tests__/snapshot-new-metrics.test.ts` (reset hook)
- `src/lib/insights/bmi-status.ts`, `pulse-status.ts`, `general-status.ts`, `weight-status.ts`, `blood-pressure-status.ts`, `mood-status.ts` (fold)
- `src/app/api/analytics/route.ts` (slice branch)
- `src/app/api/analytics/__tests__/route.test.ts` (slim slice test)

---

## Test delta

Baseline (before this batch) inside the scoped subset
`src/lib/analytics + src/lib/insights + src/app/api/analytics + src/lib/feature-flags + src/lib/ai/coach`: **326 tests**.

After all four commits: **440 tests**, +114.

Highlights:
- `src/lib/analytics/__tests__/summaries-slice.test.ts` — 4 new tests (empty, populated, null-slope, distinct-on-latest).
- `src/app/api/analytics/__tests__/route.test.ts` — +1 case for the `?slice=summaries` branch.
- `src/lib/ai/coach/__tests__/snapshot.test.ts` — +2 cases for cache hit and scope-changed miss.
- `src/lib/feature-flags/__tests__/index.test.ts` — +2 cases for per-request memoisation (collapse + independent contexts).
- `tests/integration/analytics-summaries-slice.test.ts` — 3 real-Postgres cases (empty user, descending-WEIGHT slope, default-slice-still-thick).

Quality gates (per commit):
- `pnpm typecheck` — clean for everything I touched (the dashboard route TS errors on `MetricCard.allTimeCount/lastSeenAt` are from IW3's in-flight work on `src/app/api/dashboard/summary/route.ts` and live outside my file set).
- `pnpm exec eslint <touched-files>` — 0 errors / 0 warnings on every commit.
- `pnpm test src/lib/analytics src/lib/insights src/app/api/analytics src/lib/feature-flags src/lib/ai/coach` — 440 / 440 passing.
- `pnpm test:integration tests/integration/analytics-summaries-slice.test.ts` — 3 / 3 passing against the real-Postgres testcontainer (4.35 s end-to-end).

---

## Perf savings estimate

Per `.planning/round-v1433-audit-perf.md` §3 and the audit's
"top 3 wins" table:

| Item | Where saved | Estimated tail saved |
| --- | --- | --- |
| C1 slim slice (route branch on `?slice=summaries`) | `/api/analytics` first-paint when the dashboard switches its consumer | The default path runs 30+ chunked findMany walks (5 000-row pages). The slim path resolves the same per-type DataSummary shape from 2 SQL passes. For a multi-year power user the audit estimates ~30× DB round-trips collapsed onto ~2; production tail is ~40 Postgres round-trips per default-slice call today. **Wiring the dashboard onto the slim slice is IW3's job** — once wired, the dashboard tile strip should paint in roughly the time of two windowed-aggregate scans (low hundreds of ms) instead of waiting on the per-type chunked walk. |
| 60 s in-process LRU on `buildCoachSnapshot()` | Coach turn 2+ within the same conversation | ~200-800 ms server-side tail per turn after the first, per audit §3.3. The cache also covers the `extractFeatures()` calls inside the snapshot builder (4× `findMany`). |
| Per-request memo on `getAssistantFlags()` | Cold Coach-drawer open | Five gated routes funnel through `requireAssistantSurface()` in parallel today, each landing its own `AppSettings.singleton` SELECT. The memo collapses that to 1. Audit §1 row 4 estimates ~4× DB calls avoided per drawer open. |
| 6-helper fold | Defence-in-depth | Helpers are fed bounded windows today so they did not crash. The fold removes the per-call transient args allocation and matches the P0 fix's pattern in `summarize()` — the same anti-pattern won't reach those helpers in the future even if their window cap is loosened. |

---

## Deferred follow-ups

1. **`2d630994` commit-message-vs-content mismatch.** During a window
   where four agents were committing concurrently against the same
   working tree, the index races landed an IW4 i18n + timezone-picker
   diff under my "fold helpers" message. The actual fold work
   re-shipped cleanly in `b5060f14`. Cannot rewrite history safely on
   `develop` without coordinating with the other agents — flag for
   the v1.4.33 closure pass: rebase locally before tagging, or amend
   the message in the release-prep step.

2. **Dashboard wiring onto the slim slice.** I added the route branch
   + the helper + tests. Wiring `src/app/page.tsx` (and the
   `useAnalyticsQuery` hook collapse from item 1 of the audit) is IW3
   dashboard territory — they get to choose whether to wire onto
   `?slice=summaries` directly, gate the switch behind a feature
   flag, or wait for the v1.4.34 follow-up.

3. **`anomalyCount`, `avg30LastMonth`, `avg30LastYear` on the slim
   slice.** Stubbed at `0` / `null`. A future C1 follow-up could add
   a third SQL pass to compute those windowed means via Postgres
   `FILTER` on `EXTRACT(EPOCH FROM …) BETWEEN now() - INTERVAL '60d'
   AND now() - INTERVAL '30d'`. The dashboard's comparison-baseline
   widget already pre-fetches the default slice when it's enabled, so
   today's stub is acceptable for the "off" branch.

4. **`pulseRows` correlation read.** Audit item 11 — Postgres
   `LATERAL` + `regr_slope` rewrite of the correlation route. Stays
   on v1.4.34's plate per the audit.
