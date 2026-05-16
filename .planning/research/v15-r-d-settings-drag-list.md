---
file: .planning/research/v15-r-d-settings-drag-list.md
purpose: Settings → Dashboard drag-list mobile compactness research and contract proposal
created: 2026-05-16
contributor: R-D
---

# Settings → Dashboard drag-list — mobile compactness

The maintainer flagged the per-widget rows on `/settings/dashboard` as
"too tall" on mobile and disharmonic against the rest of the page. The
audit confirms that: each row is roughly **3× taller than every other
row on the Settings stack** because the row chrome stacks two 44-px
icon buttons vertically. This document proposes a single-row, ~48-px
contract that keeps every existing behaviour (visibility toggle, tile
toggle, manual reorder) and every existing tap-target requirement.

The work is read-only research — no code shipped here.

## 1 — Current shape

`src/components/settings/dashboard-layout-section.tsx` renders each
widget as:

```tsx
<div className="border-border bg-background/30 flex items-center gap-3
                rounded-md border p-3">
  <div className="flex flex-col gap-1">
    <Button size="icon" className="size-11" …><ArrowUp/></Button>
    <Button size="icon" className="size-11" …><ArrowDown/></Button>
  </div>
  <span className="flex-1 text-sm">{label}</span>
  <div className="flex w-12 justify-center"><Switch …tileVisible/></div>
  <div className="flex w-12 justify-center"><Switch …visible/></div>
</div>
```

Measured against the Tailwind base:

| Layer            | Class            | Height |
|------------------|------------------|--------|
| Outer padding    | `p-3`            | 12 + 12 = 24 px |
| Arrow stack      | two `size-11` + `gap-1` | 44 + 4 + 44 = **92 px** |
| Row total        |                  | **≈ 116 px** |

Across 15 default widgets the list is **15 × 116 ≈ 1 740 px** tall —
just the widget table, not counting the section header, the comparison
picker, or the Save bar. On a 390 × 844 viewport the list alone needs
more than two full scroll-heights.

For reference, peer surfaces on the same Settings page:

- Account inputs (`account-section.tsx`): `h-9` = 36 px field + 4 px
  gap → **40 px** row rhythm.
- Sources tiles (`sources-section.tsx`): `px-2 py-1.5` row, single
  `h-11 w-11` button → **44 px** row.
- AI provider chain (`ai-section.tsx`): `p-2` row, single `size="sm"`
  (h-8) arrow button → **48 px** row.

The Dashboard drag-list is the only Settings surface that doubles its
arrow buttons vertically. That is the entire source of the bloat — the
switches, the label, and the padding are otherwise in family.

## 2 — Why two stacked arrows in the first place

The current shape comes from v1.4.15. There was no DnD library in the
tree then (still none — `package.json` has no `@dnd-kit/*` /
`react-beautiful-dnd` / `sortablejs`), and the maintainer asked for an
explicit "move up / move down" surface so reorder works without a
press-and-hold gesture and stays driveable from a desktop keyboard.

Stacking the two buttons vertically and inflating each to 44 px was
the path-of-least-resistance answer: each button hit the 44-px tap
target on its own without any horizontal layout fuss. The cost is the
row height — paid once per widget, on every visit.

## 3 — Peer comparison (mobile patterns surveyed)

- **Apple Health → Summary → Edit** uses a single drag-handle on the
  trailing edge (the three-bar grip glyph). Rows are ~44 px. Reorder
  is a press-and-drag, with star toggles separated. No paired arrows.
- **Withings → Home → reorder** offers per-widget drag handles, ~52 px
  rows; settings are buried in a separate sheet.
- **Whoop → "Customize Overview"** uses ~48 px rows with a leading
  grip + trailing toggle, never both visibility states on the same
  row (toggle drills into a sub-sheet for the surface picker).
- **MacroFactor → Stat order** is again the single-grip pattern, ~44
  px rows.

Every peer collapses to **one** action on the row plus a single drag
affordance. None of them stack two icon-buttons.

