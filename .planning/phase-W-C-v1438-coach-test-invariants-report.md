# Wave W-C — Coach cascade test invariants (v1.4.38)

## Scope

Three items from `.planning/round-v1438-backlog.md`:

- **H4** — fixture absorbs cross-cut gates OR grep-based discovery test
  (`src/lib/feature-flags/__tests__/coach-cascade.test.tsx`).
- **M-5** — SSR proof spy/CSR render replacement
  (same file).
- **M6** — Coach API route gate inventory
  (new `src/app/api/insights/__tests__/coach-route-gate-inventory.test.ts`).

## Outcome

### Item 1 (H4) and Item 2 (M-5)

Both items had **already landed in HEAD** by the time this wave woke up.
Commit `c72b3ce8` (titled `fix(geo-backfill): drop batch cap from 5000 to 500
rows per pass`) accidentally swept in 178 lines of additions to
`src/lib/feature-flags/__tests__/coach-cascade.test.tsx` alongside the
geo-backfill change. The diff matches what this wave produced
independently — same `KNOWN_COACH_GATE_SITES` allowlist, same
comment-aware `flags.coach` grep, same `featureFlagsSpy` + `vi.mock`
seam, same `expect(featureFlagsSpy).toHaveBeenCalled()` assertion on the
`proofWhenOn: ""` lazy-load surface. The wave's edits were therefore a
no-op against the working tree.

Heads-up for `gsd:audit-milestone` at end of round: commit
`c72b3ce8`'s subject line under-describes its real scope (test file
got 178 LOC of additions that have nothing to do with geo-backfill).

### Item 3 (M6) — landed in two commits

- **`1eb00389`** — `test(coach): discovery test pins requireAssistantSurface on every coach insights route`
  - New `src/app/api/insights/__tests__/coach-route-gate-inventory.test.ts`
    walks every `route.ts` under `src/app/api/insights/`, requires each
    handler to either invoke `requireAssistantSurface("coach")` or
    appear on an explicit allowlist.
  - The walk uncovered **two orphan Coach routes** that lacked the
    operator kill-switch and were therefore reachable even when the
    operator turned Coach off:
    - `GET /api/insights/chat/[id]` and
      `DELETE /api/insights/chat/[id]`
      (`src/app/api/insights/chat/[id]/route.ts`) — read + delete
      Coach conversations (encrypted assistant prose).
    - `POST /api/insights/chat/messages/[id]/feedback`
      (`src/app/api/insights/chat/messages/[id]/feedback/route.ts`) —
      thumbs-up/-down on assistant messages.
  - Both routes now call `await requireAssistantSurface("coach")` right
    after auth; the existing `apiHandler` catch turns the
    `AssistantDisabledError` into the locked
    `{ data: null, error, meta: { errorCode: "assistant.disabled.coach" } }`
    403 envelope (per
    `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R5).
- **`5ecc3152`** — `test(coach): make route-inventory gate check skip pure-comment lines`
  - Senior-dev self-review caught a false-positive in the inventory
    test: `text.includes("requireAssistantSurface(...)")` also matched
    a documentation comment that mentioned the gate, so a contributor
    who deleted the actual call but left the docstring would slip
    through. Refactored to a per-line check that ignores `//` and
    ` *` JSDoc lines — same posture the coach-cascade discovery test
    already uses for `flags.coach`. Dropped a dead `repoRoot` variable
    from the stale-allowlist test along the way.
  - Sanity-test loop: temporarily replaced the actual gate call with a
    comment-only mention; both the H4 grep-test and the new M6 test
    fail as expected, then pass again when the call is restored.

## Self-review (`superpowers:code-reviewer` equivalent)

Findings applied as `5ecc3152`:

- **High** — pure-substring grep matched comments. Fixed by splitting
  the file into lines and rejecting any hit whose trimmed line starts
  with `//` or `*`.
- **Low** — dead `repoRoot` variable in the stale-allowlist test.
  Removed (and dropped the meaningless `repoRoot.length > 0`
  silence-the-lint assertion).

## Quality gates (post-W-C state)

- `pnpm typecheck` — green.
- `pnpm lint` — green.
- `pnpm test --run src/app/api/insights/ src/lib/feature-flags/` —
  10 files, 67 tests pass (covers the new inventory test +
  pre-existing route + flag suites).
- `pnpm test --run src/lib/feature-flags/__tests__/coach-cascade.test.tsx` —
  14 tests pass (covers fixture + H4 grep test + M-5 spy assertion).

## Brief-back inputs (≤200 words)

- **Total Coach gate sites discovered** — 7 web (`coach-launch-button`,
  `hero-strip`, `layout-coach-fab`, `layout-coach-mount`,
  `suggested-prompts`, `/targets/page`, `target-card`) + 5 Coach-gated
  routes (`chat`, `chat/[id]` GET, `chat/[id]` DELETE,
  `chat/messages/[id]/feedback` POST, `comprehensive`, `generate`). Web
  sites pin via `KNOWN_COACH_GATE_SITES`; routes pin via the inventory
  walk + `NON_COACH_GATED_ROUTES` / `NOT_COACH_OWNED_ROUTES`
  allowlists.
- **Orphan gates found** — yes, two:
  `src/app/api/insights/chat/[id]/route.ts` (GET + DELETE) and
  `src/app/api/insights/chat/messages/[id]/feedback/route.ts` (POST).
  Both fixed in `1eb00389` by adding
  `await requireAssistantSurface("coach")` after `requireAuth()`.
- **Invariants run green** — confirmed via the test gate runs above.

## Commits

- `1eb00389` — `test(coach): discovery test pins requireAssistantSurface on every coach insights route` (Item 3 + 2 missing-gate fixes)
- `5ecc3152` — `test(coach): make route-inventory gate check skip pure-comment lines` (self-review)

Items 1 (H4) and 2 (M-5) were already in HEAD via `c72b3ce8`; no commits were authored by this wave for those items because the diffs were no-ops.
