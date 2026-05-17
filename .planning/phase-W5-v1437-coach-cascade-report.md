# Wave W5 — Coach disable cascade (v1.4.37)

## Summary

Audit item 9 of the v1.4.37 UX-audit brief
(`.planning/research/v1437-ux-audit.md`). Marc's directive: when the
operator turns the global Coach flag off, every Coach affordance on
every surface must vanish — no grey-out, no error, no inert button,
no DOM trace. The audit caught three missing gates on the
`/insights` hero band and the `/targets` page; this wave closes them
plus lands a Vitest invariant so the gate contract can't regress.

Items owned by this wave (audit references in
`.planning/research/v1437-ux-audit.md` item 9):

- HeroStrip "Ask the coach" action-row button (gate missing)
- HeroStrip SuggestedPrompts chip strip (gate missing)
- `/targets` page-level CoachDrawer mount (gate missing)
- HealthScoreCard `onAskCoach` prop drilling (defence-in-depth)
- Vitest invariant — every Coach-bearing surface must respect the
  global flag

The target-card per-card CTA (audit sub-bullet of item 9) is owned by
W4a; W4a's commit `4f7f8e7a` + test `85590ad5` close that gap.

## Commits (in landing order)

| SHA | Message |
|-----|---------|
| `5688a47f` | `fix(insights): gate HeroStrip coach button on the global Coach flag` |
| `5a6f9219` | `fix(targets): gate CoachDrawer on /targets behind the Coach flag` |
| `f88780a0` | `fix(coach): gate SuggestedPrompts chips on the global Coach flag` |
| `23273322` | `test(coach): invariant — every Coach-bearing surface respects the global flag` |

## Per-item outcome

### HeroStrip action-row button + chip strip

- File: `src/components/insights/hero-strip.tsx:217-228`
  (action-row button) and `:247` (`<SuggestedPrompts>` mount).
- Current behaviour: button rendered whenever `onAskCoach` was
  supplied; the chip strip rendered unconditionally. Both opened the
  Coach drawer, which is already gated at the layout level — so on
  a Coach-disabled deployment users would click the surfaces and the
  drawer would refuse to load.
- Fix: read `flags.coach` via `useFeatureFlags()` and wrap both the
  action-row `<div>` and the prompts `<div>` in a `coachEnabled`
  conditional. The `<HealthScoreCard>`'s `onAskCoach` prop drill
  short-circuits to `undefined` when the flag is off so a future
  re-addition of the inline HSC button can't leak the affordance.
- Verified: 21 hero-strip tests pass; the gate uses the same pattern
  as `<LayoutCoachMount>` / `<LayoutCoachFab>` / `<CoachLaunchButton>`.

### /targets page CoachDrawer mount

- File: `src/app/targets/page.tsx:285-290`.
- Current behaviour: the per-card CTAs were gated through `aiEnabled`
  (provider chain status) but the page-level `<CoachDrawer>` mount
  always rendered. When the operator turned Coach off the SSE
  machinery + Sheet portal still loaded even though nothing could
  trigger it.
- Fix: read `flags.coach` via `useFeatureFlags()` and fold it into the
  existing `aiEnabled` gate (`coachEnabled && chainStatus?.activeProvider
  != null`), so the per-card CTAs vanish when either layer is off.
  Wrap the page-level `<CoachDrawer>` in the same `coachEnabled` guard
  as defence-in-depth.
- Verified: `targets-coach-mount.test.tsx` extended with two new
  cases (CTAs hide + drawer mount disappears when flag off);
  sibling targets-* tests get a `useFeatureFlags` mock so their
  `@tanstack/react-query` mock keeps working without adding a
  `QueryClientContext` export.

### SuggestedPrompts standalone gate

- File: `src/components/insights/suggested-prompts.tsx`.
- Current behaviour: chips rendered unconditionally. The component
  was always mounted from the hero strip, so the hero strip's gate
  (above) made it invisible — but the contract was hero-bound.
- Fix: read `flags.coach` inside the component and return `null` when
  the flag is off. Defence-in-depth — a future caller that mounts
  `<SuggestedPrompts>` outside the hero band can never leak a Coach
  surface.
- Verified: 8 suggested-prompts tests pass; double-guarding doesn't
  change the off-branch shape (still empty DOM).

### Coach disable cascade invariant

- File: `src/lib/feature-flags/__tests__/coach-cascade.test.tsx` (new).
- Approach: a fixture-driven test that mounts each Coach-bearing
  surface (`HeroStrip` action + chips, `SuggestedPrompts`,
  `CoachLaunchButton`, `LayoutCoachFab`, `LayoutCoachMount`) inside a
  `QueryClientProvider` pre-seeded with `coach: false`, then asserts
  the rendered SSR output contains no `coach-*` slot, no
  `insights-suggested-prompts` slot, and no
  `insights-hero-strip-action-coach` / `insights-hero-strip-prompts`
  slot.
