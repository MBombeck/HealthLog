# v1.4.33 — Symmetry + Polish Audit

Auditor: Polish + Reliability auditor (read-only sweep)
Branch: `develop` (clean, post-v1.4.32 release)
Working dir: `/Users/marc/Projects/HealthLog`
Date: 2026-05-16

## 1. Executive summary

Maintainer complaint stack for v1.4.33: the app should "überall gleich
funktionieren und verlässlich funktionieren". The audit translates that
into five concrete buckets — viewport stability, horizontal overflow,
tile symmetry, spacing-token discipline, and z-index hygiene. Findings
were derived from a static read of `src/app/**`, `src/components/**`,
and `src/app/globals.css`. No source file was modified.

Finding counts:

| Category | Findings | High | Medium | Low |
|----------|---------:|-----:|-------:|----:|
| Viewport stability | 4 | 1 | 2 | 1 |
| Horizontal overflow | 4 | 1 | 2 | 1 |
| Tile symmetry | 6 | 2 | 2 | 2 |
| Spacing-token drift | 5 | 1 | 2 | 2 |
| Z-index / overlay hygiene | 3 | 0 | 2 | 1 |
| **Total** | **22** | **5** | **10** | **7** |

Top five wins (severity × ROI, executable in the v1.4.33 window):

1. **Adopt a single page-container token.** `AuthShell` caps at
   `max-w-[76.8rem]` (1228 px), `SettingsShell` + `AdminShell` cap at
   `max-w-screen-xl` (1280 px), `bugreport` caps at `max-w-6xl`
   (1152 px). Three different content widths on the same desktop is the
   single biggest reason the page "feels" inconsistent when the user
   switches surfaces. Normalise on `max-w-screen-xl` everywhere the
   shell already wraps the route. (One file edit; layout-stable.)
2. **Collapse the dashboard tile-strip horizontal-scroll branch into a
   responsive grid by default.** The `<sm` branch in `src/app/page.tsx`
   uses `flex overflow-x-auto` + `min-w-[10rem]` per tile, which both
   yields a deliberate side-scroll on phone widths AND clones the same
   visual contract twice (mobile-flex / desktop-grid). Replace with a
   single `grid auto-rows-fr` track that picks `minmax(min(100%,9rem),
   1fr)` from `xs:` onward; the strip wraps to two rows on Pixel 5
   instead of scrolling. The maintainer explicitly cited "unwanted
   horizontal scroll" as a polish complaint.
3. **Hoist the `min-h-[18px]` callout slot in `<TrendCard>` to a CSS
   variable.** Today the tile contract is `[--tile-h:140px]` set on the
   parent strip, but the callout's reserved slot is a hard-coded
   `min-h-[18px]` inside the card. Promote both to
   `--tile-callout-h` + `--tile-h` and the maintainer can tune the
   mobile contract once instead of touching two files.
4. **Lift the route-change scroll reset out of `<SubPageShell>` into a
   single hook.** The mother page + the shell already each issue their
   own `requestAnimationFrame → window.scrollTo({top:0})`. Two consumers
   doing the same trick is the kind of duplication that drifts; pull
   into `useResetScrollOnRouteChange()` and the maintainer's "viewport
   jumps on click" report has a single fix path.
5. **Replace `px-3.5 py-2.5` in `<SuggestedPrompts>` and the
   `<MessageThread>` chat bubbles with `px-3 py-2`.** Both call sites
   are inside content where text and avatar baselines should match the
   surrounding `gap-2` rhythm; the half-step pad lands the bubble's top
   edge 2 px below the avatar's centre line, which reads as drift on
   the v1.4.32 walk-through screenshots.

Everything below is sorted by severity, then by call-site file path so
the diff list reads linearly.

## 2. Viewport stability

### 2.1 [High] `<SubPageShell>` + `/insights/page.tsx` issue duplicate `scrollTo` on every navigation

- **File**: `src/components/insights/sub-page-shell.tsx:74-83` plus
  `src/app/insights/page.tsx:105-111`.
- **Symptom**: Two consecutive `requestAnimationFrame` callbacks fire on
  every transition between the mother page and a sub-page; the second
  callback re-scrolls the just-mounted page to the top, which on a slow
  hydrate produces the "viewport jump on click" the maintainer flagged.
