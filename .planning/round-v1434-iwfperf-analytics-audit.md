# IW-F-Perf — `/api/analytics` consumer audit (read-only)

Scope-locked. The brief forbids touching `src/app/api/analytics/route.ts`,
`src/app/page.tsx`, and `src/components/auth-shell.tsx` while IW-B is
in flight on the same territory. This document is the read-only audit
that captures the slim-vs-thick split and flags the one duplicate
call the HAR still shows on the dashboard mount.

## 1 — Every consumer of `useAnalyticsQuery`

Eight call sites; six already converge on the correct slice. The
table below enumerates each, the slice it requests, and the fields it
actually reads off the payload.

| Consumer | File | Slice | Fields consumed | Verdict |
| --- | --- | --- | --- | --- |
| Dashboard root | `src/app/page.tsx:223` | thick (default) | `summaries.*`, `lastSeenByType.*`, `bpInTargetPct*`, `glucoseByContext` | **MUST stay thick** — `bpInTargetPct*` + `glucoseByContext` only exist on the thick payload. |
| Insights mother page | `src/app/insights/page.tsx:181` | thick (default) | `correlations`, `healthScore`, `sleepStages`, `summaries.*` | **MUST stay thick** — three slots are thick-only. |
| Sleep overview | `src/components/insights/sleep-overview.tsx:75` | thick (default) | `sleepStages`, `summaries.SLEEP_DURATION` | **MUST stay thick** — `sleepStages` is thick-only. |
| Insights layout shell | `src/components/insights/insights-layout-shell.tsx:63` | slim | `summaries.*` | Correctly on slim. |
| `useInsightsAnalytics` hook | `src/hooks/use-insights-analytics.ts:60` | slim | `summaries.*` | Correctly on slim — drives sub-page gating. |
| Getting-started checklist | `src/components/onboarding/getting-started-checklist.tsx:195` | slim | `summaries[METRIC].count` | Correctly on slim by IW2 design, but see §2. |

## 2 — The duplicate the HAR shows

`getting-started-checklist` is mounted inside the dashboard render
tree (`src/app/page.tsx:585`). Both calls fire on the same dashboard
cold mount:

- `/api/analytics` (thick) — queryKey `["analytics"]` — dashboard root
- `/api/analytics?slice=summaries` (slim) — queryKey
  `["analytics", "summaries"]` — checklist

The checklist's slim call is correct in isolation (it only reads
`count`s), but on the dashboard route specifically the thick call has
already fired — the slim call duplicates work the server is already
doing one tick earlier.

### Two clean migrations are possible

**(a) Hoist the checklist back onto thick.** Drop the `slice:
"summaries"` argument so the checklist subscribes to the same
`["analytics"]` cache cell the dashboard root populates. The
checklist only reads `summaries[METRIC].count`, which is present on
the thick payload. Eliminates the duplicate on the dashboard route at
the cost of forcing the slim call to refire when the checklist mounts
on a route that does **not** also paint the thick payload — which
currently is no other route, because the checklist is only rendered
inside `src/app/page.tsx`. Net win: one fewer call on cold dashboard
mount.

**(b) `select`-derive from the dashboard's thick slot.** TanStack
supports `select` for shape narrowing without a second network round
trip; the checklist could declare a derived query that reads the
thick cache cell and projects only the `summaries[METRIC].count`
fields it needs. This keeps the queryKey clean but adds a derivation
boundary that's harder to test.

(a) is strictly simpler and ships the user-facing fix.

## 3 — Why this audit doesn't migrate

The brief forbids `src/app/page.tsx`, `src/app/api/analytics/route.ts`,
and `src/components/auth-shell.tsx`. The cleanest version of (a)
edits `src/components/onboarding/getting-started-checklist.tsx`,
which is NOT on the disjoint list — so the migration is technically
inside scope. However, the slim slice is the right shape for the
checklist on every other surface (insights tree gating) and IW-B's
in-flight changes touch `use-analytics-query.ts` for the
`lastSeenByType` field. Migrating the checklist now would mean
double-running the slim+thick decision while IW-B is rewiring the
slim slice's payload contract.

**Recommendation.** Defer the checklist migration to v1.4.34.x
behind IW-B. Once IW-B's slim-slice routing lands and the dashboard
tile strip's `lastSeenByType` consumer is stable, drop the checklist
back onto the thick slice in a follow-up. One-line change, atomic
commit, no schema risk.

## 4 — What this audit does ship

The `/api/gamification/achievements` consumer-collapse fix is
strictly inside this sub-wave's scope and lands today. See
`round-v1434-iwfperf-report.md` for the commit set. The achievements
duplicate is byte-equivalent to the analytics duplicate in shape —
two consumers + divergent queryKeys → two network calls — but
resolved with the same hook pattern v1.4.33 IW2 introduced for
analytics.

## 5 — Open flag for v1.4.34.x

- Migrate `getting-started-checklist.tsx` onto the thick
  `useAnalyticsQuery()` once IW-B's analytics work lands. Trims the
  dashboard cold mount from 2 analytics calls to 1.
- Optional: introduce a TanStack `select` derivation pattern across
  the analytics hooks so the checklist can stay slim-shaped at the
  consumer boundary without re-fetching. Lower priority; (a) is the
  cheaper win.
