# W21 Design Findings — v1.4.25 release-candidate

Branch: `develop`. HEAD: `51f23ef3`. Date: 2026-05-14.

Auditor: 1/8 W21 reviewers (focus: mobile-first, design tokens, chart visual
identity, a11y, motion, information density, no top/bottom split). Read-only;
no code edits. Dev server replied on port 3000 but Playwright drive-through
was skipped — the wizard step pages are auth-gated and static analysis already
gives clean evidence on every flagged surface.

## Summary

Counts: 0 critical / 3 high / 5 medium / 3 low.

Onboarding wizard chrome is sound: server-rendered shell, a real
`role="progressbar"`, dot strip with `aria-current="step"`, safe-area-respecting
bottom padding for the iOS PWA shell. The motion contract is honoured at every
new surface — every new transition pairs `motion-reduce:transition-none` and the
welcome carousel switches `scrollIntoView` to `behavior: "auto"` under
`prefers-reduced-motion`. The Tailwind v4 OKLCH migration is clean — zero
`hsl(var(--token))` patterns survive in `src/`, and the v1.4.25 chart pass
replaced the remaining inline refs with bare `var(--token)` (commit
`f4606fb1`). The `aria-controls` / `aria-expanded` wiring on the GLP-1
dose-history disclosure is in place (commit `7b6b766c`).

The release does ship three repeatable a11y regressions that warrant a hotfix
pass before tagging:

1. The onboarding wizard never reaches the 44×44px touch-target floor that
   the rest of the v1.4.25 surface (insights tab-strip, maintainership-banner)
   explicitly honours. Back / Skip / Save buttons all sit at 32–36px.
2. The new `range-bar` component (W3e extraction, used on the redesigned
   `/targets` page) bakes in Tailwind raw palette utilities
   (`bg-red-500/8`, `bg-yellow-500/12`, `bg-green-500/20`) for the zone
   backgrounds, then renders the marker dot from the Dracula token system
   (`var(--dracula-green/orange/red)`). The two palettes do not match and the
   inconsistency is now locked in by a unit test that pins the class names.
3. The personal-record badge uses `text-dracula-green` (`#50fa7b`) on
   `bg-dracula-green/10` — at ~10% opacity over background that lands at
   ≈ 2.6:1 contrast in dark mode, well below the WCAG 2.1 AA 4.5:1 floor for
   the "PR" body text inside it.

Beyond those three the surface reads coherently. Marc's "no top/bottom split"
rule holds on the settings advanced page (research-mode card + danger-zone
stack vertically inside one section). The medication-detail GLP-1 section
stack (drug-level chart → side effects → scheduling → titration → intake
history) is mobile-friendly — every section uses the same `border-border/60
rounded-md border` chrome, every grid degrades to `grid-cols-1` on small
viewports, and only the titration ladder uses a horizontal sm-and-up variant.

## Critical

(none — no broken layout that makes a core feature unusable.)

## High

### H-1. Onboarding wizard buttons are below the 44×44 px touch-target floor

Surfaces: `OnboardingShell` footer, `WelcomeCarousel`, `GoalsChipPicker`,
`SourceCardGrid`, `BaselineForm`.

Every Back / Skip / Save button on the wizard renders at `size="sm"` (32 px
tall) or `size` default (36 px). The carousel's prev/next arrows use
`size="icon-sm"` (32 × 32 px).

- `src/components/onboarding/OnboardingShell.tsx:138, 147, 152` — Back, Skip,
  Next all use `size="sm"`.
- `src/components/onboarding/WelcomeCarousel.tsx:222–268` — arrow buttons use
  `size="icon-sm"`; dot pager pills are `size-2.5` (10 × 10 px hit area).
- `src/components/onboarding/GoalsChipPicker.tsx:255–266` — Back, Skip use
  `size="sm"`, primary Next uses default (36 px).
- `src/components/onboarding/SourceCardGrid.tsx:155–169` — same pattern.
- `src/components/onboarding/BaselineForm.tsx:200–220` — same pattern, plus
  the primary "Save and continue" CTA is the only place a user can finish
  onboarding.

