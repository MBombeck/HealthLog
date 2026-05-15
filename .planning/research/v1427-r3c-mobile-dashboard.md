---
file: .planning/research/v1427-r3c-mobile-dashboard.md
purpose: Mobile capability audit — dashboard and home page
created: 2026-05-15
auditor: MA1
---

# Mobile audit — dashboard and home

## Summary

Reviewed 14 surfaces composing `/` (page composition, 9 tile / chart components, GLP-1 secondary tile, hero strip, daily briefing, health-score card, onboarding checklist, tour launcher, recent-achievements card, and the dashboard-layout settings read path). The trend-card strip, the chart range tabs, and the bottom-nav safe-area are already mobile-first, but the quick-add `<Dialog>` shells, the GLP-1 tab strip, the dashboard-layout reorder controls, and the chart Y-axis offset still ship desktop-first patterns that strand mobile users. 16 findings: 1 Critical, 5 High, 6 Medium, 4 Low.

## Findings

### F1 — Quick-entry forms render in a desktop `<Dialog>` with no mobile sheet, no height cap, and no keyboard hints

- Severity: Critical
- Axis: logic
- File: `src/app/page.tsx:527-554`, `src/components/measurements/measurement-form.tsx` (446 lines), `src/components/mood/mood-form.tsx` (284 lines)
- Symptom: On 320 / 375 / 390 / 414 px viewports the Add → "Log measurement" entry mounts `<DialogContent>` with `max-w-[calc(100%-2rem)]` but **no max-height and no internal scroll**. The 446-line `<MeasurementForm>` overflows the viewport, the iOS soft-keyboard then occludes the submit row, and there is no sticky bottom CTA. Plus every number/date input on the form ships without `inputmode`, `enterkeyhint`, or `autocomplete` (verified via grep — only `type="number"` appears, no inputMode).
- Evidence: `DialogContent` className at `src/components/ui/dialog.tsx:64` has no `max-h-[...]` and no overflow-y; grep for `inputmode|enterkeyhint|autocomplete` against both forms returns zero hits.
- Recommended fix: Branch on a `useIsMobile()` hook to mount `<Sheet side="bottom">` below `md:` (already present in `src/components/ui/sheet.tsx`), add `max-h-[calc(100dvh-2rem)] overflow-y-auto` to `DialogContent`, sticky-pin the Save / Cancel row, and add `inputMode="decimal"` / `enterKeyHint="next"` to every numeric field.
- Effort: M

### F2 — Quick-add trigger sits below the 44 × 44 floor on the home greeting row

- Severity: High
- Axis: visual
- File: `src/app/page.tsx:479-487`
- Symptom: The `<Button size="sm">` carries `min-h-11` (44 px) which is correct, but the **DropdownMenuItem rows themselves** (lines 496-505) inherit shadcn defaults (`py-1.5 text-sm` → effective ~32 px). On a touch device the menu items remain below WCAG 2.5.5 even though the trigger is fine.
- Evidence: `src/components/ui/dropdown-menu.tsx:62` — no min-h on `DropdownMenuItem`; default Radix item is `py-1.5`.
- Recommended fix: Add `data-[mobile=true]:min-h-11` (or unconditional `min-h-11`) to the shared `<DropdownMenuItem>` primitive, or pass `className="min-h-11"` on the two dashboard items.
- Effort: S

### F3 — Dialog close button (the X) is 24 × 24 px

- Severity: High
- Axis: visual
- File: `src/components/ui/dialog.tsx:73`
- Symptom: The shadcn close button is `h-6 w-6` (24 px). Affects both quick-add dialogs that fire on the home page. Below the 44 × 44 floor at every viewport.
- Evidence: Inline className read.
- Recommended fix: Bump to `h-11 w-11` (or `inline-flex items-center justify-center min-h-11 min-w-11`) with the icon staying at `size-4` via the `[&_svg]` selector. Upstream shadcn v3+ uses `size-8` minimum; we are on shadcn 4.7 — diverged.
- Effort: S

### F4 — Health-chart Y-axis hard-coded at 76 px steals 24 % of a 320-px viewport

- Severity: High
- Axis: code
- File: `src/components/charts/health-chart.tsx:447,1178,1239`
- Symptom: Default `yAxisWidth = 76`; the absolute-positioned `<ReferenceArea>` overlay reads `left: \`${8 + yAxisWidth}px\``. On a Galaxy Fold compact (280 px) the plot area is left with 196 px. Tick labels ("80 kg", "120 mmHg") only need ~46 px in practice.
- Evidence: Inline reading; the four range tabs already account for the y-axis width with `min-h-11`, but the chart canvas is starved.
- Recommended fix: Reduce default `yAxisWidth` to `48` (or branch on `viewportWidth < 480 ? 48 : 64`) and switch the overlay positioning from inline-style to Tailwind `inset-y-…` + `start-12 sm:start-16` utilities.
- Effort: S

