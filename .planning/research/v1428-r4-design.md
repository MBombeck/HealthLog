---
file: .planning/research/v1428-r4-design.md
purpose: R4 design review — 7-axis pass across the v1.4.28 user-facing diff
created: 2026-05-16
contributor: R4 design
---

# v1.4.28 — R4 design review

Read-only 7-axis pass across the 11 user-facing surfaces from
`.planning/v1428-feedback-2026-05-15.md` (themes F, G, H, I, K, L, M).
Diff scope: 30 commits since `v1.4.27`. Axes: hierarchy, contrast
(WCAG 2.1 AA), spacing, typography, responsive (320 / 768 / 1024 / 1440
px), a11y, motion.

R1 prerequisites `v1428-r1-ui-inventory.md` and `v1428-r1-competitive.md`
are not yet on disk; review reads components directly and benchmarks
against `v1427-r4-design.md`.

---

## Severity-grouped findings

### Critical

None. The maintainer's eight Critical feedback items (bug-class, scope
reduction) are bug + scope work, not design. No regressions on the 7 axes
that would block tag.

### High

**D-H1 — Target-card Coach button under WCAG 2.5.5 tap-target floor**
File: `src/components/targets/target-coach-button.tsx:65-86`
Axis: a11y / responsive
FB-L1 collapses the affordance to `<Button size="icon" />`. The shadcn
`icon` variant is `size-10` (40 px); the project floor (Phase A5,
medication-history button, Coach drawer cluster) is 44 px. The labelled
pill it replaced cleared the floor on width; the collapse fell under it.
Recommendation: pass `size="icon-lg"` (already in the button CVA) or
override with `min-h-11 min-w-11`. Glyph stays `size-4`; hit target
lifts to 44 px without visual change.

**D-H2 — Health-score delta `?` trigger under WCAG 2.5.5**
File: `src/components/insights/health-score-delta-explainer.tsx:62-81`
Axis: a11y / responsive
Trigger is `h-4 w-4` (16 px) hosting a `h-3 w-3` glyph. WCAG floor is
44 px. The file comment claims the focus ring is the touch target —
visual-only. Phone tap surface is 16 × 16 next to the dense sub-bars
block.
Recommendation: keep the visible glyph 12-16 px but inflate the hit
target via `p-2` on the button + `-m-2` on the parent so optical
chip stays small while touch surface lifts to 32-44 px.

**D-H3 — Mobile delta-explainer trigger wraps the button in a clickable span**
File: `src/components/insights/health-score-delta-explainer.tsx:83-115`
Axis: a11y
Mobile branch wraps the `<button>` in `<span onClick onKeyDown>`. The
inner button swallows clicks before the span sees them; the span's
handler only fires on the 2 px gap. SR announces two interactive
elements.
Recommendation: drop the `<span>`; move `onClick` / `onKeyDown` onto
the button directly. `type="button"` + existing `aria-label` cover a11y.

**D-H4 — Delta line has no `aria-describedby` thread to the explainer**
File: `src/components/insights/health-score-card.tsx:330-364`
Axis: a11y
The delta `<p>` and the `<HealthScoreDeltaExplainer>` are inline
siblings; no `aria-describedby` ties the digit to the explanation. SR
announces "−3 vs last week, button, What does this delta mean" — the
connection is visual-only.
Recommendation: thread a `useId()` from the explainer into the delta
`<span>`'s `aria-describedby`; mirror the Radix tooltip pattern already
used in `<TrendCard>`.

**D-H5 — Trends row mood mini retains a `<Card>` hairline border**
File: `src/components/insights/trends-row.tsx:124-191` +
`src/components/charts/mood-chart.tsx:529-540`
Axis: visual hierarchy / spacing rhythm
FB-K1/K2 lands `auto-rows-fr` + a fixed chart-slot wrapper, and the
mood mini collapses to `gap-1 py-2 shadow-none`. But the `<Card>`
primitive still paints `border bg-card`; BP/weight minis use no
`<Card>` at all. Result: mood ships a 1-px hairline that BP/weight
don't. Heights now match within ~2 px; the border is visible at 320 px
single-column and on retina.
Recommendation: drop the `<Card>` wrapper on the mood-mini path (bare
`<div>` with the same gap rhythm), or lift a shared chart-slot
primitive both minis consume.

**D-H6 — Med-list two-line shape wraps to 3+ lines at 320 px when state badges present**
File: `src/components/medications/MedicationCardHeader.tsx:44-63`
Axis: responsive / spacing rhythm
Line 2 is `flex flex-wrap` with category `<Badge>` + state badges
(without-notification, paused, inactive). At 320 px, any state badge
pushes the row to 3 lines. FB-G1's "two-line, no exceptions" contract
breaks for ~20 % of configured drugs.
Recommendation: drop state badges to a separate `<div>` below the
category badge, OR collapse to a single status pill (most users have
at most one).

