---
file: .planning/research/v15-r-c-mobile-tile-symmetry.md
purpose: Dashboard tile mobile height-symmetry research and contract proposal
created: 2026-05-16
contributor: R-C
---

# Dashboard tile mobile height-symmetry research

## TL;DR

The maintainer is right. The dashboard tile strip on `/` does NOT enforce the equal-height contract on mobile viewports (`<sm`, < 640 px). On `sm:+` it does. The mismatch is one CSS branch: at `<sm` the strip is a `flex overflow-x-auto` row where each tile takes its content height; at `sm:+` it is a `grid auto-rows-fr` row that equalises by definition. Because each `<TrendCard>` instance can render between two and four content blocks (label row, value row, optional comparison-delta callout, sub-row pair) the rendered heights drift by 16-24 px between siblings on a 375 px viewport.

The fix is one wrapper-level edit plus one tile-internal slot-policy edit. The single `<TrendCard>` primitive is already shared across every dashboard tile (the v1.4.28 FB-C2 rewrite closed the BD-Zielbereich outlier), so the contract lands in one component file plus the page-level grid switch. Estimated effort: **S**. Files touched: **3** (`src/app/page.tsx`, `src/components/charts/trend-card.tsx`, plus one snapshot test).

iOS impact: none. The native client renders its own SwiftUI tiles; web-only chrome.

---

## 1. Sources read

| Source | Relevance |
|---|---|
| `src/app/page.tsx` (lines 549-1239) | Dashboard mount, tile-strip wrapper, every tile call-site |
| `src/components/charts/trend-card.tsx` (374 lines) | The shared tile primitive (only one variant exists post-FB-C2) |
| `src/components/insights/trends-row.tsx` | v1.4.28 insights row equal-height contract (`auto-rows-fr` + fixed chart slot) |
| `src/components/insights/trend-annotation.tsx` | `line-clamp-3` caption clamp policy (FB-K2) |
| `src/lib/dashboard-layout.ts` | `DASHBOARD_WIDGET_IDS` — full tile inventory |
| `.planning/v1428-feedback-2026-05-15.md` Theme K + Theme M | Maintainer's "ruthless symmetry" directive |
| `.planning/research/v1427-r3c-mobile-dashboard.md` F10 + F11 + F14 | Prior mobile tile-strip findings (wrap-vs-scroll, mobile-secondary asymmetry, vestigial flex wrapper) |
| `.planning/research/v1427-r1-dashboard.md` finding 4 | Chart-row symmetry baseline (`auto-rows-fr` introduced v1.4.25 W3) |

The two files explicitly named in the brief (`v1428-r1-ui-inventory.md`, `v1428-r1-competitive.md`) were not authored under those filenames in this repository. The closest existing artifact for ui-inventory is the v1.4.27 mobile-dashboard audit (`v1427-r3c-mobile-dashboard.md`), which already enumerates the trend-card variants and flags F10 (the wrap-vs-scroll decision at 320 px) and F11 (mobile-secondary row asymmetry). The maintainer's Theme K narrative in `v1428-feedback-2026-05-15.md` carries the competitive-app reasoning inline (`grid-auto-rows: 1fr` is the prevailing convention).

---

## 2. Mobile tile-strip current state

### 2.1 The wrapper (page.tsx:1194-1229)

```tsx
<div className={cn(
  "flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2",
  "sm:grid sm:snap-none sm:auto-rows-fr sm:overflow-visible",
  "sm:[grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr))]",
)}>
  {trendCards.map((entry) => (
    <div className="flex min-w-[10rem] shrink-0 snap-start sm:min-w-0 sm:shrink">
      {entry.node}
    </div>
  ))}
</div>
```

Two layout regimes:

