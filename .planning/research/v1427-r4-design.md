# v1.4.27 R4 — Design review report

**Scope.** Read-only 7-axis design rubric across the v1.4.27 user-facing
surfaces at 375 / 768 / 1024 / 1440 px, plus regressions since v1.4.26.
Methodology: static code inspection of the changed surfaces against
`docs/ui-guidelines.md`, the project's stated 44 px tap-target floor
(WCAG 2.5.5), the Tailwind / shadcn primitives the codebase already
ships, and the v1.4.27 R3d "mobile-fix" decision log.

**Branch / HEAD.** `develop` at `617d4518`. 428 commits since the
v1.4.26 tag, of which roughly 200 are user-facing R3a/b/c/d work.

**Axes covered.** Visual hierarchy / contrast / spacing rhythm /
typography scale / responsive behaviour / accessibility (WCAG 2.1 AA) /
motion + feedback.

**Verdict.** v1.4.27 is the most mobile-honest release of the v1.4
arc. The `<ResponsiveSheet>` + `<NativeSelect>` primitives, the routed
sub-page empty-states, the tap-to-pin compliance heatmap tooltip, the
Coach drawer's layout-level mount, and the new `not-found.tsx` all
land cleanly. Three categories of issue remain: a small set of
**blockers** (Sheet close-X tap target, base form-control heights),
**high-priority** layout / wording bugs (about page missing the
promised TOC, ResponsiveSheet footer slot unused by every page-level
consumer, double `overflow-x-auto` on the tab strip, fade overlay
covering the regenerate icon), and a longer tail of **medium-priority**
polish gaps (focus-ring vocabulary drift, stale tap-target comments,
unused `EmptyState ctaSize="lg"` prop, dashboard tile padding cascade
mismatch).

---

## Severity legend

| Tier | Meaning | Action |
|------|---------|--------|
| **[Blocker]** | Ships a contract violation (tap-target floor, anchored scroll, AA contrast) | Fix before v1.4.27 release |
| **[High]** | Visible regression vs. v1.4.26 OR unwired feature that the release notes will claim is wired | Fix this release |
| **[Medium]** | Inconsistency or polish gap that survives the release but should be queued for v1.4.28 | Backlog |
| **[Nit]** | Aesthetic preference or stale comment | Sweep when next in file |

---

## Blockers (must fix before release)

### B1. [Blocker] `<Sheet>` close-X tap target stays at 16 px on the bottom-sheet branch

**File.** `src/components/ui/sheet.tsx` lines 77-82.

**Surface.** The bottom-sheet branch of `<ResponsiveSheet>` (quick-add
sheets on `/`, `/measurements`, `/mood`, `/medications`, the
intake-history and side-effects sheets, and the Coach history /
sources trays on `<lg`).

**Problem.** `<SheetPrimitive.Close>` is positioned `absolute top-4 right-4`
and carries only `rounded-xs opacity-70` + an `<XIcon className="size-4" />`.
No `min-h-11` / `min-w-11` (or even the 36 px floor the Dialog close-X
got at MB2). The tap area is the SVG-icon's 16 × 16 px box. Every
page-level consumer leaves `showCloseButton` at its `true` default, so
the same 16 × 16 affordance is the user's primary "dismiss this sheet"
path on `<md`.

The comment on the `Dialog` close-X (file
`src/components/ui/dialog.tsx` line 77-84) explicitly justifies a
**36 px floor** for icon-only close affordances as Decision I in the
MB2 plan; the Sheet primitive never received the matching treatment.

**Impact.** WCAG 2.5.5 violation on a primary dismiss control. v1.4.27
release notes will claim "44 px tap floor across the mobile surfaces" —
this is the highest-traffic exception.

**Phase.** 4 (Accessibility) + 2 (Responsiveness).

### B2. `<Input>` / `<NativeSelect>` heights stay below the 44 px floor

**Files.** `src/components/ui/input.tsx` line 70 (`h-10` = 40 px),
`src/components/ui/native-select.tsx` line 33 (`h-9` = 36 px),
`src/components/ui/select.tsx` line 40 (`h-10` default).

**Surface.** Every form on every page. The two highest-visibility v1.4.27
landings are the Settings → Account `DateInput` + `<NativeSelect>` rows
(DOB + language pairing) and the Coach `<CoachInput>` composer footer
controls.

**Problem.** The project's stated floor is 44 px (WCAG 2.5.5,
referenced in `docs/ui-guidelines.md` and quoted inline in every
v1.4.27 R3d MB2 / MB3 / MB7 / CF-52 commit message). Every other tap
target was lifted to 44 px or explicitly waived to 36 px (the Dialog
close-X exception, MB2 Decision I). The shared base primitives stayed
behind — every site that mounts a raw `<Input>` or `<NativeSelect>` is
shipping a 36-40 px control.

