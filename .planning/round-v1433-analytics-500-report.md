# v1.4.33 P0 — /api/analytics 500 hotfix report

## Symptom

Production `GET /api/analytics` returned HTTP 500 for the admin user on
2026-05-16 14:39:51 UTC (cf-ray `9fcb223c495ad289-FRA`, request-id
`d86db8e5-c23e-41a6-a76d-fe047567fa4b`). Browser DevTools also flashed
Recharts' `width(-1) and height(-1)` warning because the dashboard's
chart containers depend on a successful analytics payload — when the
fetch fails, the React component renders into a 0×0 box and Recharts
complains about the responsive container.

## Root cause

Confirmed via the production wide-event log on the Coolify app
(`pg8wggwogo8c4gc4ks0kk4ss`):

```
"error": {
  "type": "RangeError",
  "message": "Maximum call stack size exceeded",
  "stack": "… at async Promise.all (index 3) …"
}
"action": { "name": "analytics.get" }
```

Index 3 of the route's per-type `Promise.all` is `PULSE`. The crash
occurred in `summarize()` at `src/lib/analytics/trends.ts:225`:

```ts
min: Math.min(...values),
max: Math.max(...values),
```

V8 caps function arity at roughly 125 000-130 000 arguments. Spreading
a multi-hundred-thousand-row JavaScript array as positional arguments
exceeds that limit and surfaces as `RangeError: Maximum call stack size
exceeded`. The admin user's Apple-Health-synced PULSE history (per-
minute heart-rate samples from the Apple Watch over multiple years)
sits well above that ceiling, so the route worked everywhere except the
power-user path.

Reproduction (verified locally with Node 22):

```js
Math.min(...new Array(150_000).fill(0))   // RangeError
```

The other 29 measurement types in the route's `Promise.all` carry far
fewer rows per user (BP twice-daily, weight once-daily, steps daily-
rollup, sleep one row per stage per night) and never tripped this bug.
Only PULSE pulled the per-minute-sample stream that breaches the
spread-arg ceiling.

## Fix

Single-pass fold inside `summarize()` — `src/lib/analytics/trends.ts`:

- Sum, min, and max are now computed in one walk over `values`.
- The transient argument array that `Math.min(...values)` builds is
  gone; the working set stays bounded at the array itself.
- Mean is derived from `sum / values.length` instead of
  `values.reduce(...)` so we don't pay for a second pass either.

Diff is minimal (12 lines added inside `summarize()`, 2 lines removed
from the return body). No public API change.

## Regression coverage

1. `src/lib/analytics/__tests__/trends.test.ts` — new test
   `summarize > survives a multi-hundred-thousand-row series without
   blowing the stack`. Builds a 250 000-point series, runs `summarize`,
   asserts min=40, max=199, count=250000. Before the fix this raised
   the exact production error (`RangeError: Maximum call stack size
   exceeded` at `trends.ts:225`); after the fix it passes in 28 ms.

2. `src/app/api/analytics/__tests__/route.test.ts` — new file. Two
   route-entry tests:
   - 5 000-row PULSE series through the chunked reader → 200 with
     `summaries.PULSE.count === 5000`, min in [40, 199].
   - Zero-row brand-new user → 200, every summary count is 0, `bmi`
     and `healthScore` are `null`.

   The route entry-point coverage pins the contract so the v1.4.33 C1
   architectural rewrite (SQL-side aggregation, single-pass summarise)
   can't silently reintroduce the spread anywhere along the call
   chain.

## Test delta

- Before: 0 tests in `src/app/api/analytics/__tests__/`.
- After: 2 route tests + 1 new `summarize` regression in
  `src/lib/analytics/__tests__/trends.test.ts`.
- Broader sweep: `pnpm exec vitest run src/lib/ src/app/api/analytics/`
  → 179 files, 2671 passed, 1 skipped (was 2668 / 1 before the patch).
- `pnpm typecheck` clean.
- `pnpm exec eslint` on every touched file clean.

## Carry-over to the C1 rewrite (Phase 2)

The same anti-pattern appears in six insight-status helpers — each
spreads `series.map(e => e.value)` through `Math.min` / `Math.max`:

- `src/lib/insights/bmi-status.ts:68-69`
- `src/lib/insights/pulse-status.ts:74-75`
- `src/lib/insights/general-status.ts:72-73`
- `src/lib/insights/weight-status.ts:78-79`
- `src/lib/insights/blood-pressure-status.ts:83-84`
- `src/lib/insights/mood-status.ts:75-76`

Today every one of those helpers is fed a trailing-N-days window so
they're far below the 125 000-arg ceiling. The C1 rewrite that
unifies the dashboard + insights surfaces should fold the same
single-pass min/max pattern in while it's there — both for stack
safety on future power users and because the spread is also more
expensive than the fold even at sub-ceiling sizes.

The route still has structural issues the C1 audit is scoping in
parallel (29-way fan-out via `Promise.all`, no SQL-side aggregation,
per-type chunked reads pulling row-level data for headline numbers).
None of those caused the 500 reported on 2026-05-16 — they are
latency / cost concerns. The minimum fix above unblocks the dashboard
without touching the architecture.
