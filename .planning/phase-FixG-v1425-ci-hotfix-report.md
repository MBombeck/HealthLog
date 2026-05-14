# Phase Fix-G — v1.4.25 CI Hot-fix Report

PR #168 (`develop → main`) had 5 failing CI checks on commit `a7cc5de`.
This phase landed five atomic fixes to clear the unit-test, Turbopack
chunking, and standalone-build-trace failures.

## Commits

| sha       | summary                                                                |
| --------- | ---------------------------------------------------------------------- |
| `4feeafa` | `fix(health-score): derive asOf deterministically from input dates`    |
| `ee560a4` | `fix(medications): glp1 drift test self-skips when research file is absent` |
| `7bede83` | `fix(tz): split pure helpers out of resolver to keep client bundle clean`   |
| `87853eb` | `fix(validations): route source-priority parse breadcrumb via observer`     |
| `dd44a0d` | `fix(build): resolve safety-contracts YAML path from cwd, not __dirname`     |

## Root causes + fixes

### 1. `computeHealthScore` non-deterministic (health-score.test.ts:281)

`src/lib/analytics/health-score.ts` synthesised the
`HealthScoreSourceAttribution.windowEndAt` fallback as `new Date()`.
Two back-to-back calls drifted by one millisecond on loaded CI runners
and broke the determinism assertion. The fallback now picks the latest
date across `weightSeriesLast30d` and `moodEntriesLast30d` (Unix epoch
when neither has entries) so the result is byte-identical across calls.
Production routes already supply their own `windowEndAt` and are
unaffected. Added a focused test asserting per-component `asOf`
stability across consecutive invocations.

### 2. `glp1-knowledge-drift.test.ts` failed to collect (0 tests)

The test read `.planning/research/glp1-feature-inspiration.md`
unconditionally with `readFileSync` at the module top. `.planning/` is
local-only by convention, so CI's checkout doesn't carry the file and
the test threw ENOENT at collection. The hard-pin block (TS module vs
cited EMA EPAR / psp4.13099 values) is the actual production guarantee
and runs everywhere; the two soft-pin blocks that grep the markdown now
use `describe.skipIf(!RESEARCH_AVAILABLE)`.

### 3. Turbopack chunk error — `node:module` from `tz/resolver`

`@/lib/tz/resolver` imported `prisma` at module top. Four client
components plus `@/lib/export` reached for pure helpers and dragged
`node:module` into the browser bundle. Turbopack refused to chunk the
result and the Docker build failed.

Pure helpers now live in `src/lib/tz/format.ts` (no Prisma). The
resolver keeps the cached Prisma-backed entry points and re-exports
every helper so server-side callers stay on `@/lib/tz/resolver`. The
five client modules + the export helper now import from `./format`.

### 4. Turbopack chunk error — `node:async_hooks` from `source-priority`

`@/lib/validations/source-priority` imported `annotate` from
`@/lib/logging/context`. `AsyncLocalStorage` (`node:async_hooks`)
followed the import chain into `settings/sources-section` and broke the
build.

The validations module now exposes
`registerSourcePriorityParseObserver` with a no-op default.
`@/lib/logging/context` registers the real `annotate` callback as a
side-effect on first server-side import, so the ops breadcrumb still
fires while the client bundle stays clean.

### 5. Standalone build ENOENT on safety-contracts YAML

Turbopack rewrites `__dirname` to a synthetic `/ROOT/...` token, so
`safety-contracts.ts` crashed during page-data collection with
`ENOENT /ROOT/src/lib/ai/prompts/safety-contracts.fr.yaml`. The chunk
error from #3 was hiding the issue. Path now resolves through
`process.cwd() + 'src/lib/ai/prompts'` and `outputFileTracingIncludes`
in `next.config.ts` ships the YAML siblings into the standalone runtime
image.

## Quality gates (local)

- `pnpm typecheck` — clean
- `pnpm lint` — 0 errors, 1 warning (W16c parallel agent file, not in
  this scope)
- `pnpm build` — succeeds end-to-end (chunks + page data collection)
- `pnpm test src/lib/{analytics,medications/__tests__,tz,validations,ai/prompts,ai/coach,sources,export}` —
  all 359+554 = 913 tests green
- Full `pnpm test` — 3458 / 3461 green; the 2+1 remaining failures are
  W16c's `personal-record-badge` test files (parallel agent
  work-in-progress, not in this phase's scope).

## CI state on develop after pushes

After commit `87853eb` (commits 1–4):
- `Lint, Typecheck & Test` — **PASS** (was failing)
- `Dependency Audit` — pass
- `Secret Scanning` — pass
- `Build amd64 / arm64 / e2e` — still failing on safety-contracts ENOENT
  (root cause now exposed once chunking error cleared)
- `integration` — still failing on 3 W16c/W16b/W7-cascade tests

After commit `dd44a0d` (commit 5): build amd64/arm64/e2e expected to
pass. Awaiting CI result.

## Out-of-scope failures still on PR #168

- **integration** — three suites fail
  (`tests/integration/timezone-per-user.test.ts`,
  `tests/integration/coach-prefs.test.ts`,
  `tests/integration/measurements-batch-delete.test.ts`). The unique
  constraint failure on `measurements-batch-delete` is a fixture
  conflict against the W16c PR-detection batch-route path; the
  coach-prefs failure is a schema-drift between persisted shape and
  validator (extra `defaultWindow` field). Belongs to W16c / W16b /
  database-fixture upkeep.
- **W16c untracked files** —
  `src/components/insights/personal-record-badge.tsx` and the matching
  test file fail unit-test + build typecheck. The parallel agent is
  still iterating on the React-hook import. Touch-disjoint per task
  spec — not modified here.
