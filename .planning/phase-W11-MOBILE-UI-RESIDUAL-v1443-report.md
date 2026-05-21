# Phase W11-MOBILE-UI-RESIDUAL — v1.4.43

**Branch**: `w11-mobile-ui-residual-v1443` (pushed to origin)
**Base**: `origin/develop` (rebased clean onto every new tip during the wave)
**Scope source**: `.planning/round-v1443-AUDIT-mobile-ui-findings.md`

## Items closed

| Item | Status | Commit |
|---|---|---|
| M1 — `Loader2 animate-spin` missing `motion-reduce:animate-none` (21 sites) | Closed | `16a85b53` |
| M2 — `phase-config-dialog.tsx` Input + Button 32 px + `text-sm` | Closed | `cd160a3f` |
| M3 — Insights dynamic skeletons height mismatch | Closed (with L4) | `37988bbb` |
| M4 — `correlation-card.tsx` scatter skeleton aspect-ratio mismatch | Closed | `f87265df` |
| M5 — Dashboard "blocked-then-burst" tile-strip during slow slim | Closed | `125a2e31` |
| M6 — `health-chart.tsx` empty-window silently `return null` | Closed | `24ff6754` |
| L1 — Insights tab-strip group-popover `min-h-10` | Closed | `3aca96ec` |
| L2 — `chart-overlay-controls.tsx` `size="sm"` + stretched `min-h-11` mix | Closed | `0b25ba40` |
| L4 — `next/dynamic` insights skeletons missing `motion-reduce:animate-none` | Closed (folded with M3) | `37988bbb` |
| L6 — `RecentWorkoutsTile` + `DrugLevelChart` unreserved loading height | Closed | `b6bc77f4` |

## Items deferred + why

- **L3 — Textarea primitive** — out of scope per handoff (`Defer (do NOT do in this wave) — L3 Textarea primitive — bigger refactor with 6+ call-sites, defer to v1.4.44 standalone wave`).
- **L5 — `injection-site-picker.tsx:178` `<div tabIndex={0} role="button">` → `<button type="button">`** — the audit description is incorrect about the element type. The actual code is an **SVG `<circle>` element**, not an HTML `<div>`. SVG circles cannot be converted to HTML `<button>` directly; replacing the picker's SVG hit zones with overlaid absolute-positioned HTML buttons is a non-trivial layout refactor that goes well beyond a one-line low-priority fix. The current implementation already exposes `role="button"`, `tabIndex={0}`, `aria-pressed`, `aria-label`, and a proper `onKeyDown` for Enter/Space, so it remains keyboard- and screen-reader-accessible. Deferring with a note for v1.4.44; if the layout overhaul is desired, that work should land standalone with a small Playwright/snapshot harness so the picker's geometry doesn't drift during the refactor.

## Test additions

| File | Tests | Purpose |
|---|---|---|
| `src/components/__tests__/motion-reduce-spin-coverage.test.ts` | 2 | Scans `src/**` for every `animate-spin` site and fails if any lack `motion-reduce:animate-none`. Future spinners can't drift silently. |
| `src/app/insights/__tests__/page-skeletons.test.ts` | 4 | Pins the three insights mother-page dynamic-skeleton heights + motion-reduce class; fails if the legacy `h-48/h-32/h-64` trio comes back. |
| `src/components/insights/__tests__/correlation-card-skeleton.test.ts` | 2 | Pins the scatter-chart aspect-ratio quartet on both the loaded chart and the skeleton mirror. |
| `src/app/__tests__/dashboard-tile-strip-skeleton.test.ts` | 6 | Six pins for the new M5 skeleton: `configuredTileCount` derivation, gate condition, grid track parity, card count, `aria-hidden` + motion-reduce, and EmptyState suppression while loading. |
| `src/components/charts/__tests__/health-chart-no-data-in-range.test.tsx` | 1 | Asserts the new `charts.noDataInRange*` empty state paints and that the card chrome (title) stays mounted; verifies the < 3-points hint is suppressed so the two situations don't blur. |

**Net additions**: 5 new test files × 15 new test cases. Full unit-suite count: 4 815 → **4 861** (+46 — also reflects new tests landed on develop during the wave by other agents).

## Quality gates

- `pnpm typecheck` — clean (after `pnpm db:generate` to regenerate the Prisma client in the worktree).
- `pnpm lint` — clean.
- `pnpm test` — 461 files, 4 861 passed, 1 skipped, 0 failed.
- Touched-area component tests (charts/insights/dashboard/medications/admin/settings/mood/doctor-report) — 891 of 891 passed.

## i18n additions

Added `charts.noDataInRangeTitle` + `charts.noDataInRangeDescription` to all six locales (`de`/`en`/`es`/`fr`/`it`/`pl`) for the M6 empty-window state. Copy mirrors the existing chart-empty-state register (calm, action-oriented; distinct from the < 3-points "Mehr Messtage" register).

## Commit SHAs in chronological order

1. `16a85b53` — a11y(ui): pair animate-spin with motion-reduce:animate-none across 21 sites (M1)
2. `cd160a3f` — fix(medications): bump phase-config-dialog Input + Button to 44 px on mobile (M2)
3. `37988bbb` — fix(insights): match dynamic-skeleton heights to loaded content + motion-reduce (M3 + L4)
4. `f87265df` — fix(insights): mirror scatter-chart aspect ratio on correlation-card skeleton (M4)
5. `125a2e31` — fix(dashboard): paint tile-strip skeleton during slow slim-analytics fetch (M5)
6. `24ff6754` — fix(charts): paint empty-window state instead of erasing the card (M6)
7. `3aca96ec` — a11y(insights): bump tab-strip group-popover items to 44 px (L1)
8. `0b25ba40` — a11y(charts): use responsive sizing on chart-overlay-controls trigger (L2)
9. `b6bc77f4` — fix(ui): reserve loaded-card height on workouts + drug-level loading states (L6)

## Notes for the reconcile / final-merge step

- The `motion-reduce-spin-coverage` test scans `src/**` recursively. If a future wave introduces another spinner without the modifier, the test fails before merge — there's no longer a need to grep for the pattern manually during release prep.
- The M5 tile-strip skeleton **suppresses the EmptyState** while loading. If a future change adds another empty-state branch on the dashboard, mind the `!showTileStripSkeleton` clause so the skeleton can still paint during a slow-network cold mount.
- The M6 chart change keeps the card shell mounted when data is empty. Any caller that depends on the legacy "chart silently returns nothing" contract (e.g. a tile that gates on `chart.height > 0` via a `ref`) would now see the empty-state card instead. None found in the audit pass; mention in case downstream reviewers spot one.
