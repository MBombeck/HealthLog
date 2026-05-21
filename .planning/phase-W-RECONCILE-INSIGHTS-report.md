# W-RECONCILE-INSIGHTS — v1.4.41 phase report

## Goal

Close the last architectural-correctness High before the v1.4.41 tag:
collapse the duplicated 40-line `auditLog.create` timeout-stub block
into a single shared helper, refactor the existing call-site
(`bmi-status.ts`) onto it, and wire the six remaining sibling status
routes to the same persist path so every route shares one shape on
provider stall.

## Branch + commits

- Branch: `worktree-agent-a4b70eb08bcc2d056` (worktree branched from
  `develop` at `a1bfc3b4 docs(planning): v1.4.41 marathon handoff
  for fresh session`).
- Pushed to origin (see end of report).
- Commits added:
  - `9584dc40 refactor(insights): extract shared timeout-stub persist helper`
  - `d782f65a perf(insights): wire six sibling status routes to the shared timeout-stub helper`

## Files touched

### Helper (new)

- `src/lib/insights/persist-timeout-stub.ts` — exports
  `persistTimeoutStubAndReturn(input)` returning the standard
  `{ hasProvider: true; text; cached: true; updatedAt }` envelope.
  Body is byte-equivalent to the previous inline block in
  `bmi-status.ts` (today's `dateKey`, `locale`, `text`,
  `providerType`, `model: "timeout-stub"`, `tokensUsed: null`,
  `timeout: true`; best-effort `try/catch`).

### Routes refactored to use the helper (7 total)

- `src/lib/insights/bmi-status.ts` — replaced the 45-line inline
  block with a 7-line return.
- `src/lib/insights/blood-pressure-status.ts` — new wire, was a bare
  fallback before.
- `src/lib/insights/weight-status.ts` — new wire, was bare.
- `src/lib/insights/general-status.ts` — new wire.
- `src/lib/insights/pulse-status.ts` — new wire; updated the stale
  "fallback is NOT persisted" comment.
- `src/lib/insights/mood-status.ts` — new wire.
- `src/lib/insights/medication-compliance-status.ts` — new wire with
  shape mapping (route returns `{ summary, medications: [] }` so the
  helper is called for the persist side-effect and `summary` is
  mapped from `text` on the way out). Also extended its cache-read
  block to recognise the stub envelope (`dateKey + timeout: true +
  text`) so the second-mount short-circuit fires on the same row
  shape the helper writes.

### Tests added / updated

- `src/lib/insights/__tests__/blood-pressure-status.test.ts` — new
  describe block: persist-on-timeout + short-circuit-on-stub.
- `src/lib/insights/__tests__/weight-status.test.ts` — same pair.
- `src/lib/insights/__tests__/general-status.test.ts` — same pair.
- `src/lib/insights/__tests__/mood-status.test.ts` — same pair.
- `src/lib/insights/__tests__/medication-compliance-status.test.ts`
  — persist-on-timeout asserts the helper-shaped row + the
  `{summary, medications: []}` mapped return shape; short-circuit
  pinned against the new stub-recogniser branch.
- `src/lib/insights/__tests__/pulse-status.test.ts` — added the
  short-circuit-on-stub case (the persist arm was already covered
  by the existing dedicated file below).
- `src/lib/insights/__tests__/pulse-status-timeout.test.ts` —
  flipped the old "does NOT persist" assertion (legacy contract)
  to the new "persists exactly one stub row with `timeout: true` +
  `model: timeout-stub`" assertion. The route now matches BP /
  weight / BMI; the legacy comment in the file was rewritten too.

The existing `bmi-status.ts` tests still pass after the refactor
(helper extraction preserves behaviour; verified, not rewritten).

## Helper interface

```ts
export async function persistTimeoutStubAndReturn(input: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  locale: string;
  providerType: string;
  stubText: string;
}): Promise<{
  hasProvider: true;
  text: string;
  cached: true;
  updatedAt: string | null;
}>;
```

`updatedAt` is `null` when the `auditLog.create` itself fails
(best-effort persist); the user-facing `text` always renders.

## Quality gates

- `pnpm typecheck`: clean (no new errors).
- `pnpm lint`: clean (only the 5 pre-existing warnings on
  `src/app/insights/page.tsx` + `src/lib/analytics/summaries-slice.ts`
  which are not in scope).
- `pnpm test --run src/lib/insights`: **155 / 155 passed** (was
  144 before; +11 new persist/short-circuit cases across the 6
  sibling routes + the pulse-status-timeout flip).

Full suite (`pnpm test --run`) was also exercised; the only
failure is the pre-existing `dashboard-suspense-boundaries.test.ts`
red on develop tip (verified by stashing the worktree changes and
re-running — same failure). Not in scope for this wave.

## Risk callouts / reconcile notes

1. **medication-compliance cache-shape divergence (resolved
   inline).** The route stores `{summary, medications}` in its
   audit-log row, not `{text}`. A naive wire would have written a
   helper-shaped stub that the route's cache-read block could not
   recognise — defeating the entire short-circuit purpose. Fix
   landed in the same commit: the route's cache-read block now
   recognises both shapes (canonical `summary + medications` for
   real assessments + `text + timeout: true` for stubs). Test
   pins both branches.

2. **pulse-status-timeout legacy assertion.** The pre-existing
   `pulse-status-timeout.test.ts` asserted
   `prisma.auditLog.create` was **never** called on timeout — a
   sentinel encoding the v1.4.28 "do not poison tomorrow's cache"
   contract. The v1.4.37 stub pattern reversed that decision (the
   stub IS the way to NOT poison tomorrow: the daily pre-warm job
   detects `model: "timeout-stub"` and overwrites). The test was
   updated to assert the new contract; if a future wave wants
   strict "no persist on timeout" semantics back, this test pin
   makes the regression visible.

3. **Helper is best-effort.** The `try/catch` around
   `auditLog.create` is intentional and preserved from the v1.4.37
   bmi-status original: a failed write must not crash the response.
   `updatedAt: null` on persist-failure is the signal. Worth
   documenting in v1.4.41 ops notes — a sustained burst of "persist
   failed" events would mean DB pressure, not a code bug, and would
   degrade the route to the pre-v1.4.37 re-race-every-visit
   behaviour silently.

4. **No `toBerlinDayKey` extraction.** Each route still owns its
   own `toBerlinDayKey` local — Simplifier-residual M2 deferred to
   v1.4.42 per the wave brief. The helper takes `todayKey` as an
   input so the extraction is a follow-up refactor inside a single
   file (`src/lib/utils/berlin-day-key.ts` or similar) and won't
   touch this helper's interface.

## Counts at-a-glance

- 1 helper file added.
- 7 routes share one persist path (was 0; bmi was the only persist
  before, the other 6 had bare-fallback returns).
- ~120 LOC of duplicate `auditLog.create` calls collapsed into the
  helper.
- Tests: 144 → 155 (+11).
- LOC delta: +673 / -81 across 14 files (tests dominate; production
  code delta is roughly neutral after the bmi inline-to-helper
  collapse).
