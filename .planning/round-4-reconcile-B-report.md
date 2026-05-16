---
file: .planning/round-4-reconcile-B-report.md
purpose: R4-reconcile-B closure — UI + a11y + UI-conformity + simplifier + hygiene
created: 2026-05-16
contributor: R4-reconcile-B
---

# v1.4.28 — R4-reconcile-B closure

Touch-disjoint partner of R4-reconcile-A. Scope per the kickoff:
high-tier design findings (D-H1..H8), UI-conformity highs (UI-H1, UI-H2,
UI-H3), simplifier S-H1, dead-code M1, and the forbidden-vocabulary
scrub from the product-lead review (P-CRIT-2/3, P-HIGH-1) plus
dead-code's 9 stale comments.

Branch: `develop`. Starting HEAD: `5570971f`. Final HEAD after this
round: `f0e3e055`. Nine atomic commits, all gated on
`pnpm typecheck` + `pnpm lint` + the relevant Vitest suite.

## Commits

1. `b3f88026` — `fix(a11y): lift new icon buttons to the 44 px tap-target floor`
   - Targets-page Coach button: `min-h-11 min-w-11` over the shadcn
     icon variant.
   - HealthScore delta explainer trigger: 12 px glyph, 44 px hit area,
     `-my-3 -mx-2` to keep the row stride unchanged.
   - 2 new tests pinning the size contract.

2. `025c8885` — `fix(a11y): wire the HealthScore delta explainer for screen readers`
   - Drop the mobile `<span onClick onKeyDown>` wrapper; the button
     owns the open toggle directly. Single interactive element in the
     a11y tree.
   - Trigger paints `aria-expanded` + `aria-controls`; the
     parent-owned `useId` is threaded as `aria-describedby` on the
     delta `<span>` and as the body `id` on the explainer.
   - 4 new tests pinning the a11y wiring.

3. `d8229c26` — `fix(insights): drop the residual border on the mood trend tile`
   - The shadcn `<Card>` default paints `rounded-xl`; the trends row
     needs `rounded-md` to match HealthChart mini. Added
     `rounded-md` to the mini-mode className override.
   - 1 new test pinning the radius.

4. `786fbde6` — `fix(responsive): align medication-row and side-effects at narrow viewports`
   - `<MedicationCardHeader>` breaks state badges onto their own row
     so the FB-G1 two-line shape holds at 320 px.
   - `<SideEffectsSection>` date column narrows from `w-[5.5rem]` to
     `w-14` so the left slot recovers 32 px of wrap headroom.
   - Created `MedicationCardHeader.test.tsx` (3 tests) plus 1 new
     test in `SideEffectsSection.test.tsx`.

5. `e5cb74b4` — `refactor(medications): lift DrugLevelChart onto MedicationDetailSection`
   - Drop the `compact` prop + `windowHoursBefore` override (~95 LOC).
   - Mount the chart inside `<MedicationDetailSection>` so the
     `/medications/[id]/history` page reads on one section recipe.
   - 1 new test pinning the section chrome.

6. `97680663` — `refactor(coach): unify launch glyph and propagate medication row shape`
   - Target Coach button swaps `MessageCircle` → `Sparkles` so every
     Coach launch reads on one glyph vocabulary.
   - Insights/medikamente per-medication card routes through
     `<MedicationCardHeader>` (streak chip on stateBadges slot).
   - 1 new assertion in `target-coach-button.test.tsx`.

7. `29e9f958` — `refactor(charts): finish HealthChartDynamic migration on trends row`
   - `trends-row.tsx` and `vo2-max-chart-row.tsx` switch from
     hand-rolled `dynamic()` blocks to `<HealthChartDynamic>`.
   - The local `ChartSkeleton` shadows drop; the shared
     `<ChartSkeleton>` primitive now owns every chart loading slot.
   - No test changes; existing tests still pass.

8. `d46d0e7e` — `fix(medications): align detail-page spacing ladder`
   - `/medications/[id]/history` page wrapper:
     `space-y-4` → `space-y-6` to match the `/insights/*` stride.

9. `f0e3e055` — `chore(comments): scrub forbidden vocabulary from v1.4.28 code comments`
   - Sweep `medication-detail-section.tsx` (`wave-4b`),
     `DrugLevelChart.tsx` (no remaining hits after commit 5),
     `schlaf/page.tsx` (`AI assessment` × 2, first-person voice),
     `hero-strip.test.tsx` (`AI schema slot`, `Marc` username fixture
     → `Alex`), `SideEffectsSection.tsx` (`Wave-4b`), `glp1-pk.ts`
     (`GLP-1 tile`, `Marc-direct`), plus `phase B` markers in
     `mood-chart.tsx` and `health-score-card.tsx`.
   - 1 in-place test rename (`Marc-Voice translation` →
     `translation`).

## Test totals

- 11 new tests across 5 files.
- Final broad sweep: 67 test files / 546 tests pass across
  `src/components/medications`, `src/components/insights`,
  `src/components/charts`, `src/components/targets`, and
  `src/app/insights`.
- `pnpm typecheck`: clean.
- `pnpm lint`: clean.

## iOS-touch

Zero. All files are web-only chrome (Insights surface, medication
detail UI, charts, targets-page Coach button, hygiene comments). No
`src/app/api/*`, no schema slot, no contract change.

## Out-of-scope items deferred to v1.4.29

- The 9th dead-code stale comment at `src/lib/openapi/routes.ts:757`
  (`weekly report + storyboard annotations` in the route description)
  — backend territory, deferred to the v1.4.29 backlog so R4-A's
  ownership of `src/lib/openapi/*` is respected here.
- The two `/api/dashboard/glp1` example references in
  `src/lib/api-handler.ts:323` and
  `src/lib/__tests__/require-auth-bearer.test.ts:205` — same scope
  boundary, same deferral.
- Mood-chart standalone consumption path (`mood-chart.tsx:529-545`,
  D-M5) — same Card primitive override now applies on both paths
  thanks to commit 3, so D-M5 closes incidentally.
- Health-score progress-bar `motion-reduce` gate (D-L5) — Low
  severity, deferred per the kickoff's "fix High, defer Medium/Low"
  rule.
- Inline desktop Coach pill size mismatch (UI M4) — captured under
  UI-H2 in the research; pill size unification deferred until the
  hero-strip can mount `<CoachLaunchButton>` directly (out of scope
  for this round).

## Six-line summary

- Commits: `fix(a11y)` 44 px tap targets / `fix(a11y)` explainer SR
  wiring / `fix(insights)` mood-tile radius / `fix(responsive)`
  medication-row + side-effects / `refactor(medications)`
  DrugLevelChart onto section / `refactor(coach)` Sparkles glyph +
  insights medikamente row / `refactor(charts)` HealthChartDynamic
  finish / `fix(medications)` detail-page stride / `chore(comments)`
  forbidden-vocab scrub.
- New tests: 11 across 5 files; broader sweep 546/546 pass.
- iOS-touch: zero.
- Blockers: none. Two dead-code stale comments deferred to R4-A's
  ownership in v1.4.29.
