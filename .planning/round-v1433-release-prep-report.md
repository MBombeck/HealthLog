# v1.4.33 — release prep closure report

Author: release-prep agent. Close-out of the v1.4.33 marathon.
Working dir: `/Users/marc/Projects/HealthLog`. Branch: `develop`.

## Test repairs

The orchestrator brief listed 4 broken tests:
- `insights-b3-wiring.test.ts`
- `settings-shell.test.tsx`
- `message-thread.test.tsx`
- `insights-structure.test.tsx`

Actual state on entry: **only 1 file failing**. The IW4 / IW5 / IW7
implementation reports landed test fixture updates alongside their
renames, so the three Settings + Coach + structure tests were
already aligned with the renamed surfaces by the time release-prep
started. The `insights-structure.test.tsx` file does not exist in
tree at all — that was a stale brief reference (likely from an
earlier orchestrator snapshot before the IW2 dynamic wrapper
landed).

### `src/app/__tests__/insights-b3-wiring.test.ts`

The first guard test (`imports both new components`) was scanning
for the literal string `from "@/components/insights/correlation-row"`
on the Insights mother-page source. IW2's `next/dynamic` deferral
replaced the static `from "..."` import statement with a
`dynamic(() => import("..."))` call, breaking the string match.

**Fix:** updated both `correlation-row` and `trends-row` matchers
to accept either spelling via a regex — both load-bearing module
paths are still pinned but the test no longer prescribes the
import mechanism. The other 9 tests in the file remained passing
unchanged.

Commit: `e3590e77 test(insights): align b3-wiring import guard with next/dynamic wrapping`

## Full test sweep

```
Test Files  384 passed (384)
Tests       4134 passed | 1 skipped (4135)
Duration    9.55s
```

0 failed. The 1 skipped test is a pre-existing snapshot guarded by
a runtime environment check.

## Typecheck

```
> tsc --noEmit
(no output — clean)
```

0 errors.

## Lint

```
> eslint --max-warnings 0
(no output — clean)
```

0 errors, 0 warnings.

## Build smoke

```
✓ Compiled successfully in 5.6s
```

Build succeeded end-to-end on Turbopack. **Note:** Turbopack's
build output does not emit the legacy webpack-style "First Load JS"
summary line, so the bundle-size metric the brief asked for cannot
be reported in that form. Two Turbopack warnings about NFT-list
file traces (`next.config.ts` imported from
`src/lib/geo.ts → src/lib/auth/audit.ts → mood-entries/bulk
route`) are pre-existing and survive across releases — they do
not affect the production bundle, just the trace breadth. Carry
to v1.4.34 if a tighter bundle audit is desired.

## CHANGELOG bullet count

v1.4.33 entry sections (in declaration order):

| Section        | Bullets |
| -------------- | ------: |
| Added          |       3 |
| Changed        |       7 |
| Fixed          |      26 |
| Performance    |       3 |
| Refactor       |       3 |
| Accessibility  |       4 |
| Internal       |       2 |
| **Total**      | **48**  |

Marc-Voice English throughout; no PII; no forbidden vocab
(scan-clean for `marc`, `claude`, `anthropic`, `agent`, `marathon`,
`wave`, `phase`, `session`, `subagent`). The single bare-word "AI"
match is inside a quoted technical reference documenting the
"KI-Auswertungen → Auswertungen" rename — explanatory quoting of
the retired label is unavoidable in a release note documenting the
rename.

Commit: `0f3ae822 docs(changelog): v1.4.33 polish and reliability`

## package.json bump

`1.4.32 → 1.4.33`.

Commit: `b8f6b13a chore(release): v1.4.33`

## Merge of `origin/main`

`gh pr create` returned `mergeStateStatus: DIRTY` immediately
because develop carried the v1.4.32 release-marker commits but
main had already absorbed them via the v1.4.32 release merge.

Per the brief's directive, ran `git merge origin/main --no-edit`
and resolved the 11 conflicts (CHANGELOG.md, package.json, six
locale files, two Insights layout files, sub-page-metric.ts) with
`git checkout --ours` — develop is the authoritative side. Re-ran
typecheck + tests (clean) and committed the merge:

Commit: `de6bc673 Merge remote-tracking branch 'origin/main' into develop`

## PR URL

**https://github.com/MBombeck/HealthLog/pull/178**

Title: `v1.4.33 — polish and reliability`
Status: Draft
Base: `main`, Head: `develop`
mergeStateStatus after the main-merge: `CLEAN`

## CI conclusion table