### F5 — Chart band overlay uses inline pixel styles for layout

- Severity: Medium
- Axis: code
- File: `src/components/charts/health-chart.tsx:1174-1198`
- Symptom: The visible-bands wrapper carries `style={{ left: \`${8 + yAxisWidth}px\`, right: "18px", top: "10px", bottom: "32px" }}`. Inline pixel layout cannot react to the viewport-aware tick density Recharts already adapts to, and `right: 18px` does not honour iOS safe-area-insets on landscape PWAs.
- Evidence: Inline reading; rest of the chart uses Tailwind utilities for positioning.
- Recommended fix: Replace inline style with `absolute inset-x-12 inset-y-3 sm:inset-x-16` (or a CSS variable fed from `yAxisWidth`). Pair with the F4 reduction.
- Effort: S

### F6 — GLP-1 tile range strip buttons are 24 × 24 px

- Severity: High
- Axis: visual
- File: `src/components/dashboard/glp1-tile.tsx:365-386`
- Symptom: The four range pills (7d / 30d / 90d / All) carry `rounded px-1.5 py-0.5` → height ~18 px. They are real radio buttons (`role="radio"` + `onClick`) but at this size a finger tap will hit the neighbouring pill on 375-px viewports. The drug-line / weight-line tab buttons immediately above (`TabButton`) carry `px-2 py-1 text-xs` → height ~28 px — also under-spec.
- Evidence: Inline className read; identical pattern to the chart-range tabs which the rest of the codebase has already bumped to `min-h-11` (see health-chart.tsx:1123, mood-chart.tsx:597, medication-compliance-chart.tsx:333).
- Recommended fix: Add `min-h-11 min-w-11` to both `TabButton` and the range-strip buttons in GLP-1, OR adopt the same `<Button size="sm" className="min-h-11 …">` shape the other charts use so the tile reads consistently.
- Effort: S

### F7 — Dashboard-layout reorder arrows are 20 × 20 px each (settings read path)

- Severity: High
- Axis: visual
- File: `src/components/settings/dashboard-layout-section.tsx:282-302`
- Symptom: Two `<Button size="icon" className="h-5 w-5">` stacked vertically per row. 20 × 20 px is well below the 44-px floor; on the Pixel 5 the two arrows together form a single 20 × 40 box, and a thumb tap easily hits the wrong one. (MA6 owns Settings write paths; flagging here because the audit brief lists the read path of this component explicitly.)
- Evidence: Inline className read.
- Recommended fix: Replace per-row up/down icons with a single `<Button>` opening a "Move to position…" listbox, OR keep both but bump to `size="icon-sm"` (32 px) plus a `min-h-11 min-w-11` padding wrapper.
- Effort: S

### F8 — Onboarding-checklist row dismiss X is 24 × 24 px, sits beside a separate CTA on a narrow row

- Severity: High
- Axis: visual
- File: `src/components/onboarding/getting-started-checklist.tsx:438-452`
- Symptom: The per-row dismiss button is a raw `<button className="… p-1">` → effectively 24 × 24 px. Adjacent CTA `<Button size="sm">` (32 px) plus the checklist row icon makes a three-target row in 60 px of horizontal space on 320-px viewports. The whole row is also `flex items-center gap-3` with no `flex-wrap` — long German row titles ("Notifications einrichten" combined with a "Einrichten" CTA) plus the X overflow.
- Evidence: Lines 401-456; no `flex-wrap` and no `min-w-0` guard beyond the inner `<div className="min-w-0 flex-1">`.
- Recommended fix: Bump dismiss button to `min-h-11 min-w-11`, hide the CTA label below `sm:` (icon-only) or stack the CTA + dismiss on a second row via `flex-wrap`.
- Effort: S

### F9 — Health-Score card forces a fixed 360 / 400-px column on `lg+` viewports inside a non-flex parent

- Severity: Medium
- Axis: code
- File: `src/components/insights/health-score-card.tsx:241`
- Symptom: `"w-full lg:w-[360px] lg:shrink-0 xl:w-[400px]"`. The card lives in the insights hero on `/insights`, not on `/`, so this only affects the dashboard surface tangentially — but the comment at lines 235-241 documents that the value was bumped reactively (260 → 360 → 400) to fix a label-overflow bug. Two fixed pixel widths layered with `xl:` rather than fluid `lg:basis-1/3 xl:basis-2/5` is brittle. Also on the iPad portrait (768-820 px) viewport this becomes the only fixed-width child in an otherwise fluid card, creating an awkward gap.
- Evidence: Inline className read.
- Recommended fix: Replace with `w-full lg:basis-[360px] lg:shrink-0 lg:grow-0 xl:basis-[400px]` (basis instead of width so flex still distributes leftover space cleanly), or move to a CSS grid with `lg:grid-cols-[1fr_22rem]`.
- Effort: S