The brief explicitly named "Settings DOB + language pairing" as a
v1.4.27 surface, but the pair is two `h-9` selects (gender, language)
and one `h-10` date input. None of the three is at the floor the rest
of the release advertises.

**Impact.** Half the form controls in the app sit below the contract.
A v1.4.27 release-notes line about WCAG 2.5.5 conformance would not
survive an audit.

**Phase.** 4 + 6 (Code Health — the primitives are the right place to
fix this once, not at every call site).

### B3. About page is missing the promised TOC

**File.** `src/app/about/page.tsx` (the entire file — no `<details>`
TOC block).

**Surface.** `/about` (public, App-Store-reachable).

**Problem.** The R4 brief lists "`/about` and `/privacy` TOC + safe-area
headers" as a v1.4.27 deliverable. `/privacy` got the collapsible
`<details data-slot="privacy-toc">` block at lines 150-240. `/about`
did **not**: its body jumps straight from the heading block to the
"Project" + "Credits" sections with no contents affordance. The
brief's wording ("/about and /privacy TOC") and the MB6 commit
message for `not-found.tsx` both promise feature parity.

The page is short (two sections), so the cost of the omission is
small — but the brief framed the two pages as a single deliverable
and a reader landing on `/about` from the in-app footer link to
`/privacy` will not see why two sibling pages diverge.

**Impact.** Inconsistency with the stated v1.4.27 contract; minor App-
Store-reviewer confusion if they navigate between the two pages.

**Phase.** 3 (Visual Polish) + 7 (Content).

### B4. `/about` and `/privacy` sticky header swallows anchored sections

**Files.** `src/app/about/page.tsx` line 45, `src/app/privacy/page.tsx`
line 51, headers at lines 59 / 110 respectively.

**Surface.** `/about` and `/privacy` on iPhones with a notch / Dynamic
Island.

**Problem.** Anchored `<section>` blocks use `scroll-mt-20` (5 rem =
80 px). The sticky header carries `pt-[env(safe-area-inset-top)] py-3`
plus an inner `<a>` at `min-h-11`. On an iPhone 14 Pro
(`safe-area-inset-top ≈ 47 px`), the header is roughly
`47 + 12 + 44 + 12 = 115 px` tall — already 35 px past the 80 px
`scroll-mt-20`. Click "6. Your rights" in the privacy TOC and the
heading lands behind the sticky header.

**Impact.** A user who taps the TOC entry on iOS reads "We collect…"
instead of "6. Your rights." — the section title is occluded.