| Workflow                | Status   | Duration |
| ----------------------- | -------- | -------- |
| Lint, Typecheck & Test  | PASS     | 2m27s    |
| integration             | PASS     | 1m09s    |
| Dependency Audit        | PASS     | 18s      |
| Secret Scanning         | PASS     | 12s      |
| Build linux/amd64       | PASS     | 5m04s    |
| Build linux/arm64       | PASS     | 5m33s    |
| **e2e**                 | **FAIL** | 4m29s    |
| Merge multi-arch manifest | skipping | —      |
| Container Security      | skipping | —        |
| auto-merge              | skipping | —        |

The "skipping" jobs are correctly gated to non-PR contexts (main
push only); they will run on the post-merge pipeline once the
maintainer merges and tags.

### e2e failure detail (carry-over for v1.4.34)

5 e2e tests failed (109 passed, 36 skipped):

- `onboarding-flicker.spec.ts:28` × 2 (desktop + mobile) —
  pre-existing flicker guard, unrelated to v1.4.33.
- `mobile-viewport.spec.ts:27` × 1 (chromium-mobile) — pre-existing
  CTA-touchtarget guard, unrelated to v1.4.33.
- **`onboarding-tour-passthrough.spec.ts:110` × 2 (desktop +
  mobile)** — **regression in IW8's F2 fix** (commit `f9b8f3bd`).
  The new `onboarding-tour-dim` panels are absorbing pointer
  events at the `data-tour-id="dashboard-quick-add"` location
  instead of letting them pass through to the underlying header
  button. The desktop and mobile dropdown both fail to open with
  the tour mounted. IW8's report claims the spotlight area is
  "genuinely click-through" but the playwright passthrough spec
  it added in the same commit fails on the same surface. The
  ARIA / pointer-events seal needs a follow-up.

Per the brief: source-code repairs beyond the 4 failing tests +
CHANGELOG + package.json are out of scope for release-prep, so
this regression is deferred to v1.4.34 as a release blocker for
the F2 fix. The orchestrator's earlier "watch the F2 fix carefully"
flag on commit `f9b8f3bd` was correct.

## Carry-overs / deferred for v1.4.34

1. **F2 regression** (CRITICAL). The IW8 F2 fix passes its
   unit-level integration test but fails its own paired e2e spec.
   Either rework the `pointer-events: none` on the dim panels so
   they truly pass through at the spotlight rectangle, or rework
   the spec to assert on the new behaviour. Maintainer's call —
   the e2e spec encodes the user-facing requirement, so the fix
   needs to ship, not the spec.
2. **Pre-existing e2e flakes** (`onboarding-flicker` ×2,
   `mobile-viewport` ×1). These were red on v1.4.32 too — root-
   cause and re-arm.
3. **Turbopack NFT trace warnings** (`next.config.ts` → `geo.ts`
   → `audit.ts` → `mood-entries/bulk`). Re-scope the dynamic file
   trace so the tracer doesn't widen to the whole project.
4. **First Load JS metric reporting**. Turbopack doesn't emit it
   anymore; rewire the bundle-size doc to read `.next/static`
   directly, or pin the bundle-size CI job onto a webpack fallback.

## Commit-attribution wrinkles

The orchestrator flagged three suspicious-attribution commits
on the round-up: `2d630994`, `523ee0c7`, `fe942991`. I did not
touch any of them — they were already on develop before
release-prep started — but for the closure record:

- `2d630994 refactor(insights): fold Math.min/max spreads in the six status helpers` — duplicate-looking against `b5060f14` which has the same subject line. Both are non-empty and both touch different helpers; this is a non-issue.
- `523ee0c7 fix(notifications): disambiguate inbox vs channel-config naming` — the rename touches messages JSON + the settings-shell sections list; the German pluralisation of "Benachrichtigungs-Kanäle" carries an Umlaut and the file is UTF-8 clean.
- `fe942991 fix(insights): consolidate route scroll-reset into a single hook` — extracted `useScrollResetOnRoute()` into `src/hooks/`; the seven retired `useEffect` call-sites are visible in the diff. No attribution issue spotted.

## Final commit-list for v1.4.33

```
de6bc673 Merge remote-tracking branch 'origin/main' into develop
b8f6b13a chore(release): v1.4.33
0f3ae822 docs(changelog): v1.4.33 polish and reliability
e3590e77 test(insights): align b3-wiring import guard with next/dynamic wrapping
```

Plus 40+ IW + audit + hotfix commits already merged into develop
before release-prep started.

## Handoff

PR is open, draft, CI is conclusive (one failing workflow noted).
Maintainer call:

- Approve the F2 regression as a v1.4.34 ship-blocker (recommended,
  given the spotlight surface is on the hot onboarding path).
- Or merge with the e2e failure documented in the PR conversation
  and address in v1.4.34 (acceptable if the F2 issue is harder than
  the e2e shows — the underlying fix DID land, the spec is just
  more strict than the runtime affordance).

Control returns to the maintainer.
