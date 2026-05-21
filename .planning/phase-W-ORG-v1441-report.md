# W-ORG — v1.4.41 wave report

Closes v1.4.39 org-audit recommendations #2 (types promotion) and #3
(prompt unification).

## Commits landed on `develop`

1. `bba38b8c` — `refactor(types): move BackupRow and BackupsList out of
   route handler into src/types/backups.ts`
2. `dc66dfcf` — `refactor(types): consolidate AnalyticsData into
   src/types/analytics.ts`
3. `8a56f482` — `refactor(prompts): unify src/lib/insights/prompt*.ts
   into src/lib/ai/prompts/`

## Rec #2 — types promotion

### `BackupRow` / `BackupsList`
- New home: `src/types/backups.ts`.
- The single component → route-handler import in the codebase
  (`components/admin/backups-section.tsx ← app/api/admin/backups/route.ts`)
  is closed. The route still owns the HTTP contract but re-imports the
  shapes from the shared module.

### `AnalyticsData` consolidation
Three structurally-distinct inline interfaces collided on the name
across `src/app/page.tsx`, `src/app/insights/page.tsx`, and
`src/components/onboarding/getting-started-checklist.tsx`. Hoisted as
named exports in `src/types/analytics.ts`:
- `SubPageAnalyticsData` (pre-existing slim shape for sub-pages)
- `DashboardAnalyticsData` (BD-Zielbereich aggregates, glucoseByContext,
  lastSeenByType)
- `InsightsAnalyticsData` (correlations + healthScore for mother page)
- `ChecklistAnalyticsData` (loose per-type count shape)

Call sites re-import their shape under the original local alias so
downstream code reads unchanged. Four named shapes (not one optional
mega-shape) keep call sites from cross-reading fields they shouldn't
reach for.

## Rec #3 — prompt unification

Moves:
- `src/lib/insights/prompt.ts` → `src/lib/ai/prompts/insight-system-prompt.ts`
- `src/lib/insights/prompt-compact.ts` → `src/lib/ai/prompts/compact-sections.ts`
- Co-located tests follow (`__tests__/prompt-comparison.test.ts`,
  `__tests__/compact-sections.test.ts`).

Three importers updated:
- `src/app/api/insights/generate/route.ts`
- `src/lib/ai/coach/snapshot.ts`
- `src/app/api/insights/generate/__tests__/route.test.ts` (the
  `vi.mock("@/lib/insights/prompt")` mock path moved too).

Prompts now have one home — `src/lib/ai/prompts/`. Nothing remains
under `src/lib/insights/prompt*`.

## Quality gates

- `pnpm typecheck` — clean for the W-ORG touch set. Remaining errors
  (`rollups/__tests__/measurement-read-wmy`,
  `measurement-read-cumulative`, `summaries-slice`) belong to W-PERF-OPS
  / W-DELETED-2 and are touch-disjoint.
- `pnpm test --run src/lib/ai/prompts/__tests__/` and the
  `app/api/insights/generate/__tests__` paths pass.
- One unrelated `dashboard-suspense-boundaries.test.ts` regex contract
  failure observed pre-this-wave (different wave's territory).

## Out of scope (per touch-disjoint guards)

- `src/lib/rollups/**` (W-PERF-OPS).
- `src/app/api/insights/**` body changes (W-INSIGHTS-HOT) — only the
  one import path in `generate/route.ts` was touched to follow the
  prompt move.