### F10 — Dashboard tile strip uses `auto-fit + minmax(min(100%, 9rem), 1fr)` which collapses to one tile per row at 320 px

- Severity: Medium
- Axis: visual
- File: `src/app/page.tsx:1231`
- Symptom: `grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr))`. At 320 px (Galaxy Fold compact) the `min(100%, 9rem)` resolves to 9rem = 144 px which gets multiplied by gap-3 (12 px) — so two tiles per row fit in theory, but the trend-card padding (`p-4` = 16 px each side) means the value row gets ~80 px, just enough but tight. The bigger issue: when the user has 9 tiles enabled and a 320-px viewport, the strip becomes a 5-row vertical stack — exactly the "Excel grid" the maintainer rejected.
- Evidence: Inline reading at lines 1219-1242 plus the long comment at 1219-1230 acknowledging the maintainer's "one-row vs wrap" tension.
- Recommended fix: At `<sm` switch to `flex overflow-x-auto snap-x snap-mandatory` with `min-w-[10rem]` tiles (the comment at lines 1204-1207 actually describes this pattern but the implementation switched to wrap-grid). Above `sm:` keep the current grid. Document the deliberate split.
- Effort: M

### F11 — Trend-card avgAllTime mobile-secondary row stacks on top of every tile, breaks the strip height contract

- Severity: Medium
- Axis: visual
- File: `src/components/charts/trend-card.tsx:381-440`
- Symptom: The BD-Zielbereich tile alone supplies `avgAllTime`, and the `<sm` branch (lines 403-439) renders a SECOND secondary row beneath the main 7d/30d row. Every other tile in the strip has only the main row. With the parent `grid auto-rows-fr` (page.tsx:1231) the BD-Zielbereich tile is the tallest, so EVERY tile in the strip inflates to match — adding ~16 px of empty space per tile on Pixel 5. The `<sm:hidden` block at 275-299 (compareDelta callout) is suppressed for BD-Zielbereich on mobile but rendered for other tiles, creating asymmetric heights across the strip.
- Evidence: Comment at lines 269-274 even describes the issue; the fix only collapses one of the two rows.
- Recommended fix: Below `sm:`, render the avgAllTime + compareDelta as a single inline span inside the existing main row using `flex-wrap`. Drop the separate `mt-1` `<div>` so all tiles share the same row count.
- Effort: M

### F12 — Recharts `ResponsiveContainer` with no min-height and `h-[240px]` parent makes the chart layout-shift on first paint

- Severity: Medium
- Axis: visual
- File: `src/components/charts/health-chart.tsx:1048,1173`; `src/components/charts/mood-chart.tsx:641`; `src/components/charts/medication-compliance-chart.tsx:386`
- Symptom: All three charts pin `h-[240px]` (or `h-[140px]` mini) on the wrapper and let Recharts fill `100% / 100%`. Recharts' `<ResponsiveContainer>` first renders 0 × 0 then re-renders once it measures — visible flash on Pixel 5 because each card mounts via `next/dynamic`. The fixed pixel height also clashes with the dynamic `chooseTickInterval` density logic if the user rotates landscape (height stays 240, width doubles, ticks no longer match).
- Evidence: Inline reading; comparison-friendly. Same `h-[240px]` literal repeats in five files.
- Recommended fix: Move the height to a CSS custom property (`--chart-h: 200px` mobile / `240px` sm+), or `aspect-[16/9] max-h-[260px]` so the chart reflows on rotation. Add `motion-reduce:transition-none` to the Recharts animation block.
- Effort: M

### F13 — Onboarding card title row uses a single `<header>` button-plus-button with no `flex-wrap`

- Severity: Medium
- Axis: visual
- File: `src/components/onboarding/getting-started-checklist.tsx:322-361`
- Symptom: `<header className="flex items-start justify-between gap-3">` contains a tappable title button (chevron + "Erste Schritte" + subtitle) AND a "Alles ausblenden" dismiss button. On 320 px the German subtitle "Richte HealthLog in fünf Schritten ein…" wraps to three lines while "Alles ausblenden" keeps its full text — they collide. There's no `min-w-0` on the title button's child div.
- Evidence: Lines 322-361. The inner `<div className="space-y-1">` lacks `min-w-0`, and the subtitle paragraph lacks `truncate` or `line-clamp-2`.
- Recommended fix: Add `min-w-0 flex-1` to the inner `<div>` and `line-clamp-2` on the subtitle. Make the dismiss button icon-only (`<X />`) below `sm:` to free up the row.
- Effort: S

