---
file: .planning/research/v1427-r3c-mobile-insights.md
purpose: Mobile capability audit — Insights index and seven routed sub-pages
created: 2026-05-15
auditor: MA2
---

# Mobile audit — Insights surface

## Summary

Reviewed the Insights mother page, the shared layout shell, the seven routed
sub-pages (`blutdruck`, `gewicht`, `puls`, `stimmung`, `medikamente`, `bmi`,
`schlaf`), the weekly-report route, and 12 supporting components (tab strip,
hero strip, daily briefing, health-score card, status card, sub-page shell,
correlation row + card, trends row, sleep overview + stage bar +
duration chart, therapy timeline, VO2 chart row, scatter chart, compliance
heatmap, suggested-prompts, Coach drawer + body, recommendations grid).

19 findings: 0 Critical, 6 High, 9 Medium, 4 Low. Headline themes:
(1) systematic 28-36 px tap targets across hero, advisor card, Coach drawer
header, and sub-page CTAs sit below the WCAG 2.5.5 44 pt floor that the tab
strip already honours; (2) compliance heatmap is hover-only on touch
devices, no `onTouchStart` / `onPointerEnter` parallel; (3) Coach drawer
mounts a right-edge sheet on every viewport — mobile UX convention is
bottom-sheet for primary entry; (4) several flex rows are missing
`min-w-0` on the truncating child, allowing long medication names or
prompt chips to push siblings off-screen; (5) the scatter card and VO2
chart row carry fixed pixel heights (180-220 px) that work but should be
called out for the broader chart-fluidity rule.

## Findings

### F1 — Hero strip action buttons are h-8 on a 14-px-tap-target row
- Severity: High
- Axis: visual
- File: `src/components/insights/hero-strip.tsx:241-280`
- Symptom: "Weekly report" + "Ask the coach" + the inline weekly-banner
  Read/Share/Export trio are all `<Button size="sm">` (h-8, 32 px). The
  surrounding row is the user's primary engagement gate on every
  viewport. At 320-414 px the actions wrap into 2-3 rows of 32 px pills.
- Evidence: `size="sm"` resolves to `h-8 rounded-md ... px-3` per
  `src/components/ui/button.tsx:26`. WCAG 2.5.5 (Target Size) AAA = 44 ×
  44 px; AA = 24 × 24 px. The tab strip in the same surface upgraded to
  `min-h-11` (44 px) for the v1.4.27 W8.3 touch-target pass; the hero
  did not follow.
- Recommended fix: bump hero action buttons to `size="default"` (h-9,
  36 px) at minimum and add `min-h-11` on `<sm:` viewports, or promote
  to `size="lg"` (h-10) on mobile. Same change for the weekly-banner
  Read / Share / Export trio.
- Effort: S

### F2 — Suggested prompt chips below 44 pt
- Severity: High
- Axis: visual
- File: `src/components/insights/suggested-prompts.tsx:71-79`
- Symptom: Prompt chips set `min-h-9` (36 px) with `py-2` paddings. The
  chip strip is the on-ramp into Coach interaction; the tab strip pills
  in the same column upgraded to `min-h-11`. Chips read as
  second-class.
- Evidence: line 73 — `"text-muted-foreground inline-flex min-h-9
  items-center gap-1.5"`. The chips wrap on `<sm:` (`flex-wrap`) so the
  row stays readable, but each tap target is 36 × ~120 px.
- Recommended fix: switch to `min-h-11` to match the tab strip; padding
  stays at `py-2 px-3.5` which still pads to 11 px around 13 px text.
- Effort: S

### F3 — Coach drawer mounts a right-edge sheet on every viewport
- Severity: High
- Axis: logic
- File: `src/components/insights/coach-panel/coach-drawer.tsx:257-279`
- Symptom: `<SheetContent side="right">` carries the Coach on phones at
  full-width. The mobile UX convention for a primary entry point is a
  bottom-sheet (`side="bottom"`) so the user can dismiss with a swipe-
  down and the input box sits above the on-screen keyboard's natural
  resting position. Right-edge sheets read as desktop drawer paradigm
  on a 320-414 px viewport.
- Evidence: line 259 hardcodes `side="right"`. The shell sets
  `w-full p-0 sm:max-w-[720px]`, so on phones the sheet takes the whole
  viewport from the right edge — the user only sees the sliding
  animation direction differ from a bottom-sheet expectation.
