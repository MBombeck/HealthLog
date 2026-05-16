# v1.4.33 F2 — onboarding tour click-blocker, real fix

## Scope

Phase-3-prep flagged that the F2 e2e regression spec at
`e2e/onboarding-tour-passthrough.spec.ts` still fails on both
desktop and mobile after the first attempt at the fix
(commit `f9b8f3bd` — `fix(onboarding): stop spotlight tour from
intercepting dashboard clicks`). This report covers the diagnosis,
the real fix, and the hardened regression guard that now ships on
develop.

## Root cause

The audit finding (`.planning/round-v1433-audit-runtime.md` F2) was
that the spotlight tour rendered a single full-viewport `<button>`
with a `clip-path` punching a visual hole around the spotlight.
`clip-path` only affects painting — the button's hit-box still
covered every pixel, so clicks aimed at the underlying page hit the
dim layer and ran `handleSkip` instead of the intended target. The
worst-case symptom: a brand-new user who landed on the dashboard
with `onboarding_tour_completed=false` could not click the header
"Add" dropdown until the tour was dismissed.

The initial fix split the single backdrop into up to four
rectangular dim panels (top / bottom / left / right strips around
the spotlight rect), set `pointer-events: none` on the tour root,
and opted each panel back in with `pointer-events: auto` plus its
own `onClick={handleSkip}`. The intent was: keep the spotlighted
target clickable, keep the rest of the dim dismissable on tap.

The flaw: the dashboard's tour-step 1 spotlights the tile-strip,
which sits in the middle of the page, while the header "Add"
button sits at the top, ABOVE the spotlight. The TOP dim strip
(rendered from y=0 down to where the spotlight begins) therefore
covered the entire header area — so the same click that the
audit named as the regression target was still being eaten, just
by a smaller rectangle. The four-panel split addressed exactly
ONE coordinate (inside the spotlight rect) and broke every other
coordinate outside it that a real user might want to click during
the tour: header buttons, the user-menu avatar, sidebar links,
the locale switcher.

The forensic check is straightforward: at the centre of the
quick-add button, `document.elementsFromPoint` returns the tour's
top dim `<button>` above the actual quick-add button. The dim's
`getComputedStyle(...).pointerEvents` is `"auto"`. The click
follows the topmost interactive element. Result: skip fires, the
dropdown never opens.

## The shipped fix

The real contract — the one Joyride, Shepherd, and Intro.js have
shipped for years — is that the dim layer is purely visual. The
whole tour overlay is `pointer-events: none`; only the tooltip
card opts back into hit-testing. Tour state (Skip / Back / Next)
lives entirely on the tooltip's footer buttons. The page
underneath stays fully usable while the tour is up. Users dismiss
via the explicit "Skip tour" button (or the keyboard's `Esc`,
which was already wired).

Concretely in `src/components/onboarding/tour.tsx`:

- The 4-panel split survives because it still serves the visual
  purpose of NOT dimming the spotlighted target rectangle, but
  each panel is now a `<div aria-hidden="true">` with
  `pointer-events: none`. The `onClick={handleSkip}` and
  `aria-label` came off — the panels carry no interactive
  semantics any more.
- The center-placement fallback (no spotlight target available)
  follows the same shape: a single full-cover dim `<div>` that is
  purely visual.
- The tooltip card keeps `pointer-events: auto` and remains the
  one and only interactive surface in the tour layer; its
  `onClick={(e) => e.stopPropagation()}` came off (nothing to
  stop bubbling to any more — the dim doesn't listen).
- Comments on the file now spell out WHY the dim is purely
  visual, in plain terms, with a reference to the failed
  intermediate attempt so future hands don't reach for the same
  rectangular-cover approach again.

## E2E spec hardening

`e2e/onboarding-tour-passthrough.spec.ts` now carries three test
cases per viewport (chromium-desktop + chromium-mobile = 6 total):

1. **Hinzufügen dropdown opens with the tour mounted on the
   dashboard.** Forensic guard runs `document.elementsFromPoint`
   at the quick-add button's centre, walks the stack, and
   asserts that NO element belonging to the tour overlay has
   computed `pointer-events !== "none"`. The actual click on the
   button then asserts `aria-expanded="true"` and the dropdown
   menu items appear. Pinpoints the regression instead of just
   observing the symptom.
2. **Explicit Skip button in the tooltip dismisses the tour.**
   Replaces the previous "click a dim strip skips the tour" case
   — that contract is gone now (dim is non-interactive). The
   canonical skip surface is the footer button.
3. **Dim panels render as non-interactive visual layers.** Reads
   computed `pointer-events` from every
   `[data-testid="onboarding-tour-dim"]` and asserts each is
   `"none"`. This is the load-bearing invariant that the F2
   regression violated.

## Quality gates

- `pnpm typecheck` — 0 errors
- `pnpm exec eslint src/components/onboarding/tour.tsx src/components/onboarding/__tests__/tour.test.tsx e2e/onboarding-tour-passthrough.spec.ts` — clean
- `pnpm test src/components/onboarding src/lib/onboarding` — 43/43 pass
- `pnpm exec playwright test e2e/onboarding-tour-passthrough.spec.ts` — 6/6 pass (3 × desktop + 3 × mobile)

The pre-existing flakes outside F2 (onboarding-flicker × 2,
mobile-viewport × 1) stay as-is — they sit on other agents'
fileset for v1.4.33.

## Files touched

- `src/components/onboarding/tour.tsx` — dim panels turned into
  non-interactive `<div>`s; root pointer-events comments rewritten;
  tooltip card's `stopPropagation` removed.
- `e2e/onboarding-tour-passthrough.spec.ts` — three-case rewrite
  with `elementsFromPoint` forensic guard.
- `src/components/onboarding/__tests__/tour.test.tsx` — comment
  refresh so the unit test's commentary matches the new contract.