**D-H7 — Side-effects date column overspec by 40 px on narrow viewports**
File: `src/components/medications/SideEffectsSection.tsx:280-311`
Axis: responsive
Date stamp is `w-[5.5rem]` (88 px); the maintainer's "15.05" example
fits in 48 px. The left slot (category + entry + severity) is wrap-prone
at 320 px; recovering 32 px helps the wrap rhythm.
Recommendation: narrow to `w-14` (56 px) — fits the longest short-date
("15. Mai") with 1.5ch slack.

**D-H8 — Medication-detail sibling stride drops to 14 px after the heading collapse**
File: `src/components/medications/medication-detail-section.tsx:65-78` +
`src/app/medications/[id]/history/page.tsx:57-130`
Axis: spacing rhythm / visual hierarchy
Page wraps sections in `space-y-4` (16 px); each section has a 1 px
border. Effective gap is 14 px against dense `text-xs` content — reads
tight after the heading collapse.
Recommendation: lift the page wrapper to `space-y-6` (24 px) to match
the `/insights` sub-page stride. Heading collapse stays.

### Medium

**D-M1 — Empty-state path stacks two muted descriptions**
File: `src/components/insights/sub-page-shell.tsx:85-117` +
`src/app/insights/blutdruck/page.tsx:49-69`
Axis: visual hierarchy
Sub-pages pass `description={...}` to `<SubPageShell>` on both branches;
the empty-state branch also paints `<MetricEmptyState>`'s own
description. Two stacked muted-foreground lines read as duplication
even though copy is intentionally distinct.
Recommendation: drop `description` from `<SubPageShell>` on the
empty-state branch and let `<MetricEmptyState>` own the muted line.

**D-M2 — Layout Coach FAB gradient text fails WCAG AA contrast**
File: `src/components/insights/layout-coach-fab.tsx:32-50`
Axis: contrast
Gradient is `from-dracula-purple to-dracula-pink` with `text-white`.
Dracula-purple (`#bd93f9`) / white ≈ 2.3:1, dracula-pink (`#ff79c6`) /
white ≈ 2.5:1. AA needs 4.5:1 for body, 3:1 for ≥ 18 px semibold.
Recommendation: bump the label to `text-base font-semibold` (lifts via
large-text exception) OR deepen the gradient toward `dracula-purple/90`
to `dracula-purple` — keeps brand grammar, clears 3:1.

**D-M3 — Coach launch on `md` (768-1023 px) is FAB-only**
File: `src/components/insights/coach-launch-button.tsx:56-71` +
`src/components/insights/layout-coach-fab.tsx:40-46`
Axis: responsive
Inline pill is `hidden lg:inline-flex`; FAB is `lg:hidden`. Tablet
mounts the FAB but hides the sub-page action-row pill. Inv-5 → 3
shapes lands 2 shapes with a mid-tier gap.
Recommendation: product-lead call. Either keep current (tablet =
phone) or lift the inline pill to `md:inline-flex` (tablet = desktop).

**D-M4 — Briefing CTA filled-variant change conflicts with dashboard convention**
File: `src/components/insights/daily-briefing.tsx:336-360`
Axis: visual hierarchy
BK-M2 switches the briefing empty-state CTA from `outline` to filled
default. Comment cites "match the dashboard empty-state CTA shape" —
but dashboard `<EmptyState>` consumers paint `outline size="sm"`. The
change inverts the convention rather than aligning, and pulls focus
from the hero "Ask the coach" outline button directly above.
Recommendation: re-anchor with maintainer. If "primary filled" is the
target, sweep dashboard tiles. If "outline" is the target, revert.
v1.4.27 R4 design §M4 concluded outline.

**D-M5 — Mood-chart mini border applies to standalone consumption too**
File: `src/components/charts/mood-chart.tsx:529-545`
Axis: visual hierarchy
Same `<Card>` border issue as D-H5 but in the standalone consumption
path (sub-page mood mounts).
Recommendation: see D-H5. Lifting the shared chart-slot wrapper fixes
both.

**D-M6 — Tab-strip pills read hollow next to the regenerate icon at `<sm`**
File: `src/components/insights/insights-tab-strip.tsx:177-237`
Axis: spacing rhythm
Pills are `min-h-11 text-xs`; the regenerate button is `h-11 w-11`
solid. Weight balance off on phone.
Recommendation: bump pill `text-xs` to `text-sm` on `<sm` only. Defer
if symmetry isn't a product ask.

**D-M7 — Trend-annotation confidence chip reads as a disconnected footnote**
File: `src/components/insights/trend-annotation.tsx:71-103`
Axis: visual hierarchy
Body clamps at 3 lines; badge sits below as a sibling `<p>`. Truncated
"…" + badge on a separate line reads as orphan footnote.
Recommendation: lift the badge to an inline tail of the prose using
`<Badge>`'s built-in `inline-flex items-center`.

**D-M8 — Med-card schedule dose hidden on `<sm`**
File: `src/components/medications/medication-card.tsx:499-517`
Axis: responsive / typography
Next-intake line wraps the dose in `hidden sm:inline`. Mobile users
lose the dose on the schedule row, even though the unified header
already shows it.
Recommendation: drop the `hidden sm:inline` on the dose span.