- **Cause**: The mother page's effect was added in v1.4.28 (FB-D3) to
  match the shell's behaviour, but both consumers still fire. The
  shell's RAF triggers first, the mother page's RAF replays the same
  `scrollTo({top:0, behavior:"auto"})` ~16 ms later. On a fast network
  the two scrolls collapse visually, but the second `scrollTo` is what
  shows up as a "snap" on slow first paints (chart skeletons still
  inflating).
- **Fix**: Extract to `useResetScrollOnRouteChange()` and call from one
  place. The shell is the obvious owner (every routed sub-page mounts
  through it); the mother page becomes a no-op. Keep the
  `prefers-reduced-motion → behavior:"auto"` branch.

### 2.2 [Medium] Recharts hydration skeleton mismatch on the dashboard chart row

- **File**: `src/components/charts/chart-skeleton.tsx:55-57` vs.
  `src/components/charts/health-chart.tsx` (consumer pins
  `--chart-height` per breakpoint).
- **Symptom**: First paint paints a 240 px chart band; once Recharts
  resolves, the band grows to 280 px on `md+`. The 40 px delta lifts
  every chart below it on the dashboard by the same amount, which the
  user perceives as the page "rebuilding itself" after click.
- **Cause**: `<ChartSkeleton>` mirrors the `--chart-height` CSS variable
  (`var(--chart-height,240px)` / `var(--chart-height-md,280px)`), but
  the variable is never set on the document/root or on the chart band's
  own host — so the fallback wins on first paint, and the real chart
  reads `clientHeight` and renders at the intrinsic ResponsiveContainer
  size.
- **Fix**: Drop the variable indirection (no other consumer reads it)
  and inline the same `h-[240px] md:h-[280px]` contract on both the
  skeleton and the real chart's outer wrapper. Document the height
  literal in a single comment block so future chart additions copy the
  right value.

### 2.3 [Medium] Dashboard tile-strip alt-height drives the chart row baseline

- **File**: `src/app/page.tsx:1239-1264`.
- **Symptom**: When the maintainer toggles BD-Zielbereich on with
  comparison overlay active, the tile carries a callout row that
  pushes the strip 18 px taller than a "no comparison" run. The chart
  row directly beneath then slides down by 18 px without animation —
  reads as a layout pop on hot-reload.
- **Cause**: The `[--tile-h:140px]` contract applies only at `<sm`. On
  `sm:` and up the grid track uses `auto-rows-fr`, so the strip's
  height becomes a function of the tallest tile. The callout's
  `min-h-[18px]` reservation in `<TrendCard>` is honoured only on the
  rendered tile — siblings that aren't carrying a callout never grow
  their callout slot, so the row height is asymmetric.
- **Fix**: Reserve the callout slot on every tile unconditionally on
  `sm+` (drop the `sm:min-h-0` clamp at `trend-card.tsx:273` to a
  `sm:min-h-[18px]`). The visual is the same — empty whitespace —
  but the strip's intrinsic height becomes deterministic regardless
  of how many tiles render the callout.

### 2.4 [Low] `WelcomeCarousel` `scrollIntoView` competes with the parent rail's snap-x