The contract is documented elsewhere in the same release — the W8/W9 work
explicitly tuned the insights tab-strip pills to `min-h-11`
(`src/components/insights/insights-tab-strip.tsx:136`), the maintainership
banner dismiss button to `h-11 w-11`
(`src/components/i18n/maintainership-banner.tsx:118`), and the tour buttons
to `min-h-11` (`src/components/onboarding/tour.tsx:432`). The new wizard
deviates from a rule the rest of the surface already follows.

WCAG 2.5.5 (Target Size, Level AAA) / Apple HIG 44×44 / Material 48×48. The
onboarding flow runs on mobile by definition (first-run iOS PWA install).
Hotfix is a one-line size upgrade per CTA (`size="lg"` is `h-10` 40 px —
still short of 44; consider a `min-h-11` class or a new `size="touch"`
variant) plus a Storybook test that pins the contract.

### H-2. `range-bar` mixes Tailwind raw palette and Dracula tokens

Surface: `src/components/targets/range-bar.tsx`.

The zone backgrounds use raw Tailwind palette:

```text
range-bar.tsx:103  bg-red-500/8
range-bar.tsx:106  bg-yellow-500/12
range-bar.tsx:113  bg-yellow-500/12
range-bar.tsx:121  bg-green-500/20
```

The marker dot at line 86 reads from Dracula tokens
(`var(--dracula-green)` / `var(--dracula-orange)` / `var(--dracula-red)`).
Tailwind's `red-500` is `#ef4444`, Dracula red is `#ff5555` — close in hue but
not the same swatch. Yellow is the loudest mismatch: Tailwind `yellow-500`
(`#eab308`) is olive-warm, Dracula yellow / orange (`#ffb86c`) is peach-warm.

Why this matters here and not on `intake-history-list.tsx` or
`phase-config-dialog.tsx` (which use the same pattern): the range-bar is on
the *redesigned* `/targets` page — a feature shipped as polished in v1.4.25.
The marker dot and the zone its dot sits in should be visually unified.

Worse — the existing test
`src/components/targets/__tests__/range-bar.test.tsx:31–32` now asserts the
raw-palette class names, so the inconsistency is contractually locked. A
hotfix needs to (a) swap the zone backgrounds to the Dracula tokens, (b)
update the test to assert the Dracula token references, and (c) re-validate
against the dashboard's existing green/yellow/red language for clinical
status colouring (already uses `dracula-green/orange/red` in the
`SchedulingSection` cadence visualisation).

### H-3. Personal-record badge contrast on dark mode

Surface: `src/components/insights/personal-record-badge.tsx:113`.

```text
"border-dracula-green/40 bg-dracula-green/10 text-dracula-green …"
```

`text-dracula-green` is `#50fa7b`. `bg-dracula-green/10` over dark mode
`--background` (`#282a36`) yields ≈ `#2a3134`. Contrast: 4.0:1 — fails the
WCAG 2.1 AA 4.5:1 floor for body text (the "PR" string inside is 10 px
uppercase font-semibold tabular — by spec that's still body text for
contrast purposes, not "large text", since 10 px is below the 18 pt / 14 pt
bold threshold).

In light mode the same combination lands ≈ 1.4:1 — even worse — but the
badge is informational and uppercase, and light mode's `--background`
(`#f5f5f5`) renders `text-dracula-green` (`#50fa7b`) on near-white which is
the loudest legibility regression. Hotfix candidates:

- Render the text in `--foreground` and use the green only on the border /
  background ring.
- Bump the background to `bg-dracula-green/20` and the text to a higher
  contrast green token (e.g. a new `--dracula-green-strong` for the badge
  use-case).
- Switch to the `text-success` / `bg-success/15` pattern the rest of the
  insights tiles use (the doctor-report-availability pill, the streak
  pills).

## Medium

### M-1. `BaselineForm` gender field uses a native `<select>`, breaking design-system consistency

Surface: `src/components/onboarding/BaselineForm.tsx:169–179`.

