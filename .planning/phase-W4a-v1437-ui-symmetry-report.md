# Wave W4a — UI symmetry polish bundle (v1.4.37)

## Summary

Seven small UX-audit items Marc reported against the live app
(`https://healthlog.bombeck.io`, v1.4.36). Each is a contained
class-list edit on a primitive or composite component; collectively
they tighten the visual rhythm across the dashboard, Insights,
Targets, and the global Select / Dropdown primitives.

Items owned by this wave (audit references in
`.planning/research/v1437-ux-audit.md`):

- 1 — HealthScoreCard full-height parity
- 2 — Sidebar 3-dot menu wraps "Benachrichtigungs-Center"
- 3 — Targets card 36 px dead gap below the header
- 4 — `<SelectTrigger>` chevron tighter than the date-input glyph
- 5 — Mood mini chart ~12-16 px taller than BP/Weight siblings
- 7 — Dashboard "Hinzufügen" button hugs the top on mobile
- 9 sub-bullet — TargetCard coach CTA not gated on `flags.coach`

## Commits (in landing order)

| SHA | Message |
|-----|---------|
| `96e98429` | `ui(select): chevron right-margin parity with date-picker icon` |
| `5f86d6d4` | `ui(dropdown): keep menu items single-line + widen container to w-60` |
| `b5a605cf` | `fix(insights): HealthScoreCard fills the hero-row full height` |
| `758f13ec` | `fix(targets): tighten card gap to eliminate dead space below the header` |
| `3645fe15` | `fix(insights): Mood mini chart wrapper height matches HealthChart` |
| `d0ba800d` | `ui(dashboard): centre-align Hinzufuegen button on mobile` |
| `4f7f8e7a` | `fix(targets): gate TargetCard coach CTA on global Coach flag` |
| `85590ad5` | `test(targets): pin coach CTA disappears when global flag is off` |
| `6fc9c990` | `test(insights): pin HealthScoreCard full-height contract` |

## Per-item outcome

### Item 4 — Select chevron right-margin parity

- File: `src/components/ui/select.tsx:44`
- Change: trigger horizontal padding split `px-3` → `pl-3 pr-2.5`
  + `[&_svg:last-child]:mr-1` appended.
- Effect: trailing chevron parks ~16 px from the edge, matching the
  browser-native date-input calendar glyph on Chromium. Applies to
  every `<Select>` in the app (no per-call override needed).
- Risk: the `[&_svg:last-child]` selector only matches inside the
  trigger; SelectContent's `<SelectScrollDownButton>` is portalled
  separately and is unaffected.

### Item 2 — Dropdown nowrap + sidebar w-60

- Files:
  - `src/components/ui/dropdown-menu.tsx:77` — added
    `whitespace-nowrap` to `<DropdownMenuItem>`.
  - `src/components/layout/sidebar-nav.tsx:120` — bumped sidebar
    overflow menu container from `w-56` → `w-60`.
- Effect: "Benachrichtigungs-Center" row stays one line at every
  viewport, and every other dropdown app-wide gains the same
  protection.
- Risk: an unusually long DropdownMenuItem label inside a narrow
  container could now clip rather than wrap. Acceptable for v1.4.37
  — the existing 14-rem / 12-rem containers are sized for the
  in-tree labels, and the global `overflow-x-hidden` rule on the
  content keeps the popover from breaking out.

### Item 1 — HealthScoreCard full-height parity

- File: `src/components/insights/health-score-card.tsx:259`
- Change: inner column swapped from
  `flex flex-1 flex-col gap-3` to
  `grid flex-1 grid-rows-[auto_auto_auto_auto_auto_1fr_auto] gap-3`.
- Effect: with the hero strip's `md:items-stretch` row + the card's
  existing `h-full flex flex-col`, the slack (~75-110 px on desktop)
  now collects on row 6 (the provenance accordion) instead of
  clumping under the disclaimer. The score number stays anchored at
  the top, the disclaimer at the bottom, and the card visually
  finishes at the same baseline as the left column's last chip.
- Test: new `it("uses a 7-row grid…")` in
  `health-score-card.test.tsx` pins the grid + `1fr` invariant.

### Item 3 — TargetCard gap reduction

- File: `src/components/targets/target-card.tsx:412-418`
- Change: Card override `flex h-full flex-col` →
  `flex h-full flex-col gap-3 md:gap-4`, CardHeader `gap-2 pb-3
  sm:gap-3` → `gap-2 pb-0 sm:gap-3`.
- Effect: ~36 px dead space between the metric label and the
  headline value drops to ~12-16 px so the card reads as one
  cohesive unit.
- Risk: inner CardContent rhythm is untouched (its own
  `gap-4` controls the rhythm between value, range bar, consistency
  strip, etc.); the change only affects the header-to-body gap.