- Recommended fix: conditional `side` — use `side="bottom"` on
  `<sm:` viewports (via a `useMediaQuery("(max-width: 639px)")` or
  duplicate Sheet mounting). Apple Health, Oura, and Bevel all use
  bottom-sheets for their AI / coach affordances on iPhone.
- Effort: M

### F4 — Coach drawer header actions size-9 below 44 pt
- Severity: High
- Axis: visual
- File: `src/components/insights/coach-panel/coach-drawer.tsx:355-393`
- Symptom: The new-chat, settings, and close icon buttons in the
  drawer header all carry `size="icon"` + `className="... size-9 ..."`
  → 36 × 36 px. The header comment at line 351 explicitly claims
  "36×36 px hit target meets the WCAG 2.1 AA touch-target minimum on
  mobile" — that is the AA *enhanced* minimum (24 × 24); WCAG 2.5.5
  AAA = 44 × 44, and Apple HIG explicitly mandates 44 pt.
- Evidence: `size-9` × 3 instances. The drawer is the primary AI entry
  point; users dismissing the drawer from a phone are likely to hit
  the wrong icon.
- Recommended fix: switch to `size-11` (44 px) on `<sm:`, keep
  `size-9` from `sm:` upward via responsive utility.
- Effort: S

### F5 — Mobile rail tray triggers are h-7 (28 px)
- Severity: High
- Axis: visual
- File: `src/components/insights/coach-panel/coach-drawer-body.tsx:64-91`
- Symptom: Both history-tray and sources-tray chevron triggers are
  absolutely positioned `<Button size="sm">` overridden with
  `h-7 ... text-[11px]`. 28 × ~120 px tap targets are well under any
  WCAG floor — these are the ONLY way a mobile Coach user can browse
  conversations or see what's in scope.
- Evidence: lines 73 + 87 — `h-7` × 2.
- Recommended fix: bump to `min-h-11` and reposition. Consider moving
  the triggers into the header row (alongside new-chat / settings)
  on `<lg:` so they don't float over message content.
- Effort: M

### F6 — Compliance heatmap is hover-only on touch devices
- Severity: High
- Axis: logic
- File: `src/components/charts/compliance-heatmap.tsx:254-278`
- Symptom: Tooltip details (taken/expected, on-time/late split) only
  surface via `onMouseEnter` / `onMouseLeave`. iPhone Safari emulates
  mouse-enter on first tap (toggles tooltip), then dismisses on next
  tap anywhere — fragile UX. iOS users effectively cannot read the
  per-day breakdown on the medikamente sub-page.
- Evidence: lines 254 (`onMouseEnter`), 277 (`onMouseLeave`). No
  `onPointerEnter`, `onTouchStart`, or `aria-describedby` fallback.
- Recommended fix: parallel pointer handlers (`onPointerEnter` covers
  both mouse + pen + touch), `onPointerLeave`. Add a tap-to-pin
  pattern: first tap pins the tooltip near the cell, second tap on
  any other cell moves it, tap outside closes. Mirror Apple Health's
  heatmap row.
- Effort: M

### F7 — Compliance heatmap cells can shrink below 8 px in stretch mode
- Severity: Medium
- Axis: visual
- File: `src/components/charts/compliance-heatmap.tsx:189-198`
- Symptom: When `stretch=true` (the medikamente sub-page uses it
  inside each medication card) the cell-size computation clamps at
  `Math.max(8, …)`. At 320 px viewport, the medication card is roughly
  280 px wide; 90 days = ~13 columns at 18 px requires ~250 px —
  borderline. As soon as the user is in landscape or has a wider
  card, cells shrink toward 8 px. 8 × 8 px cells are illegible AND
  untappable.
- Evidence: line 193 — `Math.max(8, ...)`. The fallback is the
  pre-stretch 18 px cell.
- Recommended fix: lift the floor to 14 px, and let the heatmap
  scroll-x on `<sm:` instead of compressing to illegibility. Apple
  Health uses horizontal scroll for the activity ring history; same
  precedent applies here.
- Effort: M

### F8 — Medication card header is flex-justify-between with no min-w-0
- Severity: Medium
- Axis: code
- File: `src/app/insights/medikamente/page.tsx:155-168`
- Symptom: The left flex (icon + medication name) does not carry
  `min-w-0`, so long medication names like "Semaglutide injection
  Wegovy" or names with parentheses push the streak badge off the
  right edge. The badge ends up clipped or wrapping.