### Low

**D-L1 — Delta-explainer popover `max-w-xs` is tight for future copy**
File: `src/components/insights/health-score-delta-explainer.tsx:120-138`
Axis: typography
3-sentence copy fits at every locale; future edits could overshoot.
Recommendation: bump to `max-w-sm` preemptively.

**D-L2 — Sub-page shell `focusOnMount` default-off skips SR heading announce**
File: `src/components/insights/sub-page-shell.tsx:54-83`
Axis: a11y
Trade-off documented (mobile soft-keyboard collision). Tab-strip pill
clicks announce the new pathname; gap is contained.
Recommendation: no code change. Existing file comment covers it.

**D-L3 — `<ResponsiveSheet>` Close affordance verification**
File: `src/components/insights/health-score-delta-explainer.tsx:97-114`
Axis: a11y
Mobile sheet closes via drag + tap-outside; spot-check the primitive
ships a visible Close.
Recommendation: confirm primitive; thread `footer` Close if missing.

**D-L4 — Target Coach button paints both `aria-label` and `title`**
File: `src/components/targets/target-coach-button.tsx:79-86`
Axis: a11y
SR may double-announce on touch; known Radix-tooltip-adjacent issue
across the app.
Recommendation: defer.

**D-L5 — HealthScore progress bar lacks `motion-reduce` gate**
File: `src/components/insights/health-score-card.tsx:317-321`
Axis: motion
`transition-all` on the inner bar animates width + band colour with no
`motion-reduce:transition-none`.
Recommendation: append `motion-reduce:transition-none`.

---

## Per-surface assessment table

| # | Surface | Hierarchy | Contrast | Spacing | Typography | Responsive | a11y | Motion | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | HealthScore card height (FB-H1/H2/H3) | pass | pass | pass | pass | pass | pass | warn (D-L5) | ship |
| 2 | HealthScore delta `?` explainer (FB-I1) | pass | pass | pass | warn | warn (D-H2) | fail (D-H2/H3/H4) | pass | fix-before-ship |
| 3 | Trends row equal-height (FB-K1/K2) | warn (D-H5) | pass | warn (D-H5) | pass | warn (D-H5) | pass | pass | fix-before-ship |
| 4 | Medication-list row shape (FB-G1) | pass | pass | warn (D-H6) | pass | fail (D-H6) | pass | pass | fix-before-ship |
| 5 | Medication-detail section header (FB-F3/F4) | pass | pass | warn (D-H8) | pass | pass | pass | pass | ship |
| 6 | Side-effects card alignment (FB-F1/F2) | pass | pass | pass | pass | warn (D-H7) | pass | pass | ship |
| 7 | Targets-page Coach icon (FB-L1) | pass | pass | pass | pass | fail (D-H1) | fail (D-H1) | pass | fix-before-ship |
| 8 | Coach launch consolidation (Inv-5) | pass | warn (D-M2) | pass | pass | warn (D-M3) | pass | pass | ship |
| 9 | Sub-page descriptions (BK-M10) | warn (D-M1) | pass | pass | pass | pass | pass | pass | ship |
| 10 | Briefing CTA variant (BK-M2) | warn (D-M4) | pass | pass | pass | pass | pass | pass | re-anchor |
| 11 | Insights tab-strip (FB-D3 adjacent) | pass | pass | warn (D-M6) | pass | pass | pass | pass | ship |

Verdict legend: `ship` = no blocker, accept Low/Medium findings as v1.4.29
backlog; `fix-before-ship` = a High finding on the surface blocks tag until
addressed; `re-anchor` = needs maintainer call before either ship or fix.

---

## Summary

The v1.4.28 user-facing diff is design-positive overall: HealthScore
height contract (FB-H1/H2/H3), medication-list unification (FB-G1),
section header collapse (FB-F3/F4), and Coach launch consolidation
(Inv-5) all land cleanly on the happy path.

Eight High findings cluster on three surfaces:
1. Delta `?` explainer (D-H2, D-H3, D-H4) — tap-target lift, span-wrapper
   drop, `aria-describedby` thread.
2. Targets Coach icon (D-H1) — `size="icon-lg"` to clear the 44 px floor.
3. Trends row (D-H5) — mood mini's residual `<Card>` border breaks the
   rhythm at 320 px.

D-H6 (FB-G1 state-badge wrap) and D-H7 (FB-F2 date-column overspec) are
narrow-viewport regressions, sub-30-line fixes each. D-H8 is a
spacing-ladder adjustment that complements the heading collapse.

Two Medium items ask for product-lead anchoring: D-M3 (tablet Coach
shape) and D-M4 (empty-state CTA convention).

Go / no-go: **GO** to ship v1.4.28, with the High findings landed as
touch-disjoint commits before tag. Medium/Low → v1.4.29 backlog. No
Critical design regressions relative to v1.4.27.