### Item 5 — Mood mini chart wrapper

- File: `src/components/charts/mood-chart.tsx:548-553`
- Change: Card override `gap-1 rounded-md py-2 shadow-none` →
  `gap-0 rounded-md py-2 shadow-none`; CardHeader override
  `px-2 pb-1 [&]:gap-0.5` → `px-2 pb-1 [&]:gap-0`.
- Effect: total whitespace between title and chart strip now
  matches HealthChart mini (`pb-1` only); Mood tile renders at the
  same height as BP/Weight tiles in the trends row.
- Risk: pure within-mini-mode override; no impact on the regular
  Mood chart on `/insights/mood`.

### Item 7 — Dashboard Hinzufügen button

- File: `src/app/page.tsx:529`
- Change: `flex items-start justify-between gap-4` →
  `flex items-center justify-between gap-4 sm:items-start`.
- Effect: at < sm where the title + welcomeText wraps to two lines,
  the Hinzufügen button centres against the title block; at sm+ the
  original top-aligned posture is preserved.

### Item 9 sub-bullet — TargetCard coach gate

- File: `src/components/targets/target-card.tsx`
- Change: import `useFeatureFlags`; pair the existing `aiEnabled`
  guard at line 671 with `flags.coach`.
- Effect: when the operator disables the Coach feature flag
  globally, the per-card CTA disappears entirely (not greyed-out,
  no placeholder).
- Test: new `it("suppresses the Coach CTA when the global Coach
  flag is OFF")` + a positive control case mock the hook so both
  flag-on and flag-off branches are pinned alongside the existing
  `aiEnabled` test.
- Sister sites (`hero-strip.tsx`, `suggested-prompts.tsx`,
  `/targets` `<CoachDrawer>`) belong to W5 per the audit § Item 9.

## Tests delta

- `src/components/insights/__tests__/health-score-card.test.tsx`
  18 → 19 cases (+1 grid invariant).
- `src/components/targets/__tests__/target-card.test.tsx`
  8 → 10 cases (+2: positive control + flag-off Coach gate).

All targeted subsets green:

- `src/components/insights/**` — 357 cases pass.
- `src/components/targets/**` — 29 cases pass.
- `src/components/charts/**` — 147 cases pass.
- `src/components/ui/**` — 23 cases pass.
- `src/components/layout/**` — 14 cases pass.

## Code-review findings (self-review)

`superpowers:code-reviewer` runs through the Task tool, which isn't
available to wave-agents. I self-reviewed each diff against the
audit and ran the targeted test subsets after every commit. No
critical or important findings; suggestions captured under
"Visual regression risk" + "Out-of-file-set" below.

## Visual regression risk

- **HealthScoreCard grid** (item 1) — when the parent hero row is
  short (mobile / no Coach FAB column), the `1fr` slack row
  collapses to 0; the layout falls back to the natural flex-like
  stack. Snapshot diff in the unit test confirms the grid attrs are
  declarative. The runtime behaviour is unchanged at narrow
  viewports.
- **DropdownMenuItem nowrap** (item 2) — global change. Worst case
  is an unusually long label getting clipped in a narrow container
  (no in-tree case today).
- **TargetCard gap reduction** (item 3) — the rhythm changes
  app-wide for every TargetCard mount. The CardContent rhythm
  (`gap-4`) is untouched so the inner content stays as-is.
- **Mood mini gap reduction** (item 5) — purely mini-mode; the
  regular `/insights/mood` mount path is unaffected.

## Out-of-file-set reach

None. Every commit stayed within the file set the wave brief
declared:
- `src/components/insights/health-score-card.tsx`
- `src/components/layout/sidebar-nav.tsx`
- `src/components/ui/dropdown-menu.tsx`
- `src/components/targets/target-card.tsx`
- `src/components/ui/select.tsx`
- `src/components/charts/mood-chart.tsx`
- `src/app/page.tsx`
- `src/components/insights/__tests__/health-score-card.test.tsx`
- `src/components/targets/__tests__/target-card.test.tsx`

Two filename corrections from the wave brief vs. the audit:
- `target-card.tsx` lives in `src/components/targets/` (the brief
  pointed at `src/components/insights/target-card.tsx`).
- `mood-chart.tsx` / `health-chart.tsx` live in
  `src/components/charts/` (the brief pointed at
  `src/components/insights/`).

Both were obvious from the audit text and didn't change the
work scope.

## Hand-off to W7b

`src/app/page.tsx` saw a single `items-start` → `items-center
sm:items-start` flip on line 529. The DropdownMenu block at
lines 537-579 is untouched and W7b can extend the menu items
freely. The two existing items (`quickAddMeasurement`,
`quickAddMood`) and the `data-tour-id="dashboard-quick-add"`
attribute on the trigger button are still in place.