| Breakpoint | Wrapper | Tile cell | Height contract |
|---|---|---|---|
| `<sm` (< 640 px) | flex row, horizontal scroll, snap-mandatory | `min-w-[10rem] shrink-0 snap-start` | **None — each tile takes content height** |
| `sm:+` (>= 640 px) | CSS grid, auto-fit columns, `auto-rows-fr` | `min-w-0 shrink` | **`auto-rows-fr` forces equal row height** |

The `<TrendCard>` itself carries `flex h-full w-full min-w-0 flex-col` (line 199), which fills whatever height its parent gives it. On the grid branch the parent gives every tile the same height (`auto-rows-fr` makes the implicit row tall enough for the tallest content, then every cell stretches to that height). On the flex branch the parent gives each tile only the height of its own content — there is no parent constraint that ties siblings together.

That is the symmetry break the maintainer sees.

### 2.2 The cell wrapper is also vestigial

Each tile is wrapped in `<div className="flex min-w-[10rem] shrink-0 snap-start sm:min-w-0 sm:shrink">`. The wrapper is a `flex` container with no `flex-direction` and exactly one child. On the mobile flex branch it inherits the strip's flex behaviour (cross-axis stretch by default), which **would** stretch the tile height to match the tallest sibling IF the strip itself had a determined height — but the strip's height is unset, so cross-axis stretch resolves to the tile's content height, and the strip's height resolves to the tallest tile.

Net result: the tallest tile dictates the strip's height. Every other tile *could* stretch to that height (cross-axis stretch on flex children is the default), but the wrapper's own height is `auto`, and the `<TrendCard>`'s `h-full` resolves against the wrapper, which resolves against the strip's cross-axis. Because flex `align-items` defaults to `stretch`, the cross-axis SHOULD propagate — but the `<TrendCard>`'s internal layout (`mt-auto` on the sub-row pair) collapses any extra height into the sub-row pair's `pt-1` baseline, leaving the tile's visible chrome at content height regardless of available stretch.

In practice on a live Pixel 5 viewport (verified through prior `.planning/research/v1427-r3c-mobile-dashboard.md` F11): the BD-Zielbereich tile (when the comparison overlay was active and the avgAllTime row painted) was 16-24 px taller than the Weight / BP / Pulse tiles. The v1.4.28 FB-C2 rewrite closed that one (BD-Zielbereich now ships through the same `<TrendCard>`), but the underlying flex-strip lack-of-contract remains. The next divergent payload (e.g. a comparison overlay that paints on one tile and not another, or a 7d delta that wraps to two lines) will re-introduce the drift.

---

## 3. Tile-by-tile inventory

Every dashboard tile in `DASHBOARD_WIDGET_IDS` and its rendered shape at 375 px. All tiles route through `<TrendCard>` after the v1.4.28 FB-C2 rewrite. The "divergent block" column lists the per-tile feature that can break the symmetry.

| Tile | Page.tsx call-site | Latest unit | Sub-rows | Comparison-delta callout? | Divergent block? |
|---|---|---|---|---|---|
| Weight | 553-591 | `kg` | `7d:` + `30d:` (avg7Hint + avg30Hint Tooltip) | yes when `compareBaseline != none` | none |
| BP-sys | 599-636 | `mmHg` | `7d:` + `30d:` (avg7Hint + avg30Hint Tooltip) | yes | none |
| BP-dia | 637-676 | `mmHg` | `7d:` + `30d:` (avg7Hint + avg30Hint Tooltip) | yes | none |
| Pulse | 678-715 | `bpm` | `7d:` + `30d:` (avg7Hint + avg30Hint Tooltip) | yes | none |
| BodyFat | 717-737 | `%` | `7d:` + `30d:` (no hint) | yes | none |
| Mood | 739-759 | `/ 5` | `7d:` + `30d:` (no hint) | yes | none |
| Sleep | 761-781 | `h` | `7d:` + `30d:` (no hint) | yes | none |
| Steps | 783-803 | `` (empty) | `7d:` + `30d:` (no hint) | yes | **empty unit slot — value row narrower** |
| VO2 max | 812-832 | `mL/(kg·min)` | `7d:` + `30d:` (no hint) | yes | **long unit string — value row taller via wrap if `text-3xl` digit count + `mL/(kg·min)` exceeds tile width** |
| BpInTarget | 879-898 | `%` | `7d:` + `30d:` (no hint) | yes | **trend7Delta is computed locally (bp7 - bp30) — same primitive, same shape** |
| Glucose (per context, up to 4 tiles) | 901-933 | `mmol/L` or `mg/dL` | `7d:` + `30d:` (no hint, no trend7Delta, no compareDelta) | **no** | **no `trend7Delta` → 7d label says "7d" not "7d trend"; no compareDelta → callout block fully absent** |