Every other dropdown on the same wizard surface (Settings advanced section,
sources page, etc.) uses the design-system `<Select>` component
(`@/components/ui/select`). The onboarding step-3 gender picker drops to a
native `<select>` with a hand-rolled class string. Native HTML selects on
iOS Safari render a full-screen wheel picker that visually disconnects from
the rest of the form, and the styling won't match the dark-mode chrome of
the adjacent `<Input>` / `<DateInput>` rows.

The same pattern repeats in `src/components/medications/SideEffectsSection.tsx:333–352`
(category picker) — also a native `<select>` inside a Dialog that otherwise
uses design-system components.

### M-2. Dialog content height contract loosely defined for small viewports

Surface: `src/components/medications/ResearchModeAcknowledgmentDialog.tsx:137`.

The dialog uses `max-h-[90vh] overflow-y-auto sm:max-w-xl`. On a 320 × 568
iPhone SE viewport (older but still in the field) 90 vh ≈ 511 px. The
dialog body has five sections plus a version line plus a footer — at the
default font size that's about 720 px of content. Scrolling works (the
overflow-y is wired), but the footer's "Acknowledge" CTA sits below the
fold on first paint and the user has no visual cue that they need to read
through (and scroll) before they can act.

Hotfix: pin the `DialogFooter` outside the scrolling region (it should be a
sibling of the scroll container, not a child) so the primary CTA is always
visible. The current implementation puts `DialogFooter` inside the
`overflow-y-auto` panel.

### M-3. Cadence-visualisation timeline cells are too small for fine-motor interaction

Surface: `src/components/medications/SchedulingSection.tsx:206`.

Each cell is `h-3 w-3` (12 × 12 px). The cells are interactive only via the
native `title` tooltip on hover/focus, so they're not strictly a tap target —
but on touch the user has no way to surface the per-day status. Either the
cells need to grow to a touch-target floor or a tap should toggle a small
day-detail popover. Otherwise the screen-reader contract (the parent has
`role="img"` with an aria-label) renders the per-cell metadata invisible to
touch users entirely.

### M-4. Welcome carousel dot pager fails the 44 px floor

Surface: `src/components/onboarding/WelcomeCarousel.tsx:248–252`.

```text
"size-2.5 rounded-full transition-colors … "
```

Each dot is 10 × 10 px. The active dot's role is `tab`. The carousel can
be advanced with the chevron buttons (also undersized — see H-1) or by
scroll-snap, but the tab-list as built is unreachable for a coarse-pointer
or large-thumb user. Either wrap each dot in a 44 × 44 transparent hit area
or remove the `role="tab"` so the dots collapse to a visual indicator only
and the chevrons become the sole control.

### M-5. Medication detail section stack — header chrome doesn't match dashboard tiles

Surface: `src/app/medications/[id]/history/page.tsx:60–135`.

Each W19c/d/e/f section uses the same internal chrome
(`border-border/60 rounded-md border`, `text-sm font-medium` header at
`px-3 py-2.5`) but the wrapping page uses a different vocabulary — the
top of the page has a `text-2xl font-bold` h1 with no border, no
background. The visual rhythm goes: bold page header → bordered card
(drug-level chart, `bg-card rounded-xl`) → bordered cards with slightly
different chrome (`border-border/60 rounded-md`, no `bg-card`). Three
different card vocabularies on one page.

Worse, the back button uses a hard-coded German string ("Zurück",
line 69 of the page) — this is the i18n auditor's lane primarily, but it
also shows in the visual contract: every other surface on the page is
translated.

## Low

### L-1. The acknowledgment dialog footer has duplicate `gap-2` declaration

Surface: `src/components/medications/ResearchModeAcknowledgmentDialog.tsx:252`.

```text
<DialogFooter className="gap-2 sm:gap-2">
```

Both breakpoints set the same value — the `sm:gap-2` is a no-op. Trivial,
but worth a one-character cleanup since the file is otherwise meticulous.

### L-2. `DrugLevelChart` y-axis label rendered twice

Surface: `src/components/medications/DrugLevelChart.tsx:408–485`.

