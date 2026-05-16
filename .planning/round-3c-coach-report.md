# v1.4.28 R3c-Coach — completion report

## Commits

1. `4c6d8779` refactor(coach): consolidate launch button to inline + layout-FAB shape
2. `1b0e81ae` fix(targets): make the coach launch an icon-only affordance
3. `66e13845` refactor(coach): narrow launch-scope metric type to the source union
4. `ca381957` fix(coach): align mobile sheet height to the responsive-sheet convention
5. `235e52cb` *(carve mobile rail tray out of CoachDrawer — see "Misnamed commit" note below)*

## Per-commit notes

### Commit 1 (`4c6d8779`) — Coach launch shape consolidation

- `<CoachLaunchButton>` collapsed to the inline `lg+` pill only — the FAB branch lifted out.
- New `<LayoutCoachFab>` (`src/components/insights/layout-coach-fab.tsx`) mounted once next to `<CoachLaunchProvider>` in `src/app/insights/layout.tsx`. Each sub-page previously mounted `<CoachLaunchButton>` which rendered both shapes, painting 2–3 duplicate FAB nodes in the a11y tree (collapsed visually by `fixed` positioning). The FAB now paints exactly once per Insights surface.
- All 7 sub-page consumers (`/insights/{blutdruck,bmi,gewicht,medikamente,puls,schlaf,stimmung}`) verified — the inline pill they mount continues to work.

### Commit 2 (`1b0e81ae`) — FB-L1: Targets page Coach launch icon-only

- `src/components/targets/target-coach-button.tsx`: dropped the visible `<span>{t("targets.coach.cta")}</span>` label; swapped `<Sparkles>` for `<MessageCircle>` (the chat-bubble glyph the inventory recommended); preserved the affordance via `aria-label` + `title`.
- `src/components/targets/target-card.tsx`: footer row collapsed to a single horizontal row at every breakpoint now that the button is icon-sized — `flex-col items-stretch` + `sm:flex-row` superseded by plain `flex-row items-center justify-between`. Source link's `self-end` rule dropped (only mattered when stacked).
- Test updated to assert the aria-label is present and the visible label is gone.

### Commit 3 (`66e13845`) — BK-MED-2 + BK-F-M4