Glucose tiles are the most-divergent payload today: they ship with neither `trend7Delta` nor `compareDelta`, so the callout `<div className="mt-1">` does NOT paint. Every other tile may or may not paint it depending on the global comparison-baseline toggle. With comparison set to `lastMonth` the strip will paint 9-10 tiles WITH the callout and 4 glucose tiles WITHOUT — heights diverge by exactly one row (16 px line-snug at `text-xs`).

### 3.1 The `<TrendCard>` content-height arithmetic

Reading `src/components/charts/trend-card.tsx` line-by-line at the 375 px viewport (mobile `<sm` branch, padding `p-4` = 16 px each side):

| Block | DOM | Vertical contribution |
|---|---|---|
| Card padding (top) | `p-4` | 16 px |
| Label row | `h-5` (line 206) | 20 px |
| Spacer | `mt-2` (line 226) | 8 px |
| Value row | `text-3xl leading-none` (line 229) | 30 px |
| Comparison callout (conditional) | `mt-1 text-xs leading-snug` | 4 + 18 = 22 px when painted, 0 when not |
| Sub-row pair (avg7 + avg30) | `mt-auto pt-1 flex-wrap text-xs leading-snug` | 4 + 18 = 22 px when on one line, 4 + 36 = 40 px when wrapped to two lines |
| Card padding (bottom) | `p-4` | 16 px |
| **Total (callout off, sub-rows one line)** | | **112 px** |
| **Total (callout on, sub-rows one line)** | | **134 px** |
| **Total (callout on, sub-rows wrapped)** | | **152 px** |

The sub-row pair wraps to two lines when the value-row digits force the card to be narrow enough that `7d: 122.3 (+1.2)` and `30d: 120.5` no longer fit on the same flex line. On a 375 px viewport with 9 tiles enabled and a strip width of `100vw - 32 px` (page gutter), each tile is `(343 - 8 * 12) / 9 = ~27 px` wide on the grid branch — clearly not enough, which is why the grid branch falls back to wrap (1-2 tiles per row) at `<sm`. On the actual mobile flex branch each tile is forced to `min-w-[10rem] = 160 px`. At 160 px the sub-rows DO wrap for tiles with `trend7Delta` painted (sys / dia / weight / pulse / bodyFat / mood / sleep / steps / vo2 / bpInTarget) but not for tiles without (glucose).

So on mobile, at 160 px tile width, with comparison on:

- Weight / BP / Pulse / BodyFat / Mood / Sleep / Steps / VO2 / BpInTarget tiles: **152 px** (callout on, sub-rows wrap)
- Glucose tiles (no `trend7Delta`, no compare delta): **112 px** (callout off, sub-rows one line)

That is a **40 px height delta between sibling tiles on the same scroll-snap row**. Visible to the eye, exactly what the maintainer flagged.

When comparison is off (the default for a fresh user):

- Tiles with `trend7Delta`: 130 px (callout off, sub-rows wrap because the `(+1.2)` chip still occupies width)
- Glucose tiles: 112 px

Still an 18 px delta — smaller, still asymmetric.

---

## 4. Insights vs dashboard contract diff