The pattern the peers converge on is *long-press-then-drag*. That's
out of scope here (a true drag would need DnD-kit + an iOS-impact
parity story we explicitly don't want for v1.5). The compaction
proposed below keeps the up/down-arrow contract but shrinks it to a
single horizontal pair, which closes the height gap without taking on
new dependencies.

## 4 — Proposed shape

Replace the vertical arrow stack with a **horizontal pair of
`size="icon-sm"` (32-px) buttons** sitting to the right of the label,
on the same axis as the two switches. Drop the `p-3` to `px-3 py-2` to
match the Sources pattern. Bump the row to a deliberate `min-h-12`
(48 px) so the rhythm is consistent regardless of label wrap.

The shape:

```tsx
<div className="border-border bg-background/30
                flex items-center gap-2 rounded-md border
                px-3 py-2 min-h-12">
  <span className="flex-1 text-sm truncate">{label}</span>
  <div className="flex w-12 justify-center"><Switch …tileVisible/></div>
  <div className="flex w-12 justify-center"><Switch …visible/></div>
  <Button size="icon-sm" variant="ghost" …><ArrowUp/></Button>
  <Button size="icon-sm" variant="ghost" …><ArrowDown/></Button>
</div>
```

Per-row math:

| Layer            | Class            | Height |
|------------------|------------------|--------|
| Outer padding    | `py-2`           | 8 + 8 = 16 px |
| Tallest cell     | `size-8` arrows  | 32 px  |
| `min-h-12` floor |                  | 48 px  |
| Row total        |                  | **48 px** |

That's a **2.4 × reduction** (116 px → 48 px). Across the 15 default
widgets the list collapses from ~1 740 px to ~720 px — fits inside a
single mobile viewport's worth of scroll.

The column headers (Tile / Chart) already align with the two-switch
slot via `w-12 text-center`; that contract carries forward unchanged.
The arrows live in their own trailing slot, *not* under a column
header, because reorder is a verb, not a column.

## 5 — Accessibility ledger

- **Tap target.** `size="icon-sm"` is 32 × 32 px, **below** the
  Apple HIG / WCAG 2.5.5 44-px minimum. The compensation: bump only
  these two buttons back to `size="icon"` (`size-10`, 40 px) on
  `sm:` and *up*, and keep `size-11` (44 px) on mobile via an
  override (`max-sm:size-11`). The arrows then read as 44-px tap
  targets on phone (where it matters most) and visually shrink on
  desktop where pointer accuracy is high. **The 48-px row min-height
  stays the same** because both buttons sit on the row axis, not
  stacked.

  Net effect on mobile: row height = 44 px (tallest cell) + 4 px
  padding floor = 48 px. The 44 px tap target is preserved exactly;
  the height penalty is paid once horizontally rather than twice
  vertically.

- **Keyboard order.** Label → tile-switch → chart-switch → up →
  down. Tab order stays linear. Each control keeps its existing
  `aria-label` (`dashboard.moveUp`, `dashboard.moveDown`,
  `${label} — ${tile|chart column}`).

- **Screen reader.** No `<table>` semantics are introduced; the
  visual column headers are presentational already
  (`aria-hidden="true"` on the spacer span; `text-[10px] uppercase`
  on the two visible header labels). The proposed shape doesn't
  change that contract.

- **Reduced motion.** No animation added; existing
  `motion-reduce:animate-none` on the Loader2 path is unaffected.

- **Focus ring.** `Button` already ships
  `focus-visible:ring-[3px]` from `buttonVariants`; the smaller
  buttons inherit the same ring at the same offset, so the focus
  affordance scales down without going invisible.

## 6 — What collapses on mobile (and what doesn't)

The audit looked at hiding the second switch on mobile (a popover or
`<details>` "secondary controls" pattern). **Recommendation: don't
do it.** Two reasons:

1. The whole point of v1.4.15 Fix 5 was to give the maintainer
   independent control of the tile surface and the chart surface
   from one place. Burying one of them behind a disclosure
   undermines the feature he explicitly asked for.
2. Two `Switch` components at `data-size=default` are 32 × 18.4 px
   each. They cost ~64 px of horizontal real estate including
   centering slots. There's room for them on a 390-px viewport
   alongside two 44-px arrow buttons and a `flex-1` label that can
   `truncate`. Verified against the iPhone-SE-class width budget
   (`375 - 24 (card p-6 inner) - 48 (label min) - 48 (arrow pair) -
   64 (switch pair) - 24 (gaps) = 167 px label slack`).

What does change on mobile:

- The label gets `truncate`. Today the label can wrap, which makes
  the row taller than the arrow stack and disrupts vertical rhythm.
  With a tight `min-h-12` and 32-px buttons, wrapping would push the
  row off-grid; truncating with the full label still reachable via
  `title` / `aria-label` keeps the rhythm clean.

## 7 — Classes to change (one-file diff sketch)

Inside the `.map` block of `dashboard-layout-section.tsx`:

```diff
 <div
   key={widget.id}
-  className="border-border bg-background/30 flex items-center gap-3
-             rounded-md border p-3"
+  className="border-border bg-background/30 flex items-center gap-2
+             rounded-md border px-3 py-2 min-h-12"
 >
-  <div className="flex flex-col gap-1">
-    <Button size="icon" className="size-11" …>
-      <ArrowUp className="h-4 w-4" />
-    </Button>
-    <Button size="icon" className="size-11" …>
-      <ArrowDown className="h-4 w-4" />
-    </Button>
-  </div>
-  <span className="flex-1 text-sm">{t(labelKey)}</span>
+  <span className="flex-1 truncate text-sm" title={t(labelKey)}>
+    {t(labelKey)}
+  </span>
   <div className="flex w-12 justify-center"><Switch …tileVisible/></div>
   <div className="flex w-12 justify-center"><Switch …visible/></div>
+  <Button
+    type="button" variant="ghost"
+    className="size-11 sm:size-9"
+    onClick={() => move(widget.id, -1)}
+    disabled={index === 0 || saveMutation.isPending}
+    aria-label={t("dashboard.moveUp")}
+  >
+    <ArrowUp className="h-4 w-4" />
+  </Button>
+  <Button
+    type="button" variant="ghost"
+    className="size-11 sm:size-9"
+    onClick={() => move(widget.id, 1)}
+    disabled={index === arr.length - 1 || saveMutation.isPending}
+    aria-label={t("dashboard.moveDown")}
+  >
+    <ArrowDown className="h-4 w-4" />
+  </Button>
```

Also bump the column-header alignment spacer so the new arrow slot
doesn't break the Tile / Chart column meters:

```diff
- <span className="w-11" aria-hidden="true" />
+ <span className="flex-1" aria-hidden="true" />
  <span className="flex-1" />
  <span className="w-12 text-center">{t("dashboard.layoutTileColumn")}</span>
  <span className="w-12 text-center">{t("dashboard.layoutChartColumn")}</span>
+ <span className="w-22 sm:w-18" aria-hidden="true" />
```

(The right-hand spacer reserves the width of the two arrow buttons so
the column headers continue to line up with the switches below; the
`sm:w-18` matches the smaller-button width on desktop.)

## 8 — Tests to add

- Snapshot the new row rendered shape and assert `min-h-12` is
  present on each row container.
- Assert that on `max-sm` (jsdom default) the two arrow buttons
  expose `size-11` (the 44-px mobile tap target). No existing test
  reads classNames — they read `data-slot` attributes — so the
  existing `dashboard-layout-section.test.tsx` survives unchanged.
- Visual smoke spec in Playwright at 390-px viewport: list ≤ 850 px
  tall with 7 default widgets visible.

## 9 — Estimate and risk

- **Effort: S.** One file, ~30 lines net, no schema change, no API
  change, no i18n change (the two existing `dashboard.moveUp` /
  `dashboard.moveDown` labels carry forward verbatim).
- **iOS impact: none.** This is a web-Settings-only refactor. The
  underlying `DashboardLayout` schema and the `/api/dashboard/widgets`
  contract stay byte-for-byte identical, so the iOS app reads the
  same JSON shape.
- **Risk: low.** The column-header spacer width is the one spot that
  needs an eyeball check at three viewports (375, 414, 768 px).
  Existing E2E selectors all target `data-slot="widget-tile-switch"`
  / `data-slot="widget-chart-switch"` / `aria-label="Move up"`,
  none of which change.

## 10 — Out of scope

- True drag-and-drop reorder via `@dnd-kit/*`. Would force a new
  dependency, a long-press affordance contract, and a SwiftUI
  parity story. Park for a later release.
- Collapsing tile/chart switches into a single primary toggle plus a
  disclosure. The maintainer asked for the two-toggle surface
  explicitly; the compaction here serves the same intent.
- Re-skin of the comparison-baseline picker above the list. Outside
  R-D's brief.

---

**4-line summary**

- Current row height ≈ 116 px (vertical 44+44 arrow stack + `p-3`);
  target 48 px via `min-h-12`, `px-3 py-2`, single horizontal arrow pair.
- Classes to change: row container `p-3 gap-3` → `px-3 py-2 gap-2
  min-h-12`; arrow buttons un-stacked, `size-11` on mobile and
  `sm:size-9` on desktop; label gains `truncate`; column-header spacer
  widens.
- Estimated effort: S (one file, ~30 lines, no schema/API/i18n
  changes, no new dependency). iOS impact: none.
- A11y verification: 44-px mobile tap target preserved on both arrow
  buttons via `size-11`; `aria-label`s unchanged; tab order linear;
  no `<table>` semantics introduced; existing `data-slot`-based tests
  stay green.