- **File**: `src/components/onboarding/WelcomeCarousel.tsx:115-129`.
- **Symptom**: On the first auth, tapping a dot under the carousel
  triggers a `scrollIntoView({behavior:"smooth", inline:"start"})`, but
  the rail also carries `scroll-smooth` + `snap-x snap-mandatory`. The
  combination can land the rail two snap points away from the target
  if the user double-taps quickly (browser fires the second scroll
  inside the first animation's settle window).
- **Cause**: `scrollIntoView` doesn't cancel an in-flight smooth scroll
  on the parent.
- **Fix**: Add a debounce on `scrollToSlide` (300 ms; the
  reduced-motion branch already runs synchronously so doesn't need
  the guard) or switch to `rail.scrollTo({left, behavior})` so the
  rail's scroll position is set directly. The latter avoids the snap
  fight entirely.

## 3. Horizontal overflow

### 3.1 [High] Dashboard tile-strip side-scroll on phone is intentional but reads as a bug

- **File**: `src/app/page.tsx:1221-1264`.
- **Symptom**: On `<sm` the tile strip switches to `flex overflow-x-auto`
  with `min-w-[10rem]` per tile + `snap-x snap-mandatory`. The
  maintainer's complaint stack for v1.4.33 explicitly calls out the
  side scroll as unwanted — what was a v1.4.27 fix (MB7 / CF-42) is
  now a polish regression.
- **Cause**: The flex/scroll branch was chosen so the tile strip
  doesn't wrap onto 3-4 rows on Galaxy Fold (280 px viewport). But
  Pixel 5 (375 px) and iPhone-13-mini (375 px) both fit two tiles per
  row at the current `min-w-[10rem]`, so the strip wraps to two rows
  naturally if we drop `overflow-x-auto`.
- **Fix**: Lift the existing `sm:` grid contract to the default
  branch — `grid auto-rows-fr [grid-template-columns:repeat(auto-fit,
  minmax(min(100%,9rem),1fr))] gap-3`. Drop `flex snap-x
  snap-mandatory`, `[--tile-h:140px]`, `overflow-x-auto pb-2`, and
  the per-tile `min-w-[10rem] shrink-0 snap-start`. Galaxy Fold falls
  back to a single column (every tile sized at the full viewport
  width), which reads as a "tall single-column dashboard" — the same
  shape the targets and settings pages already use at that width.

### 3.2 [Medium] API-section tables force a `min-w-[760px]` body inside `overflow-x-auto`

- **File**: `src/components/settings/api-section.tsx:90`, `:290`,
  `:512` plus `src/components/settings/account-section.tsx:736`.
- **Symptom**: On desktop the API-tokens table is comfortable; on
  tablet (md breakpoint kicks in at 768 px), the table renders with
  a horizontal scrollbar because the `min-w-[760px]` floor exceeds
  the column width. The shell gives the main column at most
  `max-w-screen-xl - 220px sidebar - 32px gutters` ≈ 1028 px, which
  is fine — but the wrapper width is `100%` of an internal flex
  child, not the column. On a tablet emulator the table flickers
  between fits + scroll states.
- **Cause**: The `min-w-[760px]` is conservative against the smallest
  rendered API-tokens row (token name + last-used-at + revoke
  button). Today's data shape needs ~560 px to render legibly.
- **Fix**: Drop to `min-w-[560px]` (or `min-w-[28rem]`), then verify
  on the existing `api-section-responsive.test.tsx` fixtures that
  the mobile card list still kicks in below 640 px.

### 3.3 [Medium] `medications/page.tsx` request-example `<pre>` blocks rely on `break-all`

- **File**: `src/app/medications/page.tsx:790`.
- **Symptom**: The cURL / PowerShell / fetch example block uses
  `break-all whitespace-pre-wrap`. `break-all` happily breaks
  mid-word in URLs, which makes the example unreadable. On a
  Pixel-5 column the cURL example wraps to ~14 lines for a
  one-line command.
- **Cause**: `break-all` is too aggressive for code; the maintainer's
  v1.4.22 polish round set it to handle the worst-case
  `Authorization: Bearer …` line but the bearer token now lives on
  its own line.
- **Fix**: Use `[overflow-wrap:anywhere] whitespace-pre` so URL
  boundaries break on `/` / `?` / `&` etc., not mid-word, and a
  long shell line scrolls horizontally inside its own `<pre>`
  rather than rewrapping every word.

### 3.4 [Low] Privacy + about pages constrain to `max-w-3xl` while the rest of the app uses `max-w-screen-xl`

- **File**: `src/app/privacy/page.tsx:111`, `:129`;
  `src/app/about/page.tsx:68`, `:86`.
- **Symptom**: On wide desktop the legal pages render in a 768 px
  column; the marketing/landing impression is "the legal page is
  cramped relative to the dashboard". Not strictly an overflow bug,
  but the same family of complaint.
- **Cause**: Long-form legal text reads better in a narrow column; the
  intentional choice predates the v1.4.20 max-width audit.
- **Fix**: Leave the 3xl cap (legal-text best practice) but document
  it in a comment so future contributors don't "fix" it. Optionally
  bump to `max-w-4xl` (896 px) — still legible, less cramped.

## 4. Tile symmetry

### 4.1 [High] Dashboard tile + chart cards use different padding tokens

- **File**: `src/components/charts/trend-card.tsx:199` (`p-4 md:p-6`)
  vs. `src/components/charts/chart-skeleton.tsx:36-39` (`p-4 md:p-6`)
  vs. `src/components/insights/correlation-card.tsx` (shadcn
  `<Card>` defaults to `p-6`) vs.
  `src/components/insights/daily-briefing.tsx:260` (shadcn `<Card>`,
  `<CardHeader pb-3>` + `<CardContent>` default padding).
- **Symptom**: Tiles and charts on the dashboard share an outer
  card-padding contract (`p-4 md:p-6`), but correlation cards and
  the daily-briefing card use the shadcn `<Card>` default, which is
  `gap-6 py-6 px-6` plus `<CardHeader pb-3>`. Side by side on
  `/insights`, the spacing reads "the chart card is denser than the
  briefing card" — uneven density.
- **Fix**: Normalise on a single `card-pad` utility class (or a CSS
  custom property on the shadcn Card token) so every card surface
  paints with the same vertical rhythm. Concrete: bump the shadcn
  `<Card>` defaults in `components/ui/card.tsx` to `p-4 md:p-6`
  and let the insights consumers opt into the legacy `p-6` via an
  explicit class where they want it.

### 4.2 [High] Settings/admin shells diverge from the dashboard container

- **File**: `src/components/layout/auth-shell.tsx:157` (outer
  container is `max-w-[76.8rem]`), `src/components/settings/settings-shell.tsx:144`
  + `src/components/admin/admin-shell.tsx:165` (both `max-w-screen-xl`).
- **Symptom**: Moving from `/` → `/settings/account` on a
  1440 px-wide laptop shifts the content frame from 1228 px to
  1280 px, a 52 px jump. The header dropdown and the bottom-nav
  centre stay still; everything between them slides outward, which
  reads as "the page is wobbling".
- **Cause**: `max-w-[76.8rem]` (1228 px) is a v1.4.x legacy value
  predating the shell-level adoption of `max-w-screen-xl`. The
  settings/admin shells were carved out later and picked the
  tailwind token instead of matching the parent.
- **Fix**: Lift the outer container to `max-w-screen-xl` in
  `auth-shell.tsx:157`. Re-check the dashboard tile grid + chart
  row widths at 1280 px (the grid `auto-fit` happily uses the extra
  52 px; nothing reflows beyond a wider gutter).

### 4.3 [Medium] `<TrendsRow>` and `<CorrelationRow>` row contracts differ

- **File**: `src/components/insights/trends-row.tsx:108` (`grid
  auto-rows-fr grid-cols-1 gap-4 md:grid-cols-3`) vs.
  `src/components/insights/correlation-row.tsx:60-64` (`grid
  grid-cols-1 gap-4 md:grid-cols-2` conditional).
- **Symptom**: Trends row pins to 3 columns on `md+`; correlation
  row dynamically picks 1 or 2 columns. On the insights overview a
  2-up correlation row above a 3-up trends row renders with
  different column tracks at the same breakpoint — visually two
  different design systems.
- **Fix**: Standardise on `grid auto-rows-fr grid-cols-1 md:grid-cols-2
  lg:grid-cols-3` for every "row of cards" on `/insights`, and let
  cells span where needed (e.g. correlation cards with only one ok
  result span the full width via `md:col-span-2 lg:col-span-3`).
  Removes the "is this row 2-up or 3-up?" cognitive cost.

### 4.4 [Medium] BD-Zielbereich tile sub-row count varies by user state

- **File**: `src/components/charts/trend-card.tsx:300-377` + the BD
  tile call site at `src/app/page.tsx:879-916`.
- **Symptom**: Most tiles render two sub-rows (`7d` + `30d`).
  BD-Zielbereich also feeds a synthetic `trend7Delta` that adds a
  parenthetical `(+N)` next to the `7d:` value, which can overflow
  the sub-row to a second line on Galaxy Fold. The tile then grows
  taller than its siblings.
- **Cause**: The `overflow-hidden flex-nowrap` clamp on the sub-row
  pair was added in v1.4.29 to keep the contract at 140 px on
  mobile, but the clamp also clips a legitimate `(+N)` mid-character
  when the cell is narrow.
- **Fix**: Drop the `trend7Delta` text when the cell is below an
  inline-budget — render the value-only and rely on the headline
  arrow to convey direction. Or replace the parenthetical with an
  icon-only `↗ +N`, which doubles the visual density without
  expanding the line budget.

### 4.5 [Low] Workouts tile-strip empty-state diverges from the others

- **File**: `src/components/dashboard/recent-workouts-tile.tsx` (new
  in v1.4.32) — render flow uses an "onboarding hint" empty state
  rather than the EmptyState primitive that BP/weight tiles use.
- **Symptom**: A new account browsing the dashboard sees the
  workouts tile with its own visual language while the rest of the
  tile strip is data-empty (and therefore hidden).
- **Fix**: Either gate the workouts tile behind the same
  data-floor logic as the others (`hasWorkouts > 0`) or move the
  onboarding hint into the canonical `<EmptyState>` component so
  all empty surfaces share a single layout.

### 4.6 [Low] `<HealthScoreCard>` paint-shift on `md+`

- **File**: `src/components/insights/hero-strip.tsx:166-172`,
  `src/components/insights/health-score-card.tsx` (length ~520
  lines).
- **Symptom**: The hero strip's `md:items-stretch` contract pulls
  the right-column score card to match the left-column title
  block height. When the briefing paragraph wraps to 3 lines vs.
  2 lines, the score card grows / shrinks by ~24 px on the next
  render — visible as a "card breathing" on the route refetch.
- **Fix**: Pin the score-card host to `md:min-h-[280px]` and let
  the briefing column grow downward into a `flex-1` slot.

## 5. Spacing-token discipline

### 5.1 Half-step token sprawl

Frequency counts (rg over `src/components`, excluding tests):

| Token family | Uses | Notes |
|--------------|-----:|-------|
| `gap-1.5` / `py-1.5` / `px-1.5` | 71 | Concentrated in icon-button hit areas, suggested-prompt chips |
| `py-2.5` / `px-2.5` | 38 | Mostly inside the Coach panel; mixed with `px-3` on siblings |
| `gap-2.5` | 14 | Coach drawer header + message thread |
| `px-3.5` / `py-3.5` | 4 | `<SuggestedPrompts>` + chat bubbles + medication form card padding |
| `p-3.5` | 2 | `medications/medication-form.tsx:678, :763` |

Half-step tokens make sense for icon-button density (the `min-h-11`
hit area absorbs the visual drift). They drift inside content blocks
where a sibling text line uses `py-2` or `py-3` — the eye picks up
the 2 px misalignment instantly.

Recommended normalisations:

- **Coach message bubbles** (`message-thread.tsx:367, :433`): drop
  `px-3.5 py-2.5` to `px-3 py-2` to match the avatar's
  `gap-2.5` rhythm.
- **Suggested-prompt chips** (`suggested-prompts.tsx:74`): drop
  `px-3.5 py-2` to `px-3 py-2`; pair with `text-sm` instead of
  `text-[13px]`.
- **Medication-form inner cards** (`medication-form.tsx:678, :763`):
  drop `p-3.5` to `p-4` so the card padding matches every other
  card on the page.

### 5.2 Arbitrary `min-h-[…]` and `h-[…]` clusters

20 distinct `min-h-[…]` literals + 8 distinct `h-[…]` literals across
`src/`. Worst offenders:

| Token | Count | Files |
|-------|------:|-------|
| `min-h-[300px]` | 3 | `trends-row.tsx` (three card cells, repeated) |
| `min-h-[18px]` | 1 | `trend-card.tsx` callout slot |
| `min-h-[88px]` | 1 | `GoalsChipPicker.tsx` chip cell |
| `min-h-[64px]` | 1 | `vo2-max-chart-row.tsx` chip floor |
| `min-h-[100svh]` | 2 | `onboarding/layout.tsx` + `OnboardingShell.tsx` |
| `min-h-[calc(100dvh-12rem)]` | 2 | `settings-shell.tsx` + `admin-shell.tsx` |
| `h-[180px]` | 2 | correlation-card skeleton + host-metrics chart skeleton |
| `h-[var(--chart-height,240px)]` | 1 | chart-skeleton fallback (see 2.2) |

Recommended normalisations:

- **Adopt a `--tile-h` / `--card-h-min` design-token pair** in
  `globals.css` (`:root { --tile-h: 140px; --card-min: 300px; }`)
  and replace every arbitrary `min-h-[…]` with `min-h-[var(--…)]`.
  One file controls the contract.
- **Collapse the three identical `md:min-h-[300px]` literals** in
  `trends-row.tsx` to a single class on the parent grid:
  `[&>div]:md:min-h-[var(--card-min)]` (or just `min-h`).

### 5.3 Card-radius inconsistency

`rounded-xl` is the dashboard tile / chart / settings card token.
`rounded-lg` is the workout list, onboarding chips. `rounded-md` is
the daily-briefing key-finding row, trend annotations, and the
recommendation expanded card. The visual reads as "three different
card languages on the same page".

- **Fix**: Promote `rounded-xl` to outer cards, `rounded-lg` to
  inner cards / nested surfaces, and `rounded-md` only to
  utility surfaces (Skeleton, code blocks). Audit the insights
  surface once.

### 5.4 Off-token `text-[13px]` and `text-[10px]` cluster

| Token | Count |
|-------|------:|
| `text-[13px]` | 2 |
| `text-[11px]` | 14 |
| `text-[10px]` | 9 |

Tailwind v4 ships `text-xs` (12 px), `text-sm` (14 px), `text-[10px]`
and `[11px]` and `[13px]` are all literal escapes. The maintainer's
v1.4.22 polish round already trimmed the worst of these; the
remaining cluster is in `<HealthScoreCard>` (delta caption, component
weight chips), `<CorrelationCard>` (confidence pill), and
`<DailyBriefing>` (key-findings title).

- **Fix**: Define `--text-2xs: 11px` in `globals.css` as the canonical
  "smaller than xs" size; rewrite the 14 call sites against the
  variable. Drop `text-[13px]` to `text-sm` (lose 1 px; not
  user-visible).

### 5.5 `auth-shell` container width is itself off-grid

Reiterating from 4.2 because it bridges into spacing discipline:
`max-w-[76.8rem]` = 1228.8 px. Tailwind's nearest token is
`max-w-screen-xl` (1280 px) or `max-w-7xl` (1280 px). The 1228 px
value reads as "someone measured a Figma frame once and pasted the
literal". Normalise on `max-w-screen-xl`.

## 6. Z-index / overlay hygiene

The stack is sane on the whole. Findings:

### 6.1 [Medium] Multiple `z-50` siblings rely on render-order tie-breaking

- `src/components/ui/dialog.tsx:42, :70` (overlay + content both `z-50`)
- `src/components/ui/alert-dialog.tsx:39, :61` (same shape)
- `src/components/ui/sheet.tsx:39, :63` (overlay + content)
- `src/components/ui/tooltip.tsx:45, :51` (content + arrow)
- `src/components/ui/popover.tsx:44`
- `src/components/ui/dropdown-menu.tsx:45, :233`
- `src/components/ui/select.tsx:65`

All of these portals share the same `z-50` and rely on Radix's
portal mount order to stack correctly. The only explicit-higher
z-index is the bottom-nav (`z-50`) and the top-bar (`z-40`) — i.e.
the bottom-nav can stack on top of an open dropdown when the
dropdown content's portal is mounted before the bottom-nav
re-renders. Not seen in production but the contract is fragile.

- **Fix**: Adopt a documented z-scale in `globals.css`:
  `--z-nav: 40; --z-overlay: 50; --z-popover: 60; --z-toast: 70;
  --z-tour: 100;` and rewire every consumer. Today's
  `z-[100]` (skip-link), `z-[200]` (tour) are off-scale outliers.

### 6.2 [Medium] Coach FAB sits at `z-40` underneath the bottom-nav

- **File**: `src/components/insights/layout-coach-fab.tsx:46`
  (`fixed right-4 bottom-20 z-40`).
- **Symptom**: The FAB is positioned at `bottom-20` (5 rem) so it
  visually clears the 4-rem bottom-nav, but its `z-40` matches the
  top-bar and falls underneath the `z-50` bottom-nav. If the FAB
  ever migrates closer to the nav (or the user has a different
  safe-area inset), the bottom-nav backdrop-blur covers it.
- **Fix**: Bump to `z-50` to match the bottom-nav, or to the
  proposed `--z-popover` (60) so it lives above the nav strip
  unambiguously.

### 6.3 [Low] Sticky insights tab strip sits at `z-30`

- **File**: `src/components/insights/insights-tab-strip.tsx:186`
  (`sticky top-0 z-30`).
- **Symptom**: At `z-30` the strip is below the top-bar (`z-40`)
  and above page content — correct for the desktop layout. On
  mobile the top-bar is also `z-40` so the strip slides under it
  cleanly. The hard-coded value is fine; my concern is that the
  scale documentation is missing.
- **Fix**: Same documented z-scale (`--z-sticky: 30`). No
  behavioural change.

## 7. Punch list — ordered by severity × ROI

A practical v1.4.33 work order. Each entry is one file edit, one
test update, and re-snapshot. Cumulative line count: ≤120 lines.

1. **[High][P1]** Unify outer page container: `auth-shell.tsx:157` ⟶
   `max-w-screen-xl`. Snapshot: dashboard / settings / admin at
   1440 px. (Section 4.2.)
2. **[High][P1]** Drop dashboard tile-strip mobile horizontal scroll:
   collapse to a single responsive grid in
   `src/app/page.tsx:1221-1264`. Drop `[--tile-h:140px]`, restore
   wrap. (Section 3.1.)
3. **[High][P2]** Hoist scroll-reset to a hook; remove duplicate
   from `src/app/insights/page.tsx:105-111`. (Section 2.1.)
4. **[High][P2]** Normalise card paddings: bump shadcn `<Card>`
   defaults to `p-4 md:p-6`; audit `daily-briefing.tsx` +
   `correlation-card.tsx` for consistent footprint. (Section 4.1.)
5. **[Medium][P2]** Reserve callout slot on `sm+` so the strip
   height is deterministic: `trend-card.tsx:273` drop the
   `sm:min-h-0` clamp. (Section 2.3.)
6. **[Medium][P3]** Reduce `min-w-[760px]` floor on API-tokens
   tables to `min-w-[28rem]`; re-verify
   `api-section-responsive.test.tsx`. (Section 3.2.)
7. **[Medium][P3]** Replace `break-all` with
   `[overflow-wrap:anywhere]` on the medications request-example
   `<pre>`. (Section 3.3.)
8. **[Medium][P3]** Normalise row-grid contracts on `/insights`:
   trends-row + correlation-row + recommendations-grid land on the
   same `md:grid-cols-2 lg:grid-cols-3` shape. (Section 4.3.)
9. **[Medium][P4]** Bubble + chip spacing tokens: drop `px-3.5
   py-2.5` to `px-3 py-2` in suggested-prompts + chat bubbles +
   medication-form inner cards. (Section 5.1.)
10. **[Medium][P4]** Promote Coach FAB to `z-50`. (Section 6.2.)
11. **[Low][P4]** Adopt the documented z-scale + spacing-token
    `:root` variables in `globals.css`; rewire `min-h-[…]`
    arbitrary literals. (Sections 5.2, 5.3, 6.1, 6.3.)
12. **[Low][P5]** Stabilise chart-skeleton fallback height: drop the
    `var(--chart-height,…)` indirection and use literal
    `h-[240px] md:h-[280px]`. (Section 2.2.)
13. **[Low][P5]** Debounce `scrollToSlide` in `WelcomeCarousel`.
    (Section 2.4.)
14. **[Low][P5]** Stretch `<HealthScoreCard>` to a documented
    `md:min-h-[280px]`. (Section 4.6.)
15. **[Low][P5]** Document the legal-page narrow-column choice
    (`privacy/page.tsx` + `about/page.tsx`); leave the `3xl` cap.
    (Section 3.4.)
16. **[Low][P5]** Decide on the workouts-tile empty-state shape:
    either hide on empty (data-floor) or migrate to the shared
    `<EmptyState>`. (Section 4.5.)

That's the v1.4.33 polish surface in one ordered list. Items 1-5
deliver the bulk of the perceived reliability win; items 6-10 close
the long tail; the rest are documentation + cleanup.