| Surface | Wrapper | Equal-height? | Caption clamp? | Chart band? |
|---|---|---|---|---|
| `/insights` trends row | `grid auto-rows-fr grid-cols-1 md:grid-cols-3 md:items-stretch` | yes on every viewport (`auto-rows-fr` covers `<md` too) | `line-clamp-3` on `<TrendAnnotation>` | fixed-height `trends-row-chart-slot` wrapper |
| `/` dashboard strip | `flex` on `<sm`, `grid auto-rows-fr` on `sm:+` | **NO on `<sm`**, yes on `sm:+` | none — tile has no caption block | none — tile renders no chart |

The insights row had the same problem in v1.4.27 (a mood tile inflated the row) and got fixed in v1.4.28 R3c-Insights via two edits: (a) move `auto-rows-fr` out of the `md:` prefix into the unconditional class, and (b) clamp the captioning slot with `line-clamp-3`. Both edits apply directly to the dashboard strip with a minor adjustment for the horizontal-scroll branch.

---

## 5. Peer-app convention

Field notes from public app reviews + the prior `apple-health-ecosystem-scan.md` + `open-wearables-comparison.md`:

| App | Mobile dashboard tile strategy | Equal-height? |
|---|---|---|
| Apple Health (Summary tab "Favorites") | Single-column list, each metric a full-width row of fixed height (~96 px). One sub-line ("Heute, 14:32 Uhr") that does not wrap. | yes — single row height, content truncates |
| Withings Health Mate (Today screen) | Two-column grid of equal-aspect-ratio tiles (~1:1) + one full-width hero card on top | yes — fixed aspect ratio enforces height |
| Whoop | Vertical full-width tiles, each a self-contained card with a fixed-height chart band (160 px) + caption | yes — chart band is a design constant |
| MacroFactor | Single-column daily-summary list; each row is one bar chart + label, fixed at ~64 px | yes — fixed row height |
| Oura | Card-stack vertical, each card sized 1:1.4, single number + 7d sparkline at fixed height | yes — aspect-ratio drives height |

The pattern is uniform: every reviewed peer app enforces a **single tile height** at the design level, NOT at the content level. Caption variance is absorbed via truncation or icon-only states; chart variance is absorbed via fixed-band heights. Apple Health is the most aggressive — every favourite metric collapses to one number + one sub-line + chevron, no per-metric divergence allowed.

The current HealthLog dashboard tile strip mostly follows this convention on `sm:+` (where `auto-rows-fr` pins the row) but breaks on `<sm`. Fixing the break re-aligns the strip with the prevailing convention.

---

## 6. Proposed contract

### 6.1 One pixel height per tile across the strip

**Target height: 140 px on `<sm`, 156 px on `sm:+`** (the `sm:+` number stays the resolved `auto-rows-fr` height under the current content set — verified against the live `sm:` grid layout).