- Evidence: line 157 — `<div className="flex items-center gap-2">`
  (no `min-w-0 flex-1`), title at line 159 has no `truncate`. The
  outer row at line 156 uses `flex items-center justify-between`.
- Recommended fix: add `min-w-0 flex-1` on the left flex and
  `truncate` on the title; `shrink-0` on the streak badge.
- Effort: S

### F9 — InsightAdvisorCard icon buttons h-7 w-7 (28 px)
- Severity: Medium
- Axis: visual
- File: `src/components/insights/insight-advisor-card.tsx:478-489, 544-555`
- Symptom: Two header regenerate icon buttons set `size="icon"` then
  override with `className="h-7 w-7"` (28 × 28 px). These are the
  primary "retry / refresh analysis" controls.
- Evidence: lines 479 + 545, both `h-7 w-7`. Also lines 508 + 695 set
  `h-7 text-xs` on the inline legacy-payload regenerate.
- Recommended fix: drop the `h-7 w-7` override, accept the default
  `size-9` from the icon variant, and add `min-h-11 min-w-11` on
  `<sm:`.
- Effort: S

### F10 — Health-score provenance toggle button below 44 pt
- Severity: Medium
- Axis: visual
- File: `src/components/insights/health-score-card.tsx:399-421`
- Symptom: The "Driven by" provenance accordion toggle is `text-[11px]`
  on a button with no `min-h-11`. The button is `w-full` so the tap
  area is wide, but vertical hit area is roughly 16 px (line-height
  of the 11 px text plus the implicit padding from gap-1).
- Evidence: lines 408-411 — `"flex w-full items-center justify-between
  gap-1 rounded text-[11px]"`, no `py-*`, no `min-h-*`.
- Recommended fix: add `min-h-11 px-2 py-2`. The wider tap region is
  free; the visual width stays the same.
- Effort: S

### F11 — Sub-page-shell heading focus on every nav uses scrollTo({top: 0})
- Severity: Medium
- Axis: logic
- File: `src/components/insights/sub-page-shell.tsx:53-59`
- Symptom: Every sub-page mount fires `window.scrollTo({ top: 0,
  behavior: "auto" })` plus `headingRef.current?.focus()`. The sticky
  tab strip on top of the layout shell already pins to `top-0` (z-30
  with backdrop-blur). On mobile, the scroll happens during the
  hand-off from the previous page so the user perceives a flash of
  the previous sub-page's bottom edge before the new page renders.
- Evidence: lines 55-58 inside `useEffect`. The focus call also fires
  even when the user is using a mouse — a programmatic focus on the
  h1 puts a focus-ring on the heading for non-keyboard users.
- Recommended fix: gate the focus call on a keyboard-navigation
  detection (e.g. set a body-level data attribute on first Tab key),
  or use `preventScroll: true` which is already there but couple it
  with a focus-visible-only ring (which the shell already does via
  `focus-visible:ring-2`). The scroll-reset itself is fine; consider
  honouring `prefers-reduced-motion` and skipping when there's no
  prior scroll position.
- Effort: M

### F12 — Empty-state CTAs render as `size="sm"` (h-8) buttons
- Severity: Medium
- Axis: visual
- File: every sub-page empty-state — `src/app/insights/blutdruck/page.tsx:80-84`, `…/gewicht/page.tsx:76-82`, `…/puls/page.tsx:90-95`, `…/stimmung/page.tsx:72-76`, `…/medikamente/page.tsx:129-135`, `…/bmi/page.tsx:85-91, 105-110`, `…/schlaf/page.tsx:64-70`
- Symptom: Every metric sub-page's empty-state CTA uses
  `<Button size="sm">` (h-8) wrapped in `<EmptyState>`. The CTA is the
  user's onboarding ramp from zero data into the measurement flow.
  Mobile UX convention is full-width primary CTA — empty-states have
  one job: drive the user into the next surface.
- Evidence: 8 separate `<Button size="sm" asChild>` instances. None
  carry `className="w-full sm:w-auto"` or `size="lg"`.
- Recommended fix: in `EmptyState` (`src/components/ui/empty-state.tsx`),
  pass through a `block` size variant that flips the action wrapper to
  `w-full sm:w-auto`. Alternatively, accept a `ctaSize` prop and
  default to `"lg"` on mobile.
- Effort: M