The y-axis caption ("Estimated level (relative)") is rendered once as a
visible `<p>` above the chart frame (line 408) and a second time as a
Recharts `<YAxis label={…}>` SVG label (line 477). The SVG label is in a
`width={1}` axis (the axis line and ticks are hidden) — so on screen it
overlaps the chart body and reads at an angle of -90 degrees. Either drop
the Recharts label (let the visible caption carry the contract) or set the
YAxis width back to a sensible value and drop the visible caption.

### L-3. Welcome carousel live-region uses a duplicate slide-count translation key

Surface: `src/components/onboarding/WelcomeCarousel.tsx:184–187, 212–217`.

The carousel renders the same `t("onboarding.welcome.slideOf", …)` string
both in the per-slide `aria-label` and in the `aria-live="polite"` region.
Screen readers announce both — the user hears "Slide 2 of 3, slide 2 of 3"
on every navigation. The per-slide `aria-label` should describe the slide
content (slide title), not the slide-of-N counter; the live region is the
right place for the counter.

## Surfaces audited

Onboarding (W14b):
- `src/components/onboarding/OnboardingShell.tsx`
- `src/components/onboarding/WelcomeCarousel.tsx`
- `src/components/onboarding/GoalsChipPicker.tsx`
- `src/components/onboarding/SourceCardGrid.tsx`
- `src/components/onboarding/BaselineForm.tsx`
- `src/components/onboarding/DoneScreen.tsx`
- `src/app/onboarding/[step]/page.tsx`

GLP-1 medication detail (W19c–f):
- `src/components/medications/DrugLevelChart.tsx`
- `src/components/medications/SideEffectsSection.tsx`
- `src/components/medications/SchedulingSection.tsx`
- `src/components/medications/TitrationSection.tsx`
- `src/components/medications/ResearchModeAcknowledgmentDialog.tsx`
- `src/components/medications/glp1-medication-card.tsx`
- `src/components/medications/inventory-section.tsx`
- `src/app/medications/[id]/history/page.tsx`

Settings advanced + sources:
- `src/components/settings/advanced-section.tsx`
- `src/components/settings/sources-section.tsx`
- `src/components/settings/timezone-picker.tsx`

Dashboard + insights additions:
- `src/components/dashboard/glp1-tile.tsx`
- `src/components/insights/insights-tab-strip.tsx`
- `src/components/insights/sub-page-shell.tsx`
- `src/components/insights/personal-record-badge.tsx`
- `src/components/insights/sleep-stage-stacked-bar.tsx`
- `src/components/insights/sleep-duration-chart.tsx`
- `src/components/insights/vo2-max-chart-row.tsx`
- `src/components/insights/therapy-timeline.tsx`

Targets redesign:
- `src/components/targets/range-bar.tsx`
- `src/components/targets/target-card.tsx`
- `src/components/targets/consistency-strip.tsx`
- `src/components/targets/target-edit-sheet.tsx`
- `src/components/targets/targets-summary-header.tsx`

i18n surface:
- `src/components/i18n/maintainership-banner.tsx`

Design tokens:
- `src/app/globals.css` (Dracula CSS-vars, light + dark)
- Repo-wide `hsl(var(...))` grep — zero leftovers, W18 cleanup verified.

## Closing

The release-candidate carries no critical blockers. The three high-severity
findings (H-1 onboarding tap-target floor, H-2 range-bar palette mix, H-3
PR-badge contrast) are all narrowly scoped — each could land as a single
hotfix commit before the tag. M-1 / M-2 / M-3 / M-4 / M-5 are repeatable
polish wins for v1.4.26 if the release window stays tight. The motion
contract, the Tailwind v4 cleanup, the aria-controls wiring on the GLP-1
dose-history disclosure, and the safe-area handling on the onboarding shell
all hold up cleanly.

The clearest design through-line in v1.4.25 is the section-stack vocabulary
on the medication detail page — five vertically stacked, individually
scrollable, single-purpose sections that match Marc's "no top/bottom split"
rule and read coherently on mobile. The clearest design regression is the
onboarding wizard's silent retreat from the 44 px touch-target floor that
the rest of the surface area otherwise honours.
