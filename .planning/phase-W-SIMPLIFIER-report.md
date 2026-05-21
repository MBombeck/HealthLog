# Phase W-SIMPLIFIER — v1.4.41

## Branch

`worktree-agent-ae93a3f076c190857` (off `develop` @ `a1bfc3b4`).

## Commits (4)

1. `a106c82c` — `chore(cleanup): drop five unused imports flagged by eslint`
2. `aebb8a5b` — `refactor(medications): extract shared today-intake projection helper`
3. `da9f067c` — `refactor(rollups): drop unused optional tx params from recompute helpers`
4. `d6752cf9` — `chore(cleanup): trim 13 dead exports surfaced by knip`

## 1. Lint warnings — closed

All 5 `@typescript-eslint/no-unused-vars` warnings are gone. `pnpm lint` is clean.

- `src/app/insights/page.tsx`: dropped `CorrelationResult` + `DataSummary` type imports.
- `src/lib/analytics/summaries-slice.ts`: dropped `RollupGranularity`,
  `aggregateWmyBuckets`, and `RollupBucketRow` from the imports (both helpers
  remain exported from `measurement-read-wmy.ts` because the test suite still
  exercises them).

## 2. Helper extraction — applied

Created `src/lib/medications/scheduling/project-today-intakes.ts` exposing
`projectTodayIntakesAndRecompute({ userId, userTz, todayStart, todayEnd })`.

Wired into both call sites:

- `src/app/api/medications/intake/route.ts` (scope=today branch)
- `src/app/api/dashboard/summary/route.ts` (`projectAndReadTodaysIntakes`)

The helper folds the projection, the idempotent `createMany`
(`skipDuplicates: true`), and the per-`(med, day)` compliance recompute
(`Promise.allSettled`) that both routes were carrying in lockstep. Returns
`{ projected, backfilled }` so the intake route can still emit telemetry.

Net: ~200 inline lines replaced by one 145-line shared helper plus short
call sites.

## 3. Unused `tx?` params — dropped

Three Prisma helpers carried `tx?` Prisma transaction-client params that no
call site has ever passed:

- `src/lib/rollups/mood-rollups.ts` → `recomputeMoodBucketsForEntry`
- `src/lib/rollups/medication-compliance-rollups.ts` →
  `recomputeMedicationComplianceForDay` and
  `recomputeMedicationComplianceForEvent`

Dropping the params also dropped the `PrismaLike` / `PrismaTxOrClient` aliases
that only existed to type them, and the now-orphan top-level
`import type { Prisma }` in `medication-compliance-rollups.ts`. The
`PrismaTxOrClient` alias stays in `mood-rollups.ts` for two internal helpers
that legitimately consume it (`runMoodRollupAggregate`,
`persistMoodRollupRows`). No call-site changes needed.

## 4. Bonus — 13 dead knip exports trimmed

In commit 4:

- Narrowed file-local visibility (dropped `export`): `getTrendSentiment`,
  `isPRWithin30Days`, `buildCoachMetricSourceType`, `countPassedSchedules`,
  `getGithubConfig`, `isComparisonBaseline`, `DASHBOARD_LAYOUT_VERSION`,
  `INTL_LOCALE_MAP`, `SIDE_EFFECT_NOTES_MAX`, `MEDICATION_CATEGORIES`,
  `openApiBase`, `ALL_MOOD_GRANULARITIES`.
- Outright deletions: `CodexOAuthNotConfiguredError` (backwards-compat shim
  that nothing has imported in any branch), `editMessageReplyMarkup` (Telegram
  helper no dispatch path calls), and the stale `DISPLAY_TIMEZONE` re-export
  from `src/lib/format.ts`.

Reverted four candidate narrowings that ESLint reported as
"assigned but only used as a type" once their export was dropped
(`CHART_RANGE_PRESETS`, `CHANNEL_TYPES`, `CHECKLIST_ITEM_IDS`,
`moodLogSyncResponseSchema`) — these constants act as the source of truth for
neighbour `typeof X[number]` / `z.infer<typeof X>` type aliases that ARE
exported, so the lint rule legitimately flags them as value-dead. Keeping the
exports is the conservative call.

## Knip delta

| Category | Before | After |
| --- | --- | --- |
| Unused exports | 48 | 35 |
| Unused exported types | 52 | 52 |