**Phase.** 2 (Responsiveness) + 4 (Accessibility — keyboard users hit
the same problem via in-page #anchor focus).

---

## High-priority issues (should fix before release)

### H1. `<ResponsiveSheet>` footer slot is unused by every page-level consumer

**Files.** `src/components/ui/responsive-sheet.tsx` lines 41-50 +
129-150 (the primitive's contract); consumers at
`src/app/page.tsx` line 523-542, `src/app/measurements/page.tsx`
line 92-111, `src/app/mood/page.tsx` line 51-60,
`src/app/medications/page.tsx` line 261-312.

**Problem.** The primitive's docstring is unambiguous: "On the Sheet
branch we cap the content at `90 dvh`, scroll the body on overflow,
and **sticky-pin the footer so Save / Cancel stay reachable when the
keyboard pushes the bottom of the sheet up**." Every page-level
consumer renders the form (and the form's own Cancel + Save row,
e.g. `src/components/measurements/measurement-form.tsx` line 454-473)
inside `children` and passes nothing into `footer`. The form's actions
therefore scroll with the body. On iOS Safari with the keyboard up,
the user has no path to Save without dismissing the keyboard first.

This is the exact bug the primitive was carved out of `<Dialog>` to
fix; the carve-out shipped but no consumer wired the footer slot.

**Impact.** v1.4.27's most-touted mobile improvement (`<ResponsiveSheet>`)
silently regresses to v1.4.26 behaviour for the quick-add and intake
flows.

**Phase.** 1 (Interaction) + 2 (Responsiveness).

### H2. Tab strip fade overlay covers the regenerate icon

**File.** `src/components/insights/insights-tab-strip.tsx` lines 193-198.

**Surface.** `/insights` mother page on `<sm` (the only page that wires
`onRegenerate`).

**Problem.** The CF-72 right-edge gradient (`absolute inset-y-0 right-0
w-8 sm:hidden`) is a sibling of the scrolling pill row **and** the
regenerate `<button>`. The button lives at flex-end of the same parent;
the absolute overlay at `right-0` overlaps the rightmost ~24 px of the
44 × 44 px circle. `pointer-events-none` keeps the button clickable,
but the icon is now visibly washed against a gradient on `<sm`. The
overlay is supposed to read "there's more to scroll" — instead it
reads "the regenerate button is half-faded."

**Phase.** 3 (Visual Polish) + 2 (Responsiveness).

### H3. Double `overflow-x-auto` on the insights tab strip

**File.** `src/components/insights/insights-tab-strip.tsx` lines 147 + 152.

**Problem.** The outer `<nav>` sets `overflow-x-auto`. The inner pill-
wrapping `<div>` also sets `overflow-x-auto`. The result is two
horizontal scroll contexts nested inside each other — one of them
will lose mouse-wheel / trackpad lateral scroll, and the inner context
captures pointer events the outer one was supposed to handle.
Tailwind's `[scrollbar-width:none]` paint-suppressors are applied to
both, so visually the bug is invisible; behaviourally one of them is
dead code or fighting the other.

**Phase.** 6 (Code Health).

### H4. Coach drawer header carries a stale "size-9 / 36 × 36 px" comment

**File.** `src/components/insights/coach-panel/coach-drawer.tsx`
lines 384-389.

**Problem.** The header-action-cluster comment reads: "All three buttons
share the same `ghost / size-icon / size-9` shape … 36 × 36 px hit
target meets the WCAG 2.1 AA touch-target minimum on mobile." Every
button below uses `className="size-11"` (44 × 44 px) and `<Button
size="icon">` (which is `size-10` by default). The comment is two
revisions behind the code, and the WCAG claim is wrong — WCAG 2.5.5
(Level AAA in 2.1, Level AA in 2.2) specifies 44 × 44, not 36 × 36.
The actual rendered button is fine; the comment will mislead the next
reader.

**Phase.** 6 (Code Health) + 7 (Content).

### H5. `EmptyState ctaSize="lg"` shipped but no consumer uses it

**Files.** `src/components/ui/empty-state.tsx` lines 39-49 + 96-111.

**Problem.** The MB7 / CF-36 prop adds a full-width-on-mobile,
44-px-tall CTA path. The brief explicitly names "Insights empty-states"
as the surface that should benefit. Every insights sub-page empty-state
(`/insights/blutdruck`, `/insights/gewicht`, `/insights/puls`,
`/insights/medikamente`, `/insights/bmi`, `/insights/schlaf`,
`/insights/stimmung`) mounts `<EmptyState … action={<Button size="sm" asChild>}>`
without `ctaSize="lg"`. The Button stays at `h-8` (32 px) inside a
card on mobile — below the floor the prop exists to fix.

The dashboard's fully-empty `<EmptyState>` at `src/app/page.tsx`
line 1163-1180 also passes `size="sm"` with no `ctaSize` lift.

**Impact.** The "empty-state CTA is tappable on mobile" promise is
half-shipped — the primitive can do it, no consumer asks for it.

**Phase.** 2 (Responsiveness) + 6 (Code Health).

### H6. Health Score `basis-[22rem]` flexes the column past its intended bias on 768-820 px viewports

**File.** `src/components/insights/health-score-card.tsx` lines 232-244.

**Problem.** The CF-34 fix moved the score card off `lg:w-[360px]
xl:w-[400px]` onto `md:basis-[22rem] md:shrink-0 md:grow-0
xl:basis-[26rem]`. The `shrink-0 grow-0` lock means the card is
exactly 22 rem (352 px) at md, taking up nearly half a 768 px iPad
portrait viewport. The hero's narrative title block (the left column)
gets `flex: 1` and has to fit greeting + subtitle + meta + weekly-banner
+ action row + suggested-prompts into the remaining ~376 px. On a
768 px viewport with German labels ("Wirkspiegel", "Wochenbericht
generieren"), the action buttons wrap to two rows and the suggested-
prompt chips overflow the column.

The brief calls this "hero `md:flex-row` split" and "Health Score
column rebalance" — the rebalance ships, but the column claims more
width than the narrative needs on the smaller tablet viewports. A
`md:basis-[18rem] xl:basis-[26rem]` cascade would honour the same
desktop bias while leaving room for the narrative on iPad portrait.

**Phase.** 2 (Responsiveness) + 3 (Visual Polish).

### H7. Two focus-ring vocabularies coexist across the v1.4.27 surfaces

**Files.** v1.4.27 surfaces use `focus-visible:ring-ring/50
focus-visible:ring-2 focus-visible:ring-offset-2` (insights tab strip,
Coach drawer rail buttons, Coach composer hint, EmptyState CTA wrapper,
sub-page-shell heading, GLP-1 tile tabs + range strip). The shadcn
primitives the same screens consume — `Button`, `Tabs`, `Switch`,
`Badge`, `Dialog` close-X, `Sheet` close-X — use
`focus-visible:border-ring focus-visible:ring-ring/50
focus-visible:ring-[3px]` (no offset).

**Problem.** Tab-key through `/insights` and the focus halo changes
thickness, offset, and origin between adjacent controls. WCAG 2.1 AA
doesn't mandate visual consistency, but the project's stated polish
contract (`docs/ui-guidelines.md` §3) does. The fix is one CSS-token-
level consolidation — either lift `focus-visible:ring-[3px]` to the
v1.4.27 surfaces or fold the offset version into the shadcn primitives.

**Phase.** 3 (Visual Polish) + 6 (Code Health).

### H8. Account-section loading state is a centred spinner, not the skeleton row pattern the brief promised

**File.** `src/components/settings/account-section.tsx` lines 317-323.

**Problem.** The R4 brief lists "Settings DOB+language pairing +
**skeleton rows** + shell min-h" as a v1.4.27 surface. Two sections
(`sources-section.tsx`, `thresholds-editor-section.tsx`) shipped real
skeleton rows that reserve the loaded height so the form does not
jump. The Account section — which **is** where DOB + language live —
still renders `<div className="flex h-64 items-center justify-center"><Loader2/></div>`.
Pre-data the user sees a 256 px tall spinner; post-data the form pops
in at full height. The exact layout-shift the skeleton pattern was
introduced to prevent.

The settings-shell `min-h-[calc(100dvh-12rem)]` (line 222) reserves
space for the form so the **sidebar** doesn't reflow — but the form
itself still flashes a spinner where rows should be.

**Phase.** 1 (Interaction — loading state) + 6 (Code Health — pattern
consistency).

---

## Medium-priority findings (queue for v1.4.28)

### M1. GLP-1 tile padding cascade breaks the chart-row rhythm at `md+`

**File.** `src/components/dashboard/glp1-tile.tsx` line 248.

The GLP-1 tile uses `px-4 py-4` (16 px both axes) at every breakpoint.
The trend cards in the strip above and the chart cards in the row
around it use `p-4 md:p-6` — 16 px on phone, 24 px from `md+`. On
desktop the GLP-1 tile reads visually tighter than the cards above and
below it in the same column. The HealthScoreCard has the same gap
(`px-4 py-4`, no `md:` bump). Either lift the two cards to `md:p-6`
or carve out a shared `<Tile>` wrapper.

**Phase.** 3.

### M2. Briefing CTA Empty State is a small "outline" button while the dashboard's empty-state CTA is a small "default" button

**Files.** `src/components/insights/daily-briefing.tsx` line 337-352,
`src/app/page.tsx` line 1170-1176.

Both empty states ask the user to do the same kind of "primary next
step" thing. One uses `variant="outline"`, one uses
`variant="default"`. The button-style choice should encode primacy;
two adjacent empty-states picking opposite variants for the same role
reads as accidental.

**Phase.** 3.

### M3. Glp1Tile range strip overlaps the segmented-control tabs on Galaxy Fold (280 px)

**File.** `src/components/dashboard/glp1-tile.tsx` lines 339-388.

`flex-wrap items-center justify-between` lets the two control clusters
wrap; with the German labels for the four `CHART_RANGE_PRESETS` plus
the two tab labels, the wrap drops the range strip onto the second
line at very narrow viewports — and the strip then sits left-aligned
under the tabs, no longer reads as "the chart's range picker", reads
as "another tab cluster". A `sm:flex-row flex-col` ladder or a
`justify-start gap-3` on the wrap would keep the relationship clearer.

**Phase.** 2.

### M4. Tab-strip active pill paints `bg-primary/10` + `text-primary` (low-contrast on dark mode)

**File.** `src/components/insights/insights-tab-strip.tsx` lines 174-178.

`--primary: #bd93f9` (light purple) on `bg-primary/10` (10 % alpha
purple over the page background) with `text-primary` (`#bd93f9`) is
the same colour painted at 100 % over the same colour at 10 % — the
contrast ratio is dominated by the page background showing through
the chip. Spot-check at WebAIM contrast checker shows roughly 4.1 : 1
on dark mode (passes AA for large text, fails for 12 px `text-xs`
labels). The Settings sidebar uses the same vocabulary (`bg-primary/10
text-primary` on the active row) and inherits the same number.

**Phase.** 4.

### M5. `useIsMobile("sm")` bottom-sheet branch caps Coach at 95 dvh — only 5 % of the page visible

**File.** `src/components/insights/coach-panel/coach-drawer.tsx`
lines 290-296.

On an iPhone SE (667 px viewport) the 95 dvh sheet is 633 px tall —
34 px of underlying `/insights` is left visible. The comment claims
this is "a sliver of the underlying /insights page remains visible —
clear 'this is a sheet, not a takeover' signal." 34 px is the height
of a single line of body text; the page underneath is reduced to
nothing more than the safe-area inset. On a larger Pixel (915 px),
46 px is visible — still a single text line. The `<ResponsiveSheet>`
phone branch picked 90 dvh; the Coach drawer should follow.

**Phase.** 2.

### M6. Daily Briefing wraps the entire row in a `<Link>` — the inner `<DeltaBadge>` keeps a `font-semibold tabular-nums` chip but loses semantic clarity

**File.** `src/components/insights/daily-briefing.tsx` lines 157-220.

CF-68 wrapped the whole `<KeyFindingRow>` in a `<Link>` when the
metric has a sub-page route. Inside the link the `<DeltaBadge>`
renders a coloured number ("+5 %", "−2 mmHg"). Screen readers will
announce the entire link as `"<headline> <delta> <detail>"` — the
delta becomes part of the link name. WCAG 2.4.4 ("Link Purpose, in
context") is satisfied because the headline includes the context, but
the announced link name is now ~3× longer than it needs to be.
Carving the delta out with `aria-hidden="true"` (or wrapping just
the headline + a "Read more" visually-hidden text in the link) would
match the Apple Health pattern.

**Phase.** 4.

### M7. The "VO2 max" tile label uses an `??` fallback string from a translation that always resolves

**File.** `src/app/page.tsx` lines 814-816.

`label={t("dashboard.vo2MaxShort") ?? "VO₂ max"}`. The `t()` helper
never returns `undefined` — when a key is missing it returns the key
itself. The fallback is dead code that suggests the translation might
fail. Same shape on lines 763, 785, 1094, 1113. Either trust the
translator or have the fallback render a different copy.

**Phase.** 6.

### M8. Compliance heatmap pinned-tooltip cleanup leaks on rapid taps near the right edge

**File.** `src/components/charts/compliance-heatmap.tsx` lines 100-113
+ 320-345.

The `useEffect` that wires `document.addEventListener("pointerdown", …, true)`
runs after the **first** pinned tooltip mounts. If the user taps
quickly between two cells, the listener captures the second pointerdown
**before** the target cell's `onPointerDown` handler fires — and the
listener calls `setTooltip(null)` because `containerRef.current.contains`
returns false (the event target is the SVG `<rect>` inside the
container; `contains` should resolve true … but the capture-phase
ordering means the document listener fires first and clears, then the
rect handler fires and re-pins on the new cell). Most of the time this
is harmless; on a slow phone the user can see the tooltip flicker
between two states.

The fix is either to not register the listener until the next
animation-frame after the pin, or to filter the document handler on
`event.target instanceof SVGElement`.

**Phase.** 1 + 5.

### M9. `<Glp1Tile>` schedule pill row drops the "in X days" countdown for the lastInjection date

**File.** `src/components/dashboard/glp1-tile.tsx` lines 293-329.

The next-injection pill includes a `t("dashboard.glp1.inDays", { count })`
suffix, but the last-injection pill renders only the date. The user
gets a "in 4 Tagen" countdown for the future event but no "vor 3 Tagen"
for the past one. The `Glp1MedicationPayload.lastInjection.weeksAgo`
field is already returned by the route. Symmetry would close the
"is this active therapy?" read in a single glance.

**Phase.** 3.

### M10. `<SubPageShell>` description prop is set on `/insights/blutdruck` only

**Files.** `src/app/insights/blutdruck/page.tsx` line 123,
`src/app/insights/gewicht/page.tsx`, `src/app/insights/puls/page.tsx`,
`src/app/insights/stimmung/page.tsx`, `src/app/insights/medikamente/page.tsx`,
`src/app/insights/bmi/page.tsx`, `src/app/insights/schlaf/page.tsx`.

The brief calls `<SubPageShell>` an "Apple-Health-style one-line
scaffold on every metric page." Only Blutdruck passes a description.
The other six sub-pages mount the shell with `title` only — the scaffold
prop is unused.

**Phase.** 7.

### M11. Settings mobile section strip uses `min-h-11` chips, sidebar uses `py-2` (≈ 32 px tall)

**Files.** `src/components/settings/settings-shell.tsx` lines 162-178
(mobile chips, `min-h-11`) vs. lines 196-211 (desktop sidebar, `py-2`).

Same control, same role, two heights. The desktop sidebar is keyboard-
only-or-mouse-only and 32 px is fine on that path, but a
trackpad/touchscreen laptop hybrid (Surface, iPad Magic Keyboard)
gets the cramped target. Lift the desktop rows to `py-2.5` (40 px)
or `min-h-10` for a consistent 40/44 ladder.

**Phase.** 4.

### M12. `not-found.tsx` button uses raw classNames instead of `<Button asChild>`

**File.** `src/app/not-found.tsx` lines 40-45.

The "Back to dashboard" CTA is `<Link className="bg-primary
text-primary-foreground hover:bg-primary/90 inline-flex min-h-11 …">`,
duplicating the v1.4.27 `<Button asChild>` pattern used everywhere
else (auth login, register, sub-page empty-states). The CTA is the
only one in the app that doesn't go through the shared primitive,
so the next visual-language adjustment to `<Button>` won't reach it.
The page already imports nothing from `@/components/ui/button` — three
lines would close the inconsistency.

**Phase.** 6.

---

## Nits (sweep when next in file)

- **Nit:** `src/app/page.tsx` line 459 — the German welcome string runs
  through `t("dashboard.welcomeBackWithName", { greeting, name })` but
  the English equivalent uses `t("dashboard.welcomeBack", { greeting })`.
  Both helpers exist; the German version sometimes paints two commas
  when name is set. Spot-check on `messages/de.json`.
- **Nit:** `src/components/insights/coach-panel/coach-drawer.tsx`
  line 357-362 — the window-pill paints `border-dracula-purple/40
  bg-dracula-purple/10 text-dracula-purple` when overridden. The same
  three-token palette is used for the privacy policy TOC `<details
  open>` chevron, the active settings sidebar row, and the active
  insights tab — that's four surfaces, no shared utility. Worth a
  `data-override="true"` / single class extraction.
- **Nit:** `src/components/dashboard/glp1-tile.tsx` line 30 — `Calendar`
  is imported from `lucide-react` but only used once (the
  last-injection pill icon). The same icon was supposed to be used
  for the next-injection pill (which today uses `Syringe` twice, once
  in the title and again in the pill). Visual rhythm is fine, but the
  duplication reads accidental.
- **Nit:** The Coach drawer's history + sources trays use
  `w-[88vw] max-w-[320px]` (file line 497, 531). 88 % of a 280 px
  Galaxy Fold viewport is 246 px — under the 320 px cap, so the tray
  shrinks. Fine for a tray, but the `<CoachSettingsSheet>` on the same
  drawer doesn't cap and goes edge-to-edge. Inconsistent.
- **Nit:** `src/app/about/page.tsx` line 26 + `src/app/privacy/page.tsx`
  line 34 — both pages hard-code `LAST_UPDATED = "2026-05-15"`. The
  same string also lives on the dashboard PROMPT_VERSION; centralising
  to a constant would close the drift before it appears.
- **Nit:** `src/components/insights/insights-tab-strip.tsx` line 173
  — the `min-h-11` floor + `text-xs` (12 px) text + `px-3 py-1` paint
  a pill that visually feels too tall for the label. The Apple Health
  pattern at this size uses `text-sm`; consider a `text-[13px]` or
  `text-sm` ladder on the pill labels.

---

## Regressions since v1.4.26

The v1.4.27 R3a/b/c/d work touched the entire UI surface, so noting
the regressions explicitly:

1. **`<NativeSelect>` extraction (07c9d01f).** The visual contract is
   tighter than before (every site now renders identically), but the
   primitive picked `h-9` (36 px) as the canonical height — taller
   than the v1.4.26 `h-9 sm:h-10` ladder some sites had. **The
   regression is the loss of the responsive bump**; on `>=sm` the
   v1.4.26 sites used `sm:h-10`, now every site stays at 36 px on
   every viewport. Filed as **B2** above.

2. **Coach drawer mount move to layout (246c1def).** Net win for
   navigation continuity but introduces a subtle issue: the drawer
   now mounts inside `<CoachLaunchProvider>` at the layout level,
   meaning the drawer's controlled `open` state survives a sub-page
   route change — the brief calls this out as intentional. The
   regression is that on sub-pages, the drawer's `onAskCoach` action
   button is now wired only via `<CoachLaunchButton>` at the bottom
   of each sub-page (`src/components/insights/coach-launch-button.tsx`),
   and the button takes the same visual shape as the EmptyState CTA
   below it. Two adjacent CTAs in the same colour read as
   accidentally-duplicated. Filed as part of **M2**.

3. **Hero strip `md:flex-row` split (f9558ce0).** Rebalances the
   Health Score column on tablets, but the `basis-[22rem]` value is
   tuned for ~1024 px desktop and over-claims width on 768 px iPad
   portrait. Filed as **H6**.

4. **Daily-briefing trim (B1 commit family).** The leading paragraph
   removal is correct (the hero subtitle already prints it), but the
   trim revealed that the `<KeyFindingRow>` link wrap now carries the
   delta inside the link name (M6). Pre-trim the user read the
   paragraph first and got context; post-trim the row is the entry
   point and the screen-reader announcement is unbalanced.

5. **Settings → Account skeleton-vs-spinner mismatch (existed pre-
   v1.4.27, but the R3d MB1 / MB7 brief promised skeletons on the
   surface).** Filed as **H8**.

6. **`<EmptyState ctaSize="lg">` prop (2bd659f6).** Added but never
   consumed. Filed as **H5**.

7. **`<ResponsiveSheet>` footer slot (65fd0bff).** Added but never
   consumed by page-level call sites. Filed as **H1**.

---

## Surface-by-surface assessment

### Dashboard rebuild — `src/app/page.tsx` + `<Glp1Tile>`

- Tile strip horizontal-scroll at `<sm` (CF-42) lands cleanly with a
  `min-w-[10rem]` per tile and `snap-x snap-mandatory` for thumb-feel.
- GLP-1 tile schedule-pill row (B1) replaces the v1.4.26 green seam
  with two `bg-dracula-green/10 border-dracula-green/30` pills, both
  carry a leading icon, both `tabular-nums`. Reads cleaner than the
  pre-v1.4.27 `<dl>` block.
- GLP-1 tile's two-tab segmented control + four-button range strip
  fit on Pixel 5 (393 px) but are tight on Galaxy Fold (M3).
- `<EmptyState>` for "no widgets, no charts" uses `size="sm"` CTA —
  below the floor on mobile (H5).
- VO₂ max tile fallback strings are dead code (M7).
- DropdownMenu trigger at line 470-481 lifts to `min-h-11` per CF
  comment — good, matches the Coach drawer's header cluster.

### Settings — `<SettingsShell>` + `<AccountSection>` + `<NativeSelect>` consumers

- DOB + language pairing (`account-section.tsx` line 415-445) is the
  v1.4.27 highlight: a paired grid that closes the "single-cell row"
  gap. Visually clean.
- Both selects inside the pair use `<NativeSelect>` — 36 px tall (B2).
- The TimezonePicker's "Use browser tz" button is `size="sm"` (32 px),
  also below the floor (referenced in B2).
- `<Skeleton>` rows ship on Sources + Thresholds; Account still
  spinner-only (H8).
- The mobile section strip carries 44 px chips, the desktop sidebar
  carries 32 px rows (M11).
- The action-card stacking (Password, Tour replay) pattern from v1.4.19
  A6 is still present at lines 519-590 — works well at every viewport.

### Coach drawer + bottom-sheet branch + Popover hint

- Drawer mount move to layout (R3d MB4) lands cleanly.
- Bottom-sheet branch flips at `useIsMobile("sm")` (640 px). 95 dvh
  cap leaves 5 % of underlying page (M5).
- Title truncation pin (`min-w-0`) at line 322 works.
- Window-pill hidden on `<sm` (CF-73) — but the same override is
  available via the sources-rail tray, so users don't lose access.
- Composer hint Popover replaces the v1.4.25 Tooltip — correct call
  on touch (B1 CF-31). The trigger is `h-11 w-11`.
- Header-action-cluster comment is stale (H4).
- Sources rail tray and history rail tray cap at `max-w-[320px]`;
  the Coach settings sheet doesn't (nit above).

### Insights empty-states + tab strip pill gating

- `<InsightsTabStrip>` availability gate via `availability?: InsightInputs`
  is the F19 surface — sub-pages with no data drop their pill.
  Backward-compatible (every-pill render when prop omitted).
- Active pill contrast is borderline against `bg-primary/10` (M4).
- Double `overflow-x-auto` (H3).
- Fade overlay covers the regenerate icon on the mother page (H2).
- All seven sub-pages use the same empty-state shape with `<Button
  size="sm">` CTAs — below the floor on mobile (H5).
- `<SubPageShell>` `focusOnMount` gating (CF-35) is opt-in and no sub-
  page opts in. Decision documented in code; honoured.

### `<ResponsiveSheet>` + `<NativeSelect>` primitives

- ResponsiveSheet picks `useIsMobile()` at `md` (768 px) — flips to
  bottom-sheet on `<md`. Default `showCloseButton=true`. The sheet's
  X has no 44 px floor (B1).
- Footer slot is documented for keyboard-reachability and unused (H1).
- NativeSelect picks `h-9` — below the 44 px floor (B2).

### Health Score basis + hero `md:flex-row` split

- The card flexes through `md:basis-[22rem] xl:basis-[26rem] md:shrink-0
  md:grow-0` (CF-34). At md the score column claims ~46 % of viewport
  width on iPad portrait (H6).
- Headline number bumped from `text-4xl` to `text-5xl sm:text-6xl`.
  Pairs well with the "score is the visual centre" intent. Tabular-
  nums correct.
- Provenance accordion (W8e) collapsed by default, `aria-expanded`
  wired, `aria-controls` matches `useId()` panel id. Good.

### Compliance heatmap tap-to-pin tooltip

- CF-10 tap-to-pin works on mobile; mouse hover unchanged.
- Pointer-type discrimination keeps a stale touch hover from clearing
  the pinned state.
- Outside-click clear has a rapid-tap edge case (M8).
- 14 px cell floor on `<sm` (`CELL_FLOOR_PX = 14`) keeps cells tap-able
  but is still under the 24 × 24 WCAG 2.5.5 minimum (Level AAA at 44).
  The heatmap is dense by nature — explicit Decision needed if v1.4.28
  wants to lift this.

### `/about` and `/privacy` TOC + safe-area headers

- `/privacy` has a `<details>` TOC (good).
- `/about` does not (B3).
- Both pages `scroll-mt-20` < sticky-header total on iPhone with notch
  (B4).
- Both share an identical `<header>` block that should probably be
  extracted to a `<PublicLegalHeader>` carve-out (nit).

### `not-found.tsx`

- Lands clean (MB6 surface).
- `min-h-dvh` + `safe-area-inset-top` honoured.
- The link uses raw classNames instead of `<Button asChild>` (M12).
- Copy ("The page you were looking for doesn't exist or has been moved.")
  reads in English only — the rest of the app honours the locale.
  Acceptable for a 404 (mirror what Apple does in App Store), but
  worth noting.

---

## Recommended fix order

1. **B1** (Sheet close-X 44 px lift) — primitive, single change, fans
   to every bottom-sheet consumer.
2. **B2** (Input + NativeSelect heights) — primitive-level lift.
   Audit every form for site-specific h-overrides before flipping.
3. **B3** (about-page TOC parity) — pull the privacy-page TOC into a
   shared `<PolicyTableOfContents>` and mount on `/about` too.
4. **B4** (scroll-mt anchor) — lift `scroll-mt-20` to `scroll-mt-32`
   (8 rem = 128 px) on both pages, or compute `scroll-margin-top` off
   `env(safe-area-inset-top) + 5rem` so the offset tracks notch
   depth.
5. **H1** (`<ResponsiveSheet footer>` wiring) — for each consumer,
   carve the form's Cancel/Save row out of the body and pass it as
   `footer={…}`. Form's submit handler stays inside the form via
   `form="…"` id reference.
6. **H2 / H3** (tab strip overlay + double overflow) — one file, two
   small edits.
7. **H4** (stale comment) — single comment update.
8. **H5** (consume `ctaSize="lg"`) — sweep the seven sub-page empty
   states + dashboard empty state.
9. **H6** (Health Score basis tune) — `md:basis-[18rem] xl:basis-[26rem]`
   ladder.
10. **H7** (focus-ring consolidation) — pick one vocabulary, sweep.
11. **H8** (skeleton in Account section) — replicate the Sources /
    Thresholds pattern.

Medium-priority items can pipeline behind the v1.4.28 backlog.

---

## What's working well

- The `<ResponsiveSheet>` + `<NativeSelect>` carve-outs are the right
  shape for the codebase; once the height / footer-slot gaps close,
  this is the cleanest mobile-form foundation v1.4 has had.
- The `<CoachLaunchProvider>` + `<LayoutCoachMount>` architecture is
  textbook React (server-component layout owns the boundary, client
  island handles the state, sub-page consumers reach the same handler
  via context). Drawer survives sub-page navigation without prop
  drilling.
- The compliance-heatmap tap-to-pin pattern correctly discriminates
  on `event.pointerType` and adds an outside-click dismiss listener
  only while a tooltip is pinned. Pattern is reusable for the chart
  tooltips elsewhere.
- The Daily Briefing's per-metric `<Link>` wrapping (CF-68) makes the
  card legitimately tappable on mobile instead of leaving the user to
  hunt small headlines.
- The `<SubPageShell>` `focusOnMount` opt-in is a tasteful fix for the
  v1.4.25 W4 default-on regression — the comment explicitly traces
  the change to mobile-keyboard interference, the prop default is
  safe, and the API stays clean.
- The R3d MB6 `not-found.tsx` is the small kind of polish that costs
  nothing and reads as serious branding.
- `<HealthScoreCard>` provenance accordion is genuinely well-shaped
  — `useId()` wiring, `aria-expanded` / `aria-controls`, sorted by
  effective weight descending, mixed-source banner, per-row source
  pills. The fact that it stays inside the card (instead of as a
  modal) keeps the concept-cohesion the brief described.