### F13 — Scatter correlation chart carries fixed 180-px height
- Severity: Medium
- Axis: code
- File: `src/components/charts/scatter-correlation-chart.tsx:83-86` (used by `correlation-card.tsx:114`)
- Symptom: `height={180}` is a pixel constant on the outer wrapper.
  At narrow viewports the chart squeezes to ~280 px wide × 180 px
  tall — datapoints crowd, axis ticks ("preserveStartEnd") still draw
  at fontSize=12 px but the bottom legend (label position="bottom",
  margin.bottom=36) eats a third of the height. The plot area is
  effectively ~110 × 250 px.
- Evidence: line 83 — `height = 250` default; correlation card passes
  `height={180}`. Chart-fluidity rule wants
  `aspect-ratio` + `min-h-*` over fixed pixels.
- Recommended fix: switch to `aspect-[16/9]` with `min-h-[180px]`,
  let the container reflow. Or accept `heightClass` plus a
  ResponsiveContainer-fed parent.
- Effort: M

### F14 — VO2-max stat strip 4-col on `sm:` may crowd at 640 px
- Severity: Medium
- Axis: visual
- File: `src/components/insights/vo2-max-chart-row.tsx:140-197`
- Symptom: `grid-cols-2 ... sm:grid-cols-4` with four stat tiles
  (latest, min, max, avg30). At 640 px the 4-col layout starts; each
  tile gets ~140 px including padding. The tabular-nums values are
  fine, but the compare-delta caption ("Δ +1.2 vs. last month")
  wraps to two lines under the avg30 number, pushing the row's
  baseline down 16 px while the other three stay short.
- Evidence: lines 141 (`sm:grid-cols-4`) + 180-194 (delta caption
  inside the avg30 tile only).
- Recommended fix: switch to `grid-cols-2 lg:grid-cols-4` (let `sm:`
  stay 2-up), and add `min-h-[X]` to all four tiles so the avg30
  caption doesn't shove the row when present.
- Effort: S

### F15 — Sleep-stage window toggle "7d / 14d / 30d" tap targets
- Severity: Low
- Axis: visual
- File: `src/components/insights/sleep-stage-stacked-bar.tsx:218-236`
- Symptom: Toggle pills already carry `min-h-11 px-2 text-xs sm:px-3`
  — good. But the row is `gap-1` (4 px) between buttons; at 320 px,
  the row crowds against the title cluster on the left, which
  doesn't wrap because the `sm:flex-row` kicks in only at 640 px. At
  320-414 px the row is `flex flex-col gap-2` (column), so the
  toggle row is full-width on its own line. Tap-target floor met;
  flag is the cosmetic crowding above `sm:`.
- Evidence: lines 218-220 `flex items-center gap-1 self-end sm:self-auto`.
- Recommended fix: bump gap to `gap-1.5` (6 px) for better visual
  separation; no functional change.
- Effort: S

### F16 — Insight status card has no "show more" collapse for long text
- Severity: Medium
- Axis: logic
- File: `src/components/insights/insight-status-card.tsx:97-110`
- Symptom: The status card renders the AI assessment as a single
  paragraph (`<p className="text-muted-foreground text-sm
  leading-relaxed">{stripChartTokens(text)}</p>`). On a 320 px
  viewport, a typical 4-5-sentence assessment runs 8-10 lines and
  pushes the chart above out of view as the user scrolls. Apple
  Health collapses descriptive paragraphs at ~3 lines with a "More"
  / "Less" toggle.
- Evidence: line 105-107. No `line-clamp-*`, no expand-toggle.
- Recommended fix: `line-clamp-3` with a "Show more" toggle on
  `<sm:`; full text on `sm:+`. Provider needs an explicit reading
  affordance.
- Effort: M

### F17 — Trends row md:grid-cols-3 — single fluid column on mobile is fine but min-h locks 300 px even when chart is mini
- Severity: Low
- Axis: code
- File: `src/components/insights/trends-row.tsx:110-167`
- Symptom: Each trend card carries `flex h-full min-h-[300px]
  flex-col gap-2`. On a 320 px viewport with three stacked cards,
  that's 900 px of guaranteed vertical real estate plus 220 px chart
  skeletons inside each. The card minimum is appropriate when the
  annotation prose lands; while the chart is loading the user sees
  three identical 220 px skeletons separated by 80 px of vertical
  whitespace.
- Evidence: lines 114, 134, 153 — `min-h-[300px]` × 3.
- Recommended fix: keep the min-h for desktop alignment, drop to
  `md:min-h-[300px]` so mobile cards size to content; this also
  lets the loading skeletons read as a tight stack.
