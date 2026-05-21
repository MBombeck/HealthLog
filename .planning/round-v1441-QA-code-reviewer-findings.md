# v1.4.41 Code-review findings

Scope: `git diff main..develop` (23 commits, v1.4.41 vs live v1.4.40).
Reviewer: W10 code-reviewer (read-only).

## Verdict
APPROVE_WITH_FIXES

Cherry-picked v1.4.41 waves are sound: bmi-status timeout-stub pattern correctly mirrored into BP + Weight, simplifier batch (helper extract / dead-export trim / `tx?` drop) is mechanically clean, prompts-dir unification leaves no stale references, soft-delete reader-tier gaps closed correctly. Two correctness items deserve attention before tag; the rest are recommendations / defers.

## Critical (must fix before tag)

None.

## High (should fix before tag)

### H-1 `check-user` identifier `.toLowerCase()` does not match how usernames / emails are stored
- **File**: `src/app/api/auth/check-user/route.ts:62-74`
- **Issue**: `parsed.data.identifier.toLowerCase()` is compared against `username` / `email` with an exact-match Prisma predicate, but the register route (`src/app/api/auth/register/route.ts:84,108-109`) stores both columns exactly as the user typed them (`registerSchema` in `src/lib/validations/auth.ts:6-29` applies no `.transform(s => s.toLowerCase())`). A user registered as `email = "Marc@Example.com"` or `username = "MarcB"` will never resolve through this route → the iOS onboarding screen routes to the sign-up branch for an existing account.
- **Test gap**: the route test (`src/__tests__/api/auth/check-user/route.test.ts`) mocks `findFirst` so it cannot catch the casing mismatch.
- **Recommended fix (pick one, before tag)**:
  1. Drop the `.toLowerCase()` and accept the identifier exactly as iOS sends it (matches how every other auth surface in the codebase queries today — `profile-update.ts` is the lone exception and it normalises on write).
  2. Or, query against `OR: [{ username: identifier }, { username: identifier.toLowerCase() }, { email: identifier }, { email: identifier.toLowerCase() }]` so both legacy mixed-case and forward-looking lowercased storage resolve.
  3. Document the limitation in the route JSDoc and add a follow-up to normalise emails at register time (the right long-term fix; out of scope here).

### H-2 `pg.Pool` scaling doc commit carries the `Co-Authored-By: Claude` trailer
- **File**: commit `70c50268` ("docs(operator): pg.Pool max scaling guidance for multi-container deploys")
- **Issue**: Memory `feedback_marc_voice_english.md` (and the v1.4.20 retroactive cleanup directive) requires every user-facing artefact — including commit messages on `main` — to read as Marc's authorship; never expose "Claude / AI / agent". The trailer is the only such breach in the v1.4.41 commit range (verified: every other develop commit's trailer is empty).
- **Recommended fix**: After squash-merge to `main`, the squash commit message is written from scratch — confirm the final tag commit carries no `Co-Authored-By: Claude` trailer. If the convention is to keep per-commit history on develop (it is — see `git log --oneline main..develop`), this trailer ships permanently on develop. Either drop the trailer with `git commit --amend` before the next sync, or accept that it landed on develop only (squash hides it from main).

## Medium (recommended for tag)

### M-1 Soft-delete integration test does not cover `gamification/achievements` + `doctor-report/availability` despite the test header listing them
- **File**: `src/app/api/export/__tests__/soft-delete-filter.test.ts:1-15` (header), 87-117 (only export routes asserted)
- **Issue**: The header docstring promises coverage for five routes; only three are pinned (`/api/export`, `/api/export/full-backup`, `/api/export/measurements`). Achievement progress + the doctor-report section-availability probe are documented as in-scope but never asserted, so a future refactor that drops the `deletedAt: null` predicate in those handlers ships silently.
- **Recommended fix**: Add the missing two `it()` blocks now — both routes are already mocked in the file's `vi.mock("@/lib/db", ...)` block. ~30 lines, no test-infra work.

### M-2 ESLint `queryKey-factory` rule whitelist is narrower than the parallel test-guard substitute
- **File**: `eslint-plugins/healthlog/queryKey-factory.js:46-57` vs `src/lib/__tests__/query-keys.test.ts:193-200`
- **Issue**: The test-guard substitute now guards `src/app/auth`, `src/app/notifications`, and `src/components/settings/about-section.tsx` (added in `0bf07abd`); the ESLint rule's `GUARDED_DIRECTORIES` + `GUARDED_FILES` still cover only `charts`, `comparison`, `page.tsx`, `use-auth.ts`. The author flagged the gap in-source ("Extend in lockstep") but it is unclosed.
- **Recommended fix**: Mirror the test-guard's `guardedRoots` list into the ESLint rule before tag so the IDE / lint CI hooks fail at the same boundary the unit-test walker does. Two-line patch.