- `CoachLaunchScope.metric` narrowed from `string | undefined` to `CoachScopeSource | undefined` (the `bp | weight | pulse | mood | compliance | hrv | sleep | resting_hr | steps | active_energy | flights | distance | vo2_max | body_temp` union, imported from `src/lib/ai/coach/types`). No existing call site passes a `scope.metric` value yet (the field is reserved for v1.4.28+), so the narrowing is forward-looking only.
- `setOpen` export: verified consumer count via `grep -rn "launch\.setOpen\|coachLaunch\.setOpen"` — exactly one real consumer (`<LayoutCoachMount>` forwards it to the Sheet's `onOpenChange` contract, which expects a boolean callback). Per the spec's conditional ("drop if only one consumer; keep but note if multiple"), kept with an inline note documenting the audit decision. Removing it would force `<LayoutCoachMount>` to invent a `closeCoach()` helper and reshape the Sheet's controlled-state contract — net loss vs. a one-line type-system note.

### Commit 4 (`ca381957`) — BK-M5

- `src/components/insights/coach-panel/coach-drawer.tsx` mobile branch: `h-[95dvh] max-h-[95dvh]` → `h-[90dvh] max-h-[90dvh]`. Aligns the Coach drawer's bottom-sheet phone branch with the rest of the app's mobile sheets (`<ResponsiveSheet>` phone branch caps at 90 dvh). Inline comment updated to record the 95 → 90 history.
- No tests asserted the 95 dvh value, so no test update needed.

### Commit 5 (`235e52cb`) — BK-F-M6: MobileRailTray carve-out

- New `src/components/insights/coach-panel/mobile-rail-tray.tsx` (~80 LOC) owns the two `<Sheet>` mounts that wrap the history + sources rail trays.
- `CoachDrawer` import added; the two inline `<Sheet>` blocks (~60 LOC each) collapsed onto a single `<MobileRailTray>` mount that takes `historyOpen`/`onHistoryOpenChange`/`historyRail` and `sourcesOpen`/`onSourcesOpenChange`/`sourcesRail`. Pure refactor — every `data-slot` identifier and breakpoint class survives intact, and the existing `coach-drawer-mobile-trays.test.tsx` assertions against `<CoachDrawerBody>` still pass.
- New unit test `src/components/insights/coach-panel/__tests__/mobile-rail-tray.test.tsx` (5 cases) pins the carved-out component's contract in isolation (slot identifiers, breakpoint hides, rail content forwarding, localised titles, closed-state gating). Test mocks `@/components/ui/sheet` down to plain wrappers (same pattern as `coach-settings-sheet.test.tsx`) because Radix's portal doesn't materialise under `renderToStaticMarkup`.

## Inv-5 consolidation result (5 → 3 shapes)

Pre-v1.4.28 inventory (per `.planning/research/v1428-r1-ui-inventory.md` §5):

1. Hero inline `Button` ("Coach fragen")
2. CoachLaunchButton FAB branch (gradient pill, fixed)
3. CoachLaunchButton inline branch (outline pill)
4. TargetCoachButton (ghost pill with text)
5. Suggested-prompt chips (rounded-full + quote icon — *kept distinct: pre-fills a question, conceptually different*)

Post-v1.4.28 (R3c-Coach):

1. **Layout-level FAB** — `<LayoutCoachFab>` mounts once per Insights layout; `lg:hidden`.
2. **Inline desktop ghost button** — `<CoachLaunchButton>` mounts per-page; `hidden lg:inline-flex`.
3. **Per-card icon affordance** — `<TargetCoachButton>` (icon-only chat-bubble + aria-label).

Suggested-prompt chips stay their own visual class as per the inventory recommendation.

## Misnamed commit

Commit `235e52cb` was authored with the wrong subject line because a parallel R3 contributor (running on the same git user under a separate session) ran `git add` while my commit-5 files were staged, then committed under their own subject. The actual content of `235e52cb` is the `MobileRailTray` carve-out described in Commit 5 above (correct files, correct diff). The chart contributor's HealthChartDynamic work landed one commit later as `8f3bfc37`. No destructive recovery (rebase / reset) was attempted because subsequent commits already build on `235e52cb`; per the safety protocol, destructive operations require explicit user direction.

Working-tree contamination from parallel contributors was a recurring problem during this round — initially noticed after commit 2 (which had to be reset and re-staged once to drop swept-in medication + i18n files). Subsequent commits used explicit-path `git add` to keep the index clean, but the parallel `git add -A`-style commits from other workers occasionally absorbed files I had staged.

## Quality gates

- `pnpm typecheck` — clean across all 5 commits (final HEAD).
- `pnpm lint` — clean across all 5 commits (final HEAD). Intermediate lint failures on `src/app/page.tsx` were transient noise from a parallel contributor's working tree; cleared after their commits landed.
- `pnpm test --run src/components/insights/coach-panel/ src/lib/insights/__tests__/coach-launch-context.test.tsx src/components/targets/ src/app/__tests__/insights-polish.test.ts` — 137/137 passed at final HEAD (18 test files).

## iOS contract impact

Zero. Every change is in web-only surfaces (`<CoachLaunchButton>`, `<LayoutCoachFab>`, `<TargetCoachButton>`, `CoachLaunchProvider`, `<CoachDrawer>`, new `<MobileRailTray>`). The SSE `/api/insights/chat` contract is untouched. The `CoachScopeSource` union pulled into `CoachLaunchScope.metric` is the same union the iOS native client already speaks (per `src/lib/ai/coach/types.ts`), so the narrowing is contract-additive at worst.

## Files touched

- `src/app/insights/layout.tsx`
- `src/components/insights/coach-launch-button.tsx`
- `src/components/insights/layout-coach-fab.tsx` (new)
- `src/components/targets/target-coach-button.tsx`
- `src/components/targets/target-card.tsx`
- `src/components/targets/__tests__/target-coach-button.test.tsx`
- `src/lib/insights/coach-launch-context.tsx`
- `src/components/insights/coach-panel/coach-drawer.tsx`
- `src/components/insights/coach-panel/mobile-rail-tray.tsx` (new)
- `src/components/insights/coach-panel/__tests__/mobile-rail-tray.test.tsx` (new)

All inside the R3c-Coach ownership envelope; no R3c-Insights, R3c-Med, R3d, or R3b files touched.