- Effort: S

### F18 — Insights-tab-strip `overflow-x-auto` carries no scroll-snap or affordance
- Severity: Low
- Axis: visual
- File: `src/components/insights/insights-tab-strip.tsx:140-145`
- Symptom: The tab strip scrolls horizontally on `<sm:` with
  `[scrollbar-width:none]`. With 8 pills (overview + 7 sub-pages),
  the right edge is clipped at 320 px. Users have no visual signal
  that they can swipe to see more pills — no fade-mask, no scroll
  indicator. Apple Health's similar pill row carries a right-edge
  gradient mask.
- Evidence: lines 140-142 — the strip's CSS hides the scrollbar
  via `[scrollbar-width:none]` + `[&::-webkit-scrollbar]:hidden`, but
  adds no affordance to replace it.
- Recommended fix: add a right-edge gradient mask
  (`mask-image: linear-gradient(to right, black 85%, transparent)`)
  that fades out when the active pill scrolls into view. Or scroll
  the active pill into view on mount.
- Effort: M

### F19 — Hero strip stacking break at `lg` may strand health-score on tablets
- Severity: Low
- Axis: visual
- File: `src/components/insights/hero-strip.tsx:172-176`
- Symptom: `lg:flex-row` is the split breakpoint between hero title
  block (left) + health-score panel (right). `lg` = 1024 px. On a
  768-1023 px tablet (e.g. iPad Mini portrait), the health-score
  stacks BELOW the title + actions + suggested-prompts row. The
  HSC is the second most important affordance on the page; pushing
  it down 400-600 px on tablets buries it.
- Evidence: line 175 — `healthScore && "lg:flex-row lg:items-start
  lg:gap-6"`. Could be `md:flex-row` (768 px+).
- Recommended fix: move the split to `md:flex-row` so the HSC
  surfaces on iPad portrait. The HSC's own `lg:w-[360px]` width can
  drop to `md:w-[280px] lg:w-[360px]` to fit.
- Effort: S

## Headline metrics
- Components reviewed: 23 (layout shell, tab strip, 7 sub-pages, mother
  page, hero, daily briefing, health-score, status card, sub-page
  shell, advisor card, recommendations grid, correlation row + card,
  trends row, sleep overview + stage bar + duration chart, therapy
  timeline, VO2 row, Coach drawer + body, suggested-prompts,
  compliance-heatmap, scatter chart, weekly-report view)
- Findings by tier: C: 0  H: 6  M: 9  L: 4
- Mobile-hostile patterns flagged for B7-style symmetry pass:
  the systematic `size="sm" / h-7 / size-9` button cluster across hero,
  advisor card, Coach header, and rail triggers is one root cause
  manifesting in 6 separate spots. A symmetry-pass migration of
  small-button sizing across `src/components/insights/` would close
  F1, F2, F4, F5, F9, F10 in one bucket.

## Open questions for the consolidator

- F3 (Coach bottom-sheet on mobile) is a moderate-effort UX change.
  Apple Health, Oura, Bevel all do bottom-sheet for AI surfaces; the
  current right-edge sheet works mechanically but feels desktop-on-
  mobile. Is the appetite to change the side conditionally, or accept
  the current right-edge for v1.4.27 and revisit in v1.4.28?

- F12 (empty-state CTA sizing) wants a change inside
  `src/components/ui/empty-state.tsx`, which is a shared primitive used
  by every surface (not just Insights). Two routes: (a) add a `ctaSize`
  prop in MA-shared-empty-state bucket, touching every empty-state
  consumer, or (b) apply local `className="w-full sm:w-auto"` on each
  Insights empty-state, leaving other surfaces unchanged. (a) is
  symmetry-friendly but cross-surface; (b) is local.

- F6 (heatmap touch support) — the compliance-heatmap is also
  consumed outside Insights (medication detail surfaces). Touch
  support is a primitive-level fix; please decide whether MA5
  (medications) owns the heatmap fix or MA2 (Insights) does. My
  preference: MA5 since the primitive lives under `charts/` and is
  shared between medication-detail and Insights.

- F11 (sub-page-shell focus + scroll behaviour) is a small UX bug but
  the scroll-reset is intentional and the focus call is for screen-
  reader users. Worth confirming with the consolidator that adding a
  keyboard-only gate is the right call rather than removing the
  programmatic focus entirely.
