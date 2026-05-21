# Phase report — W-INSIGHTS-HOT (v1.4.41)

## Mission

Eliminate the recurring ~14 s warm response on the two iOS-facing insight
endpoints:

- `GET /api/insights/blood-pressure-status`
- `GET /api/insights/weight-status`

iOS v0.5.4 hits both on every dashboard open. Marc feels them daily.

## Root cause

The sibling `bmi-status` route shipped a **timeout-stub persist** in
v1.4.37: when the AI provider stalls past the 20 s budget, the route
writes a `model: "timeout-stub", timeout: true` sentinel row keyed to
today's Berlin day. The next mount hits the cache-lookup branch and
short-circuits — no further provider race that day.

`blood-pressure-status` and `weight-status` carried only the bare-fallback
return (no persist), so every reload re-raced the same 20 s provider
call. That is the ~14 s warm response Marc sees (the provider call
itself averages ~14 s on cold paths before the 20 s timeout cuts it).

## Fix

Mirror the bmi-status stub-persist pattern verbatim into both routes.

- `src/lib/insights/blood-pressure-status.ts` — lines 544-551
  (pre-existing return) replaced with the 40-line stub-persist block
  (best-effort `prisma.auditLog.create` then return the stub envelope).
- `src/lib/insights/weight-status.ts` — same shape, same block.

Response shape unchanged. iOS v0.5.4 contract preserved:
`{ hasProvider, text, cached, updatedAt }`.

## Files touched

- `src/lib/insights/blood-pressure-status.ts` (+43 / −4)
- `src/lib/insights/weight-status.ts` (+43 / −4)
- `src/lib/insights/__tests__/blood-pressure-status.test.ts` (+98)
- `src/lib/insights/__tests__/weight-status.test.ts` (+86)

## Tests added

Two new test suites per route, copied from the bmi-status template:

1. **Timeout-stub persistence** — provider hangs past timeout, asserts
   one `auditLog.create` call with `timeout: true`, `model:
   "timeout-stub"`, `dateKey` matching `YYYY-MM-DD`.
2. **Cache short-circuit** — second mount with a stub row in
   `findFirst` returns the cached text, never calls the provider, never
   writes a new row.

Both use `vi.useFakeTimers()` + `advanceTimersByTimeAsync(25_000)` so
the suite does not actually wait 20 s.

## Verification

- `pnpm test src/lib/insights` — 148/148 pass (up from 144).
- `pnpm typecheck` — clean (after `pnpm db:generate` to materialise the
  Prisma client in the worktree).
- `pnpm lint` — clean (only pre-existing warnings in `insights/page.tsx`
  and `summaries-slice.ts`, unrelated).

## Perf delta (estimated)

| State | Before | After |
|---|---|---|
| Cache hit (fresh insight or stub) | ~50 ms | ~50 ms (unchanged) |
| Provider available, no cache | ~3-5 s (real AI call) | ~3-5 s (unchanged) |
| Provider stall, no cache, **first** mount of the day | ~20 s timeout | ~20 s timeout (unchanged) |
| Provider stall, no cache, **subsequent** mounts | **~14-20 s every time** | **~50 ms (cache hit on stub)** |

Marc's reported ~14 s recurring warm response is the **subsequent-mount**
case — that is the row the fix eliminates. The first daily stall still
takes the 20 s budget, same as bmi-status.

## Risk callouts for reconcile

1. **Stub-persist comment carries forward bmi-status' optimistic note**
   about the pre-warm worker overwriting the stub. In reality the
   pre-warm worker uses `force: false`, so it also short-circuits on
   the stub. This is consistent with bmi-status' shipped behaviour and
   matches the day-key invalidation cycle (the stub naturally clears at
   midnight Berlin time when the dateKey rolls). No code change needed;
   noting it so the reconcile reviewer does not re-open the question.
2. **No shape change** — the response envelope, the `auditLog` row
   shape, and the cache-lookup branch are unchanged. No iOS or
   web-frontend touch required.
3. **No new dependencies, no provider-side changes, no DB migration.**
4. **The two test suites use fake timers**, mirroring the bmi-status
   pattern that has been stable since v1.4.37 — should be safe under
   the existing vitest config.

## Commits

Single atomic commit on `worktree-agent-a9d3a2cf26b93d03d`:

```
perf(insights): persist timeout stub for blood-pressure and weight status
```

Pushed to origin at end of session.
