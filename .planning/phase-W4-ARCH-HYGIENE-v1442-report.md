# W4-ARCH-HYGIENE — v1.4.42

Branch: `worktree-agent-ae49fe4059ee48d37` (pushed)
Base: `d3d60104` (develop tip)
Commits: 4 atomic
Tests: 4 732 pass + 1 skipped (no regression vs. base)

## Items

### 1. BERLIN_DAY_FORMATTER seven-way dedup — DONE

Extracted the identical 20-LOC `BERLIN_DAY_FORMATTER` + `toBerlinDayKey`
block from seven `src/lib/insights/*-status.ts` files into
`src/lib/tz/resolver.ts`. Sites updated to import from there. Net −101
LOC across the seven helpers, +32 LOC in `resolver.ts` (helper + JSDoc).

Commit: `refactor(insights): dedup BERLIN_DAY_FORMATTER across seven status helpers`

### 2. Suspense double-comment consolidate — DONE

`src/app/page.tsx` trend-card Suspense: the two adjacent comment blocks
(v1.4.40 W-RSC seed + v1.4.41 W-FRONTEND-FACTORY fallback hoist) were
collapsed into a single 6-line block keyed to current behaviour with a
one-line trailer. The sibling chart-row Suspense (~lines 1441-1464)
inspected — single block already, no drift, untouched. The structural
test (`dashboard-suspense-boundaries.test.ts`, 5 cases) still passes.

Commit: `refactor(dashboard): consolidate Suspense double-comment in tile strip`

### 3. doctor-report-data.ts literal control bytes — DONE

The sanitiser regex carried raw `NUL`, `US`, `DEL` bytes inside the
character class which made `file(1)` report "data" and `git diff` show
"Binary files differ". Replaced with escape-sequence form
`[\x00-\x1F\x7F]`. `file(1)` now reports `Java source, Unicode text,
UTF-8 text`. The stored blob is clean — future diffs are readable. 18
test cases still pass.

Commit: `chore(doctor-report): escape literal control bytes in sanitiser regex`

### 4. computeLongWindowSummary decision — NO-OP

Exhaustive grep across `src/`, plus broader scan excluding
`node_modules` / `.next` / `.planning` / CHANGELOG, returned zero
matches. The helper was already removed from the codebase between
v1.4.40 and v1.4.41. No action needed.

### 5. ensureUserMedicationComplianceFresh decision — NO-OP

Same shape as #4. Zero matches anywhere. Already cleaned up.

### 6. pr-detection-worker soft-delete + offhost-backup DR-intent — DONE

- `pr-detection-worker.ts:219-221` and `:402-407` — added
  `deletedAt: null` to both `where` clauses so a deleted PR no longer
  blocks promotion of the next-best row on the next detection pass.
- `offhost-backup.ts:219` — added an inline comment documenting the
  intentional inclusion of soft-deleted rows (DR snapshot, not user-
  facing export; symmetric exclusion in
  `/api/export/full-backup/route.ts`).

PR-worker test (17 cases) + offhost-backup test (9 cases) both still
pass.

Commit: `fix(personal-records): exclude soft-deleted measurements from PR detection`

## Gates

- `pnpm typecheck` — clean (after one-time `pnpm install` + `prisma generate`).
- `pnpm lint` — clean.
- `pnpm test --run` — 4 732 passed + 1 skipped, 444 files.

## Out-of-scope avoided

No edits to: `.github/workflows/knip.yml`, `knip.json`,
`src/app/api/dashboard/widgets/**`, `src/lib/api-response.ts`,
`src/components/{settings,medications,admin,integrations}/**`,
`src/hooks/use-*.ts`, `src/lib/workouts/**`.
