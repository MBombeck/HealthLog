# Phase Fix-N — v1.4.25 reconcile (final bucket)

**Branch**: `develop`
**Date**: 2026-05-14
**Status**: COMPLETE — reconcile pass CLOSED.

## Scope

Fix-N is the largest bucket of the W21 reconcile pass: shared helper
modules, the medication-detail section wrapper, drift-guard tightening
on the side-effect taxonomy, and route-ownership hoisting across nine
medication sub-routes. All items applied; no scope deferred.

Items landed (per `.planning/phase-W21-reconcile-plan.md`):

- simp-H1 — onboarding `readError` helper hoisted (one source, four callers).
- simp-H2 — dropped the `templateFill` helper in TitrationSection; the
  i18n `t()` already accepts the params bag.
- simp-H3 — extracted `researchModeStatusLabel` helper out of the
  Settings advanced-section's nested ternary.
- simp-H4 — shared `ResearchModeStatus` DTO + tri-state gate classifier
  consumed by DrugLevelChart and the Settings re-prompt banner.
- simp-H5 — added `findDrugIdByBrand` to the GLP-1 knowledge layer.
- simp-H6 — hoisted `assertMedicationOwnership` to a shared route-guard
  module; rolled out across 9 medication sub-routes.
- simp-H7 — replaced the local `InventoryState` union with the canonical
  Prisma `MedicationInventoryState` enum.
- simp-M1 + code-M1 — derived `SIDE_EFFECT_CATEGORY_VALUES` /
  `SIDE_EFFECT_ENTRY_VALUES` via `z.nativeEnum`; drift-guard test asserts
  Prisma enum, taxonomy map, and validator triangle stay aligned.
- simp-M3 — extracted `<MedicationDetailSection>` wrapper across the
  three Wave-4b sections (Titration, Scheduling, SideEffects). The
  inventory disclosure stays on `<details>` (see Deviations).
- simp-M4 — collapsed the two near-identical dose-string parsers
  (`parseDoseMg` in DrugLevelChart, `parseDoseString` in the titration
  route) into a single module at `src/lib/medications/dose-string.ts`.
  The `parseDose` helper in `medication-form.tsx` was left alone — its
  contract is form-splitting (returns `{ amount, unit }`), not mg
  extraction.
- simp-M5 — widened `daysRemainingInUse` in the inventory state-machine
  to accept either the full `InventoryItemView` or a thin
  `{ firstUseAt }` shape; the inventory-section client now calls the
  pure helper instead of re-implementing it.
- simp-M8 — the three W19 routes (glp1, inventory, side-effects) now
  use `apiError("Too many requests", 429, { headers: rateLimitHeaders(rl) })`
  instead of the 4-line `for` loop. `apiError` was extended to accept
  a `headers` key in its third-argument option bag.
- design-M1 — swapped the gender native `<select>` in BaselineForm and
  the category native `<select>` in SideEffectsSection for the
  shadcn-radix `<Select>` component.
- design-M3 — cadence-timeline cells in SchedulingSection now wrap a
  44×44 px tap-target button around the 12 px visible square; WCAG 2.5.5
  compliant.
- code-M6 — dropped the `category` field from `createSideEffectSchema`;
  the route derives the canonical category via `categoryForEntry(entry)`.

## Commits (6, in order)

1. `c8ee4cb` — `feat(medications): shared helpers — readError + route-guards + dose-string + research-mode-types`
2. `d6456a3` — `refactor(medications): extract MedicationDetailSection wrapper across 4 components`
3. `2b71242` — `refactor(ui): adopt shared readError + ResearchModeStatus + design-system Select`
4. `8399c47` — `refactor(api): adopt assertMedicationOwnership + rate-limit option-bag across 9 medication routes`
5. `df719ca` — `fix(medications): derive side-effect category server-side + drift-guard test`
6. (this file) — `docs(planning): Fix-N reconcile phase report`

## New modules

- `src/lib/api/read-error.ts` + tests (6 assertions).
- `src/lib/medications/research-mode-types.ts` + tests (7 assertions).
- `src/lib/medications/route-guards.ts` + tests (6 assertions).
- `src/lib/medications/dose-string.ts` + tests (10 assertions).
- `src/components/medications/medication-detail-section.tsx` (composed
  inside existing component tests).
- `src/lib/medications/side-effects/__tests__/drift-guard.test.ts`
  (9 assertions).

Plus 7 additional assertions on `findDrugIdByBrand` in the existing
glp1-knowledge test suite, and 4 additional assertions on the
widened `daysRemainingInUse` overload in the state-machine test suite.

## Test count delta

Final-gate run:
- 344 test files, 3828 passing tests, 1 skipped.

49 new test assertions landed across this bucket
(28 in commit 1, 4 in commit 2, 8 in commit 5, plus 9 in the drift
guard).

## Deviations from the plan

1. **Inventory-section keeps the `<details>` shell** instead of being
   re-chromed through `<MedicationDetailSection>`. The wrapper assumes
   a static section header; the inventory disclosure is a native
   collapsible whose toggle binding sits on `<summary>`. Forcing the
   wrapper would require either layering the wrapper around a
   `<details>` (which buries the heading wiring) or re-implementing
   the disclose pattern as JS state (which loses the URL-fragment and
   no-JS fallback). The plan said "use wrapper top" — the chrome match
   is already present (border + heading + dotted divider), just rendered
   via `<details>/<summary>` rather than the new component. Pragmatic
   choice, documented here so the next reviewer sees the rationale.

2. **`medication-form.tsx` `parseDose` was left alone** under simp-M4.
   The plan named "three near-identical parsers" but the third one in
   `medication-form.tsx` returns `{ amount, unit }` (form-splitting) —
   not a numeric mg extraction. Folding it into the shared module would
   change the contract semantics, which is out of scope for a reconcile
   pass. Two of the three duplicate parsers (DrugLevelChart's and the
   titration route's) are now merged through `parseDoseMg` /
   `parseDoseMgOrNull`.

3. **`apiError` signature extension** — adding `headers` to the
   third-argument option-bag is technically an API broadening, not the
   call-site swap the plan envisaged. The alternative (a parallel
   `apiErrorWithHeaders` helper) would have leaked yet another shape;
   the broadening is additive (existing callers keep their semantics)
   and lets the 429 path stay one-line.

## Gate evidence

- `pnpm typecheck` clean after every commit.
- `pnpm lint` clean after every commit (one inline
  `react-hooks/purity` disable in the inventory section for the
  intentional `useMemo(() => Date.now(), [])` one-shot snapshot).
- `pnpm test --run` final-gate green: 344 files / 3828 passing / 1
  skipped.

## Reconcile pass status

Fix-N closes the W21 reconcile pass. Per the orchestrator dispatch:

- Fix-J — ✅
- Fix-K — ✅
- Fix-L — ✅
- Fix-M — ✅
- Fix-O — ✅
- Fix-P — ✅
- Fix-N — ✅ (this report)

**Reconcile-CLOSED. v1.4.25-RC is clean against the 63 audit findings
that triaged into the seven Fix-* buckets.**
