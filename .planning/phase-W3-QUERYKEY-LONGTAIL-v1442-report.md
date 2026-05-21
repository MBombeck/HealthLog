# W3-QUERYKEY-LONGTAIL v1.4.42 report

## Branch + commit

- Worktree branch `worktree-agent-a11813dd22a55cbf7`, branched from
  `develop` tip `d3d60104`.
- One squash-ready commit: `e50d3797 refactor(query-keys): route
  long-tail surfaces through the factory`.

## Scope landed

The settings / medications / admin / hooks tree still declared
bare-literal `queryKey: [ … ]` arrays at ~70 call sites
post-v1.4.41 W-FRONTEND-FACTORY. Every site now routes through
`queryKeys.<entry>()` from `src/lib/query-keys.ts`.

### Files migrated (43 total, all absolute paths)

Settings (12):
- /Users/marc/Projects/HealthLog/src/components/settings/account-section.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/advanced-section.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/ai-section.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/api-section.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/integrations-section.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/mood-reminder-card.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/notification-status-card.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/notifications-section.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/ntfy-card.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/telegram-card.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/thresholds-editor-section.tsx

Medications (8):
- /Users/marc/Projects/HealthLog/src/components/medications/DrugLevelChart.tsx
- /Users/marc/Projects/HealthLog/src/components/medications/ResearchModeAcknowledgmentDialog.tsx
- /Users/marc/Projects/HealthLog/src/components/medications/SchedulingSection.tsx
- /Users/marc/Projects/HealthLog/src/components/medications/TitrationSection.tsx
- /Users/marc/Projects/HealthLog/src/components/medications/glp1-medication-card.tsx
- /Users/marc/Projects/HealthLog/src/components/medications/intake-history-list-v2.tsx
- /Users/marc/Projects/HealthLog/src/components/medications/medication-card.tsx
- /Users/marc/Projects/HealthLog/src/components/medications/phase-config-dialog.tsx

Admin (14):
- /Users/marc/Projects/HealthLog/src/components/admin/_shared.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/ai-quality-section.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/api-token-overview-section.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/app-log-preview-section.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/assistant-section.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/backups-section.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/coach-feedback-section.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/feedback-inbox-section.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/host-metrics-chart.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/login-overview-section.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/recent-audit-preview.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/system-status-section.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/system-status-summary.tsx
- /Users/marc/Projects/HealthLog/src/components/admin/user-management-section.tsx

Hooks (4):
- /Users/marc/Projects/HealthLog/src/hooks/use-coach-prefs.ts
- /Users/marc/Projects/HealthLog/src/hooks/use-feature-flags.ts
- /Users/marc/Projects/HealthLog/src/hooks/use-insights-analytics.ts (JSDoc fix only — no real bare-literal)
- /Users/marc/Projects/HealthLog/src/hooks/use-workouts.ts

App pages (3):
- /Users/marc/Projects/HealthLog/src/app/medications/page.tsx
- /Users/marc/Projects/HealthLog/src/app/medications/[id]/history/page.tsx
- /Users/marc/Projects/HealthLog/src/app/targets/page.tsx (JSDoc fix + two reads)

Factory + guards (2):
- /Users/marc/Projects/HealthLog/src/lib/query-keys.ts
- /Users/marc/Projects/HealthLog/src/lib/__tests__/query-keys.test.ts
- /Users/marc/Projects/HealthLog/eslint-plugins/healthlog/queryKey-factory.js

## Factory additions

- `medicationCompliance(id)` — `["medications", id, "compliance"]`
- `medicationTitration(id)` — `["medications", id, "titration"]`
- `medicationCadence(id)` — `["medications", id, "cadence"]`
- `medicationGlp1Details(id)` — `["medications", id, "glp1-details"]`
- `medicationIntakeDrugLevelChart(id)` —
  `["medications", id, "intake", "drug-level-chart"]`
- `medicationIntakeList(id, { sortBy, sortDir, limit, offset, status })`
  — `["medications", id, "intake", "list", params]`
- `withingsStatus()` — `["withings", "status"]` (shares the
  `["withings"]` prefix with `withings()` so a disconnect mutation
  invalidates both)
- `adminAuditLogFiltered({ filter, page, perPage, actor, actionFilter,
  target, range })` — packs the 7 params under the
  `["admin", "audit-log", "filtered"]` prefix
- `workoutsRecentList({ limit?, offset?, since?, sportType? })` —
  replaces the spread-and-append `[...workoutsRecent(), opts]` shape
  that `useWorkouts` carried since v1.4.32 (a factory composite, but
  still an ArrayExpression as far as the ESLint rule is concerned).

## ESLint allowlist additions

`eslint-plugins/healthlog/queryKey-factory.js`:

- `GUARDED_DIRECTORIES` adds `src/components/settings`,
  `src/components/medications`, `src/components/admin`, `src/hooks`.
- `GUARDED_FILES` adds `src/app/medications/page.tsx`,
  `src/app/medications/[id]/history/page.tsx`,
  `src/app/targets/page.tsx`.

## Test-guard updates

`src/lib/__tests__/query-keys.test.ts`:

- `guardedRoots` mirrors the new ESLint scope (four directories + three
  files).
- New `it(…)` blocks pin the byte-stable shape of every new factory
  entry (`medicationCompliance`, `medicationTitration`,
  `medicationCadence`, `medicationGlp1Details`,
  `medicationIntakeDrugLevelChart`, `medicationIntakeList`,
  `withingsStatus`, `adminAuditLogFiltered`, `workoutsRecentList`).

## Quality gates

- `pnpm typecheck` — clean (pre-existing implicit-any drift in
  test/integration files is untouched).
- `pnpm lint` — clean.
- `pnpm test --run` — 4 736 passed, 1 skipped, 444 test files. Factory
  walker reports zero bare-literal `queryKey:` in any newly-guarded
  surface.

## Reconcile callouts

- `src/hooks/use-insights-analytics.ts` carried a JSDoc example that
  literally read `queryKey: ["analytics"]`. The test-guard regex
  strips line-comments but not JSDoc block comments, so the example
  was reworded to keep the surface lintable without losing the
  documentation intent. Same fix on `src/app/targets/page.tsx` line 50.
- `useWorkouts` previously composed `[...queryKeys.workoutsRecent(),
  { … }]`. Technically routed through the factory but still an
  ArrayExpression that the ESLint rule flags. New factory entry
  `workoutsRecentList` owns the full shape.
- The big `ai-section.tsx` file had eight separate
  `invalidateQueries({ queryKey: ["insights"] })` call sites; all
  collapsed via `replace_all` onto `queryKeys.insightsRoot()`.
- `setQueryData(["admin", "settings", "assistant-flags"], data)` in
  `admin/assistant-section.tsx` is now `setQueryData(
  queryKeys.adminAssistantFlags(), data)`, keeping the optimistic
  cache write byte-identical with the read query above it.
- No `mutationKey: [ … ]` literals exist in the guarded tree.
- Worktree symlinks (`node_modules`, `src/generated/prisma`) are
  gitignored; not part of the commit.