(I did not touch the unused-types bucket — that's almost entirely zod-schema
inferred `*Input` types and Prisma-row narrowings that have legitimate
downstream consumers in routes / iOS contract / OpenAPI doc generation, even
when knip can't see the indirect reference. They're better triaged with a
flag-by-flag audit in v1.4.42.)

## Verification

- `pnpm typecheck` — clean
- `pnpm lint` — clean (0 warnings, 0 errors)
- `pnpm vitest run src/` — 4717 passing, 1 pre-existing failure (see
  reconcile callouts), 1 skipped (was 4719 before)

## Reconcile callouts

- `src/app/__tests__/dashboard-suspense-boundaries.test.ts` —
  `wraps each tile-strip cell in a <Suspense> boundary` fails on the
  v1.4.40 tip independently of my changes (verified by `git stash` +
  re-run). The test pins the literal source `fallback={null}` but the
  component now uses `fallback={<ChartSkeleton />}`. NOT introduced by
  this phase. Fix is one regex tweak; should land in a separate hotfix
  or get folded into the v1.4.41 release branch.
- `src/lib/rollups/measurement-rollups.ts` — left untouched per the
  do-NOT-touch list (W-PERF-OPS-1 UNION cleanup in flight). Knip still
  flags `isRollupFresh` there; that's a clean removal candidate for
  v1.4.42 once that worktree merges.
- `src/app/api/insights/blood-pressure-status/**` +
  `src/app/api/insights/weight-status/**` — untouched, no dead code
  observed during incidental reads.

## Follow-up for v1.4.42

These knip items are SAFE candidates I deferred to stay within the session
budget — each was spot-checked as truly unreferenced (no test, no e2e,
no script reference), but the cleanup is mechanically tedious and would
benefit from a fresh-context pass:

- `tokenKind`, `describeInjectionSite`, `PROGRESS_TICK_RECORDS`,
  `MAINTAINED_LOCALES`, `SUB_PAGE_METRIC`, `withBackgroundEventSafe`,
  `listSupportedTimezones` re-export at `tz/resolver.ts`,
  `AlertDialogMedia / AlertDialogOverlay / AlertDialogPortal`,
  `AvatarBadge / AvatarGroup / AvatarGroupCount`, `badgeVariants`,
  `buttonVariants`, `CardFooter / CardAction / CardDescription`,
  `DialogOverlay / DialogPortal / DialogTrigger`, the six unused
  `DropdownMenu*` exports, the five unused `Select*` exports,
  `SheetTrigger`, `TableFooter / TableCaption`, `tabsListVariants` (these
  shadcn surface-area exports may stay on purpose as a "library shape"
  contract — needs Marc's call before removing).
- `isRollupFresh` in `measurement-rollups.ts` — pending W-PERF-OPS-1 merge.
- All 52 "unused exported types" — needs a flag-by-flag audit (zod
  `z.infer<>` types are legitimately consumed via duck-typed JSON
  bodies, the iOS native client contract, and OpenAPI doc generation).
- `recommendationSeveritySchema / aiCitationSchema / aiWarningSchema /
  storyboardAnnotation*` in `src/lib/ai/schema.ts` — sit in the AI
  schema surface; the matching types ARE exported and may be consumed
  indirectly through the response validators.

## Files touched

- `src/app/api/dashboard/summary/route.ts`
- `src/app/api/medications/intake/route.ts`
- `src/app/insights/page.tsx`
- `src/components/charts/trend-card.tsx`
- `src/components/insights/personal-record-badge.tsx`
- `src/lib/ai/codex-oauth.ts`
- `src/lib/ai/feedback-attribution.ts`
- `src/lib/analytics/summaries-slice.ts`
- `src/lib/dashboard-layout.ts`
- `src/lib/feedback/publish-github.ts`
- `src/lib/format-locale.ts`
- `src/lib/format.ts`
- `src/lib/medication-category.ts`
- `src/lib/medications/scheduling/project-today-intakes.ts` (new)
- `src/lib/medications/side-effects/validators.ts`
- `src/lib/medications/window-status.ts`
- `src/lib/openapi/registry.ts`
- `src/lib/rollups/medication-compliance-rollups.ts`
- `src/lib/rollups/mood-rollups.ts`
- `src/lib/telegram.ts`