### M-3 v1.4.39 W-SUM legacy-NULL UNION retirement assumes single-tenant convergence (operators may not have converged)
- **File**: `src/lib/rollups/measurement-rollups.ts:752-775` (commit `9d2901aa`)
- **Issue**: Commit message: "Marc's tenant converged at v1.4.40, so the arm was a permanent no-op seq scan". Self-host operators with measurements that pre-date v1.4.39 will keep legacy `sum_value IS NULL` rows forever now — the boot-backfill will not re-enqueue them.
- **Mitigation already in place**: `/api/dashboard/summary/route.ts:497-500` keeps the `mean * count` read-side fallback, so correctness is preserved indefinitely. Only the slow-path fallback runs for legacy rows; this is correct but slightly slower than the converged path.
- **Verdict**: Accept as-is. The read-side fallback is mathematically identical to `sum_value` for `count > 0`, so the only operator cost is one extra `Number()` multiply per legacy row. If a future audit wants to converge self-host data, ship a one-shot operator script (not a permanent seq-scan UNION).

## Low (defer to v1.4.42)

### L-1 Duplicate `DataSummary` import aliases in `src/types/analytics.ts`
- **File**: `src/types/analytics.ts:37-38`
- **Issue**: `import type { DataSummary } from "@/lib/analytics/trends"; import type { DataSummary as DataSummaryType } from "@/lib/analytics/trends";` — both names point at the same type. `DataSummaryType` is used once (line 80). Pure style noise; either drop `DataSummary` or use `DataSummary` everywhere.
- **Fix**: One line.

### L-2 Dedupe key in shared today-intake helper uses UTC slice not user-tz dayKey
- **File**: `src/lib/medications/scheduling/project-today-intakes.ts:130`
- **Issue**: `m.scheduledFor.toISOString().slice(0, 10)` derives the per-day dedupe key from UTC, not from `userTz`. For a Pacific/Auckland user, a 23:30-local schedule on Monday can land in Tuesday-UTC so two same-local-day intakes could be deduped under different keys (or vice versa). Net effect: at most one extra recompute fired per day; never missing a needed recompute. Pre-existing condition — identical key shape in the v1.4.39 originals — not introduced by this refactor.
- **Fix**: When touching this code next, derive the dayKey from `dayKeyForScheduledFor(m.scheduledFor, userTz)` (already exported from `medication-compliance-rollups.ts`). Defer.

### L-3 Test pin regex relies on Suspense fallback ordering in `src/app/page.tsx`
- **File**: `src/app/__tests__/dashboard-suspense-boundaries.test.ts:58-60`
- **Issue**: The non-greedy `/<Suspense\s+fallback=\{[\s\S]*?aria-hidden="true"[\s\S]*?\}\s*>/` works only because the tile-strip Suspense block (line 1425 in `page.tsx`) precedes the `ChartSkeleton` Suspense block (line 1465). A future refactor that reorders the two — or that puts an `aria-hidden` attribute inside any Suspense block before the tile-strip — would silently match the wrong block. The current pin happens to be correct.
- **Fix**: When the test changes next, anchor on a unique substring (e.g. `bg-card border-border h-full w-full rounded-xl` from line 1429). Defer.

## Strengths

- **Timeout-stub persist mirror is byte-true to bmi-status**: `blood-pressure-status.ts:542-588` and `weight-status.ts:440-486` carry exact-shape clones of the bmi pattern at `bmi-status.ts:293-340`. The `meta.timeout: true` flag, the `model: "timeout-stub"` sentinel, the best-effort `try/catch` swallow, and the `stubUpdatedAt` envelope all match. The cache-read short-circuit at `blood-pressure-status.ts:167-194` will recognise the stub on the next mount — verified.
- **Simplifier batch is mechanically clean**: 5 unused imports gone, 13 dead exports narrowed, 3 dead `tx?` params removed. All call-sites verified (`recompute*` are always called outside `$transaction(tx)` — confirmed across `mood-entries/*`, `medications/intake/*`, `ingest/medication`, `telegram/webhook`, `moodlog/webhook`, `reminder-worker.ts`). No call-site changes needed because the params were optional everywhere.
- **Today-intake helper extraction preserves semantics + telemetry**: `{ projected, backfilled }` return shape carries the existing `annotate()` payload; both routes' source callsites remained side-effect-equivalent to the inlined v1.4.39 originals.
- **Soft-delete reader-tier sweep is complete**: every measurement read in `/api/export*`, `/api/doctor-report/*`, `/api/gamification/achievements` now scopes to `deletedAt: null`. Cross-checked against `prisma.measurement.findMany|count|aggregate|groupBy` callsites in `src/app/api/` — only intentional exception is `/api/measurements/by-external-ids` (hard-delete reconciliation) and `/api/measurements/batch` (iOS dedupe needs to see tombstones). Both are correct.
- **Prompts directory unification is complete with no stragglers**: `grep -r "from \"@/lib/insights/prompt"` in `src/` + `tests/` returns zero hits; only `.next/` build cache references remain (regenerated on next build). Three importers updated correctly.
- **QueryKey factory is now ESLint-enforced**: real lint-CI rule lands alongside the existing test-guard substitute. Defence-in-depth pattern is healthy.
- **Types consolidation (AnalyticsData, BackupRow/BackupsList) closes the v1.4.39 org-audit rec #2 cleanly**: route handler no longer leaks DTOs into a component import, three structurally-distinct `AnalyticsData` shapes hoisted to one home with named exports + per-surface aliases. The deliberate choice to keep four shapes (not collapse to optional swiss-army) is well-justified in the header comment.
- **Suspense fallback test pin update lands the layout-stable contract correctly**: the new regex pins the `aria-hidden` placeholder div that prevents CLS on a future RSC hoist.