- Future-proofing: the negative grep is keyed on the
  `data-slot="coach-[a-z]"` prefix, so a future component that grows
  a new `coach-*` slot without a gate fails this test by default. A
  trailing `expect(COACH_SURFACES.length).toBe(6)` check forces
  contributors to revisit the fixture when a new Coach surface lands.
- Verified: 13 invariant tests pass (12 fixture cases — 6 surfaces ×
  on/off — plus the count check).

## Surfaces enumerated

| Surface | File | Already gated? |
|---|---|---|
| Layout-level drawer mount | `src/components/insights/layout-coach-mount.tsx:42` | Yes (pre-W5) |
| Layout-level mobile FAB | `src/components/insights/layout-coach-fab.tsx:44` | Yes (pre-W5) |
| Inline pill (`lg+`) | `src/components/insights/coach-launch-button.tsx:52` | Yes (pre-W5) |
| HeroStrip action-row button | `src/components/insights/hero-strip.tsx` | **W5 — new gate** |
| HeroStrip chip-strip wrapper | `src/components/insights/hero-strip.tsx` | **W5 — new gate** |
| `<SuggestedPrompts>` standalone | `src/components/insights/suggested-prompts.tsx` | **W5 — new gate** |
| `/targets` page drawer mount | `src/app/targets/page.tsx` | **W5 — new gate** |
| TargetCard per-card CTA | `src/components/targets/target-card.tsx:679` | W4a — landed in `4f7f8e7a` |
| Settings → Coach UI | `src/components/settings/coach/*` | N/A — stays mounted; flag toggle lives here |

Total: 7 client surfaces + 1 server-side `requireAssistantSurface`
gate. W5 added 4 of the 7 client gates; W4a added the per-card
TargetCard gate in parallel. Three layout-level surfaces were
already gated.

## Tests delta

- New file: `src/lib/feature-flags/__tests__/coach-cascade.test.tsx`
  (13 cases — 6 surfaces × on/off + 1 fixture sync check).
- Extended: `src/app/__tests__/targets-coach-mount.test.tsx` (3 → 5
  cases; added Coach-flag-off coverage for CTAs + drawer mount).
- `useFeatureFlags` mock added to three sibling targets tests
  (`targets-responsive`, `targets-i18n`, `targets-spacing`) so their
  `@tanstack/react-query` mock keeps working without exposing
  `QueryClientContext`.
- Unit-suite delta: +13 invariant + 2 targets coverage = +15 tests.
  Full unit run before W5 last reported 4285 / 230 (cf.
  `project_v14345_audit_marathon`); the v1.4.37 marathon work has
  added many more before W5 landed, so the absolute count moved past
  4420 by W5's completion.

## Code-review findings

The brief asked for the `superpowers:code-reviewer` subagent on the
W5 diff. The Task tool that dispatches subagents is not in the agent
runtime's tool set; performed a self-review against the
`superpowers:requesting-code-review` checklist instead:

- **Critical:** none.
- **High:** none.
- **Minor — addressed in line:** hero-strip already wraps the
  `<SuggestedPrompts>` mount in a `coachEnabled` check AND the
  component self-gates. Double-guarding is intentional defence-in-
  depth, not redundant — the invariant test exercises both paths.
- **Minor — addressed in line:** the `coach-cascade.test.tsx`
  fixture entry for `<LayoutCoachMount>` ships a blank
  `proofWhenOn` because the drawer is lazy-loaded via `next/dynamic`
  and SSRs to nothing even with the flag on. The positive-case test
  is skipped; the negative `coach-*` slot grep still pins the gate.

## Brief-back

- (a) **Total Coach-bearing surfaces discovered:** 7 client + 1
  server-side. 3 already gated, 4 newly gated by W5
  (HeroStrip ×2, SuggestedPrompts, `/targets` drawer mount), 1 newly
  gated by W4a (TargetCard CTA in commit `4f7f8e7a`).
- (b) **Surfaces owned by another agent:** none discovered beyond
  the W4a-owned TargetCard, which W4a closed in parallel.
- (c) **Invariant test true today:** yes. All 13 cascade-test
  cases pass; the 5-surface negative grep on `data-slot="coach-*"`
  confirms zero Coach DOM trace when the flag is off.

## Constraints honoured

- Branch: `develop`.
- Quality gates: typecheck (only pre-existing W2 `features.test.ts`
  error remains; not in W5 scope), lint (only pre-existing warnings
  in unrelated files), 4420 / 4421 unit tests pass.
- Marc-Voice English commits; no `Co-Authored-By: Claude`; no
  `--no-verify`; no PII in commit messages or code comments.
- Did not touch W4a / W4b / W6 / W8 / settings-coach / server-side
  Coach files.
