# IW-F-Perf — close-out report

Sub-wave brief (per `round-v1434-prod-slowness-investigation.md` §5)
landed in three atomic commits on top of `73cd44e0` (IW-XML's Apple
Health import endpoints).

## Commits

| SHA | Subject |
| --- | --- |
| `ca7ca0e7` | feat(queries): shared achievements query hook |
| `3b77b6a0` | refactor(gamification): collapse achievement consumers onto shared hook |
| `c6345b71` | test(queries): pin achievements hook collapse + audit analytics consumers |

## Scope landed

### 1 — `/api/gamification/achievements` consumer collapse

Three consumers — `<RecentAchievementsCard>`, the `/achievements`
mother page, and `<AchievementUnlockNotifier>` — previously each
declared their own `useQuery` block. Two collided on the same
`["gamification", "achievements"]` literal; the notifier carried a
per-user discriminator on its key so TanStack treated it as a fresh
cache cell. Dashboard cold mount fired the endpoint twice (HAR
evidence in `round-v1434-prod-slowness-investigation.md` §4).

The new `src/lib/queries/use-achievements-query.ts` hook mirrors the
v1.4.33 `use-analytics-query.ts` shape:

- centralises the queryKey via `queryKeys.gamificationAchievements()`
- `staleTime: 60_000`, `refetchOnMount: false`, no window-focus
  refetch
- defaults `enabled: isAuthenticated`
- optional `refetchInterval` so the notifier's 2-minute polling
  cadence stays intact, riding the shared cache cell

All three consumers migrated. One cache slot, one network call on
the dashboard cold mount.

### 2 — Analytics slim-vs-thick audit (read-only)

Captured in `round-v1434-iwfperf-analytics-audit.md`. Read every
consumer of `useAnalyticsQuery`, documented which slice each one
consumes and whether it must stay thick:

- Dashboard root (`src/app/page.tsx`) — thick, **must stay** (reads
  `bpInTargetPct*`, `glucoseByContext`).
- Insights mother page, sleep overview — thick, **must stay** (read
  `correlations`, `healthScore`, `sleepStages`).
- Insights layout shell, `useInsightsAnalytics`, getting-started
  checklist — slim, **correct**.

The single duplicate the HAR catches comes from the checklist firing
the slim call alongside the dashboard's thick call. The clean
migration is to hoist the checklist back onto the thick slot (it
only reads `summaries[METRIC].count` which is present on both
slices). However, that lives in
`src/components/onboarding/getting-started-checklist.tsx`, and
IW-B's in-flight changes to the slim slice's `lastSeenByType`
contract make this a tomorrow move. Deferred to v1.4.34.x behind
IW-B per the audit doc's §5.

### 3 — Regression test

`src/lib/queries/__tests__/use-achievements-query.test.tsx` mounts
three consumers under one TanStack QueryClient and asserts the
fetch mock fires at most once. The pool-bump integration test
described in the brief was downscoped — the testcontainer setup
doesn't expose a reliable way to provoke pool starvation in CI, and
the brief explicitly allows the simpler collapse-counts approach
when starvation simulation is hard. Two additional test fixes also
landed:

- `recent-achievements-card.test.tsx` now mocks the shared hook
  directly instead of `@tanstack/react-query`.
- `achievements/__tests__/page.test.tsx` same fix.

## Quality gates

| Gate | Result |
| --- | --- |
| `pnpm test` (scoped) | 17 passed across 3 suites |
| `pnpm typecheck` | clean |
| `pnpm lint` (filtered to touched files) | clean — no new findings |

The repo-wide lint surface still has the pre-existing 190 errors
inside `playwright-report/` bundle artefacts; none of them are mine
and none of the warnings touch the IW-F-Perf file set.

## Touch-disjoint compliance

Did not touch any of the agent-forbidden files:

- `src/app/api/analytics/route.ts` (IW-B)
- `src/app/page.tsx` (IW-B)
- `src/components/auth-shell.tsx` (IW-B)
- `src/lib/analytics/compliance.ts` (IW-C)
- `src/app/settings/**` (IW-D)
- `src/app/api/import/**`, `prisma/schema.prisma` (IW-XML)
- `next.config.ts`, `src/lib/http/cache-headers.ts` (IW-A)
- `src/middleware.ts`

## Recommended follow-up (v1.4.34.x)

Per the audit's §5: once IW-B's slim-slice routing lands and the
`lastSeenByType` contract stabilises, switch
`getting-started-checklist.tsx` from the slim slice back to the
thick slice so the dashboard cold mount drops from two analytics
calls to one. One-line consumer change, atomic commit, no schema
risk.