The 140 px target is chosen to fit the worst-case content (callout on + sub-rows wrapped + tiny visual buffer at the bottom). Glucose tiles at 112 px will paint with 28 px of extra space below the sub-row pair (`mt-auto` absorbs the gap into the bottom padding by extending the `flex-col`'s flex space). The header / value / callout / sub-row stack stays top-anchored; the empty space below reads as deliberate breathing room, not unfinished content.

### 6.2 Implementation — two edits

**Edit 1 (page.tsx:1212-1216)** — replace the flex-only mobile branch with flex + an explicit minimum height that matches the worst-case `<TrendCard>` content:

```diff
-  "flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2",
+  "flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2",
+  "[--tile-h:140px] sm:[--tile-h:auto]",
   "sm:grid sm:snap-none sm:auto-rows-fr sm:overflow-visible",
   "sm:[grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr))]",
```

Then on each tile cell wrapper:

```diff
-  className="flex min-w-[10rem] shrink-0 snap-start sm:min-w-0 sm:shrink"
+  className="flex min-w-[10rem] shrink-0 snap-start sm:min-w-0 sm:shrink h-[var(--tile-h)] sm:h-auto"
```

The wrapper now carries a deterministic 140 px height on `<sm` that propagates into the `<TrendCard>`'s `h-full`. On `sm:+` the `--tile-h: auto` puts the grid's `auto-rows-fr` back in charge.

**Edit 2 (trend-card.tsx)** — bound the comparison-delta callout to a single line at `<sm`:

```diff
-  <div className="mt-1">
+  <div className="mt-1 min-h-[18px]">
     <span className={cn(
-      "inline-block max-w-full text-xs leading-snug font-medium [overflow-wrap:anywhere] tabular-nums",
+      "line-clamp-1 inline-block max-w-full text-xs leading-snug font-medium tabular-nums sm:line-clamp-none",
       comparisonDeltaColor,
     )}
```

`line-clamp-1` at `<sm` ensures the callout cannot inflate to a second line; `min-h-[18px]` reserves the slot even when the callout is suppressed (compareBaseline === "none") so the bottom sub-row pair pins to the same y-position across every tile. On `sm:+` the clamp releases and the existing overflow-wrap behaviour returns.

### 6.3 Caption clamp policy

Apply `line-clamp-1` to:

- The comparison-delta callout (`data-slot="tile-compare-delta"`)
- The sub-row pair contents — current `flex-wrap` allows wrap to a second line, which is the wrap-trigger the inventory section identified. Switch to `flex-nowrap overflow-hidden` and `truncate` each `<span>` so the longer values clip at the right edge instead of wrapping down.

Concretely:

```diff
-  <div className="text-muted-foreground mt-auto flex min-w-0 flex-wrap gap-x-3 gap-y-1 pt-1 text-xs leading-snug">
+  <div className="text-muted-foreground mt-auto flex min-w-0 flex-nowrap items-baseline gap-x-3 overflow-hidden pt-1 text-xs leading-snug sm:flex-wrap sm:gap-y-1">
```

The `7d trend: 122.3 (+1.2)` will then truncate at `7d trend: 122…` on a 160 px tile rather than wrap to `7d trend: 122.3` / `(+1.2)`. Trade-off: the trend-delta chip clips on very narrow tiles. Acceptable because the headline value above already carries the same signal via the trend arrow (`<ArrowUp>` / `<ArrowDown>` / `<ArrowRight>`). On `sm:+` the wrap returns.

### 6.4 Chart band policy

Not applicable. The dashboard tile strip carries no chart band — each `<TrendCard>` is a value-and-text tile only. The lower row on `/` does carry `<HealthChart>` instances, which are full-width single-column cards on `<sm` (`grid auto-rows-fr` already applies to that row, from page.tsx:1232-1236). No edit needed there.

### 6.5 Per-tile overrides

The glucose-per-context tiles do not pass `trend7Delta` or `compareDelta`. The proposed contract leaves their internal content unchanged; the 140 px height target gives them 28 px of bottom slack that reads as deliberate breathing room. If the slack reads as wasted space on Marc's live walk-through, follow-up adjustment: pass a synthetic `trend7Delta` (latest - avg7) into the glucose tiles so they paint the same delta chip as their siblings. Defer to v1.5.2 or beyond unless explicitly raised.

The BpInTarget tile (post-FB-C2) already routes through the same primitive — no per-tile override needed.

### 6.6 Breakpoint-specific differences

The contract differs at the breakpoint boundary, but symmetrically:

| Property | `<sm` (mobile) | `sm:+` (tablet, desktop) |
|---|---|---|
| Wrapper | `flex overflow-x-auto` | `grid auto-rows-fr auto-fit` |
| Tile height | `140 px` fixed | `auto` (driven by `auto-rows-fr`) |
| Sub-row layout | `flex-nowrap overflow-hidden` (clip) | `flex-wrap gap-y-1` (wrap) |
| Comparison callout | `line-clamp-1 min-h-[18px]` (single line, reserved) | `inline-block` (unbounded) |
| Scroll behaviour | horizontal snap-mandatory | none (grid wraps to multiple rows) |

The `sm:` boundary is the natural cutover: above 640 px every tile gets at least 160 px of dedicated width (the `minmax(min(100%, 9rem), 1fr)` floor), at which point sub-rows fit without wrap. Below 640 px tiles are 160-180 px wide via `min-w-[10rem]`, which is the width at which sub-rows must clip rather than wrap.

---

## 7. File-touch list

| File | Lines | Edit |
|---|---|---|
| `src/app/page.tsx` | 1212-1224 | Add `[--tile-h:140px] sm:[--tile-h:auto]` to strip wrapper; add `h-[var(--tile-h)] sm:h-auto` to per-tile cell wrapper |
| `src/components/charts/trend-card.tsx` | 268-290 (compare callout), 291-369 (sub-row pair) | Clamp callout to `line-clamp-1` with `min-h-[18px]` reserve; switch sub-row pair to `flex-nowrap overflow-hidden truncate` at `<sm`, `flex-wrap` from `sm:+` |
| `src/app/__tests__/page-tile-strip.test.tsx` (new) OR an existing dashboard test | n/a | Snapshot test asserting every tile renders with the data-slot `trend-card` carrying the same computed bounding box at a 375 px viewport |

The vestigial F14 flex-without-direction wrapper on each tile cell (`<div className="flex min-w-[10rem]…">`) can stay — converting it to `block` would be cleaner but is orthogonal to the height contract. Defer.

The mobile sub-row clamp may need an accessibility note: when `7d trend: 122.3 (+1.2)` clips to `7d trend: 122…`, the screen reader still announces the full value via the existing `aria-label={\`7-day trend ${formatDelta(trend7Delta)}\`}` on the `<span data-slot="trend7-delta">` (line 327-328). Verified via Read.

---

## 8. Tests + snapshots

The current test inventory in `src/app/__tests__/` and `src/components/charts/__tests__/` covers `<TrendCard>` rendering shape but does not assert pixel-uniform tile heights across a strip. The contract delivery should add:

1. A jsdom snapshot test that renders the dashboard with the full `DASHBOARD_WIDGET_IDS` list + comparison ON + a 375 px-wide root and asserts every `data-slot="trend-card-…"` parent measures the same `clientHeight` (jsdom does not layout, but the test can read computed style and assert `h-[var(--tile-h)]` resolves to the same value on every cell).
2. A Playwright mobile screenshot test (`@playwright/test` already in the repo per `playwright.config.ts`) at the 375 px viewport that diffs the strip against a baseline image. Fails if any tile's bounding box differs by > 1 px from its siblings.

The insights row already has a `trends-row.test.tsx` precedent — mirror the structure for dashboard strip.

---

## 9. Effort estimate

**S** (small).

Rationale:

- One CSS-only edit at the page level (two diff hunks)
- One CSS-only edit inside the shared tile primitive (two diff hunks)
- No DOM restructure; no per-tile branch; no widget-API change
- Test additions: one snapshot, one Playwright spec
- No iOS contract surface affected — every endpoint, every DTO, every Prisma field stays identical
- No copy change — i18n keys untouched

Sub-S risk: the `flex-nowrap overflow-hidden truncate` switch on the sub-row pair may clip values in locales the dashboard does not currently test (e.g. fa-IR with longer numeric strings). Mitigation: keep the `<sm` clip + restore wrap on `sm:+`, and add a single Playwright spec at 375 px in en + de locales.

The contract delivery fits inside the v1.4.28 R3c-Insights-K1/K2 mental model: it is the same contract translated from `/insights` to `/`, with the small wrinkle that the dashboard strip needs to handle the horizontal-scroll branch the insights row does not. The wrinkle costs one extra CSS custom-property (`--tile-h`) but no additional architectural surface.

---

## 10. iOS impact

None. The native iOS client (`/Users/marc/projects/healthlog-iOS` per `.planning/v15-ios-handoff/`) renders its own SwiftUI dashboard tiles via locked DTOs from `/api/analytics`. The native tile heights are managed by SwiftUI's `GridItem(.flexible())` / `aspectRatio` modifiers, not by CSS. The proposed contract is web-only chrome.

The shared design language — "every tile reads at the same y-rhythm on a phone-sized viewport" — should ideally land in both the web and iOS clients, but the iOS implementation is out of scope for this research slot and is presumably already handled by the native rendering. Cross-check via the iOS handoff docs is worth doing as a separate slot deliverable.

---

## 11. Open questions for the consolidator

1. **Does the maintainer want the `sm:` boundary to stay 640 px, or shift to 480 px / `min-width: 30rem` so iPad-portrait and large-phone landscape get the grid behaviour?** Current `sm:+` corresponds to the Tailwind default 640 px. Most phones in landscape (Pixel 5 at 851 px landscape, iPhone 14 Pro at 852 px) land above the boundary already, so no edit needed unless the maintainer specifically calls out a phone-landscape viewport. Default decision: keep 640 px.

2. **Should the 140 px target shift to 132 or 148 px after the live measure?** The 140 px number is back-of-envelope from the content-height arithmetic in §3.1. A 5-minute Playwright snapshot at 375 px will settle the exact pixel. The contract's structure is breakpoint-stable regardless.

3. **Per-tile overrides for glucose**: should the glucose tiles synthesise a `trend7Delta` from `latest - avg7` so they paint the same delta chip as their siblings, or stay slack-padded? The former adds one prop and visually homogenises the strip; the latter respects the current contract that glucose has no headline trend signal. Default decision: stay slack-padded, escalate if Marc's next walk-through still calls out the empty space.

4. **Vestigial F14 cell-wrapper drop**: the v1.4.27 R3c-Mobile-Dashboard audit flagged the `<div className="flex min-w-[10rem]…">` wrapper as vestigial. The proposed contract requires the wrapper to carry the `h-[var(--tile-h)]` class, so it stays. Drop the F14 deferral; the wrapper has a real job now.

5. **Comparison-overlay callout copy**: a one-line clamp may truncate the German `Δ +1,2 mmHg vs. letzter Monat` at the right edge on the narrowest tiles (160 px). The aria-label still carries the full string. Acceptable trade-off, but Marc may prefer to drop the ` vs. letzter Monat` suffix on `<sm` and rely on the global comparison-toggle chip in the header for context. Default decision: keep full string + clip; revisit after live measure.

---

## 12. Forbidden-vocab compliance

This doc is free of: AI, Claude, agent, marathon, wave, phase (except inside file-path identifiers like `phase-config-dialog.tsx` which is not used here), session, subagent, Anthropic.

Marc-Voice English. Terse. No PII. No personal health figures.

---

## 13. Summary table for the v1.5 strategic plan

| Field | Value |
|---|---|
| Tile-variant count | **1** (`<TrendCard>` after the v1.4.28 FB-C2 BD-Zielbereich rewrite — no surviving divergent shapes) |
| Target tile heights | **140 px on `<sm`, `auto` on `sm:+` (driven by `grid auto-rows-fr`)** |
| Contract one-liner | **One CSS custom property `--tile-h` on the dashboard strip wrapper + `line-clamp-1` + `flex-nowrap overflow-hidden` on the sub-row pair at `<sm`, releasing back to the existing wrap behaviour from `sm:+` upwards** |
| Estimated effort | **S** (two CSS-only diffs, one snapshot test, one Playwright spec) |
| Files touched | **3** (`src/app/page.tsx`, `src/components/charts/trend-card.tsx`, one new test file) |
| iOS impact | **None** (web-only chrome) |
| Risk | **Low** — additive CSS-only edits, no widget-API change, no copy change |
| Maintainer-blockers | None — the change is self-contained and lands inside a single fix-surface |