### F14 — TrendCard label row uses `truncate` on a flex child but the parent flex chain is missing `min-w-0` upstream

- Severity: Low
- Axis: code
- File: `src/components/charts/trend-card.tsx:220-228`; `src/app/page.tsx:1237`
- Symptom: The label row is `<div className="flex h-5 min-w-0 items-center justify-between gap-2">` and the inner span carries `min-w-0 flex-1 truncate` — that part is fine. BUT the parent grid cell in page.tsx wraps each tile in `<div key={…} className="flex min-w-0">`. The wrapper is a `flex` container with no `flex-direction` and no `w-full` — it just holds one child. Vestigial. Replace with a fragment or `<div className="contents">`.
- Evidence: Page.tsx:1237.
- Recommended fix: Either drop the wrapper entirely (the tile is already `flex h-full w-full min-w-0 flex-col`) or replace `flex min-w-0` with `block min-w-0`.
- Effort: S

### F15 — Daily briefing key-finding row has no swipe-to-dismiss gesture; desktop hover-reveal pattern absent on mobile

- Severity: Low
- Axis: logic
- File: `src/components/insights/daily-briefing.tsx:129-163`
- Symptom: Each key-finding row carries no per-row action — no dismiss, no "open relevant insights sub-page" affordance. On desktop, hover hints could surface; on mobile, a tap on the row is a no-op. Other dashboards (Oura, Apple Health) treat each finding as tappable with a swipe-left to dismiss / pin.
- Evidence: Lines 131-162 — the row is a static `<div>`, not a `<button>` or `<Link>`.
- Recommended fix: Wrap each row in a `<Link href={metricInsightsHref(finding.sourceMetric)}>` so a tap routes to the matching `/insights/<metric>` sub-page. Optional: add swipe-to-dismiss via a small gesture library (out of scope for v1.4.27, defer).
- Effort: M

### F16 — Hero strip "weekly report banner" uses `flex-wrap` so the three action buttons stack into a 4-row strip on 320 px

- Severity: Low
- Axis: visual
- File: `src/components/insights/hero-strip.tsx:371-424`
- Symptom: `<div className="… flex flex-wrap items-center gap-3 …">` with Read / Share / Export buttons. On Galaxy Fold the three buttons + the SparklesIcon + the label paragraph all stack onto separate lines, creating a 4-row banner that's taller than the hero greeting itself. The hero-strip note at lines 159-167 documents `isolate overflow-hidden` to control glow z-index but the banner inflates the band visually.
- Evidence: Inline reading. The banner appears on `/insights`, not on `/`, but lives in a component listed in the MA1 surface; surfacing for the consolidator's awareness.
- Recommended fix: Below `sm:`, collapse Share + Export PDF into a `<DropdownMenu>` triggered by an icon-only button — keep Read as the primary action.
- Effort: S

## Headline metrics

- Components reviewed: 14
- Findings by tier: C: 1 H: 5 M: 6 L: 4
- Mobile-hostile patterns flagged for B7-style symmetry pass: 5 (Dialog→Sheet branch, sub-44 tap targets across Dialog close + dropdown items + reorder arrows + GLP-1 strip + checklist dismiss, fixed pixel widths on chart Y-axis + health-score column, inline pixel layout instead of Tailwind insets, mobile-secondary row asymmetry in trend cards)

## Open questions for the consolidator

- The Dialog → Sheet branch on mobile (F1) is a substantial UX shift and probably needs to coordinate with MA4 (measurements / workouts forms) and MA5 (medication forms) since the same Dialog wrapper is reused everywhere. Suggest a shared `<ResponsiveSheet>` primitive lands in a single MB bucket rather than per-surface patches.
- The trend-strip wrap-vs-scroll decision at 320 px (F10) revisits a maintainer call from v1.4.4 (preserve wrap symmetry). The fix proposed in F10 is `<sm`-only horizontal scroll above the wrap fallback. Needs maintainer confirmation; if the wrap stay is non-negotiable, demote F10 to Low and only address F11.
- The GLP-1 tile chart-tab/range-strip (F6) and the dashboard reorder arrows (F7) both lean on the same `<Button size="sm" className="min-h-11">` shape the chart range tabs already adopted. A repo-wide convention (e.g., a `<TouchTarget>` wrapper component) would let R3d consolidate. Worth flagging to the consolidator as a candidate B7-style symmetry pass.
- Health-Score card (F9) is in the MA1 brief but renders on `/insights`, not on `/`. Decide whether MA2 (insights) or MA1 owns the fix in R3d.
