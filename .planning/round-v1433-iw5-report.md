# v1.4.33 — IW5 implementation report

Scope: maintainer item 5 (Coach drawer headings missing), A5 F15
(mobile Coach FAB blocks chart tooltip), F20 verification (Coach
drawer scroll-hang). Branch: `develop`. All commits pushed.

---

## Commits

| SHA         | Title                                                                       | Files | Notes                                                                        |
| ----------- | --------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| `bfb1b43a`  | `fix(insights): promote coach-rail labels to semantic h3 headings`         | 4     | History + Sources rails. Adds two regression tests.                          |
| `a5a91e40`  | `fix(insights): auto-hide mobile Coach FAB while a chart tooltip is open`  | 5     | MutationObserver-backed singleton + `useChartTooltipActive()` + FAB wire-up. |

---

## Item 5 — Coach drawer headings missing

### Root cause

`<CoachDrawer>` carries a `<SheetTitle>` (Radix renders as `<h2>`).
`<CoachSettingsSheet>` does the same. `<MobileRailTray>` wraps each
rail in its own `Sheet` + `SheetTitle` so mobile users also see an
`<h2>` heading.

But on `lg+` desktop the rails mount **inline** next to the message
thread — no `Sheet` wrapper, so no `SheetTitle`. Both rails rendered
their section labels (`"Unterhaltungen"`, `"Worauf ich zugreife"`)
as `<span class="uppercase">` only. The drawer's semantic outline
disappeared above the message thread on desktop; screen-reader users
navigating by heading skipped straight from the drawer's `<h2>`
title to the message thread region with no intermediate landmark.

That's the conditional-render bug the maintainer reported:
"bestimmte Headlines nicht gerendert" — exactly the rails' inline-
desktop branch, which had no real heading element.

### Fix

`src/components/insights/coach-panel/history-rail.tsx` — promoted the
"Unterhaltungen" label from `<span>` to `<h3>` (slot:
`coach-history-rail-heading`).

`src/components/insights/coach-panel/sources-rail.tsx` — promoted the
"Worauf ich zugreife" label from `<span>` to `<h3>` (slot:
`coach-sources-rail-heading`).

Visual treatment unchanged — the same uppercase / tracking / muted-
foreground utility classes are now applied to the heading element
directly. The desktop layout now carries a coherent `h2` (drawer
title) > `h3` (rail) outline; the mobile rail-tray surface gets
`h2` (`SheetTitle`) > `h3` (rail), still hierarchical.

### Tests

`src/components/insights/coach-panel/__tests__/history-rail.test.tsx`
- New case: rail label renders inside a real `<h3>` element with the
  slot attribute and the localised label.

`src/components/insights/coach-panel/__tests__/sources-rail.test.tsx`
- New case: same shape for the sources rail.

Both run against `renderToStaticMarkup` so the regression is pinned
at the SSR contract level. No i18n keys touched — `historyTitle` and
`sourcesTitle` already existed across all six locales.

---

## A5 F15 — Mobile Coach FAB blocks chart tooltip

### Root cause

`<LayoutCoachFab>` mounts a `fixed right-4 bottom-20` pill on every
routed `/insights/<metric>` page (mobile only, `lg:hidden`). A user
tapping a data point in the chart's lower-right corner saw the
Recharts tooltip pop up, but the FAB sat on top of it. The audit
flagged this as F15 — Severity Medium.

### Fix approach

The recommended fix in the audit was "auto-hide on chart tooltip
open (cleanest UX)". The chart code itself was out of this work-
item's touch surface, and IW2 owns the dynamic-import wrapper. So
the FAB had to detect tooltip visibility without modifying any chart
component or sharing a React context across the routed-subtree
boundary.

Recharts paints every active tooltip into a div whose class always
carries `recharts-tooltip-wrapper`. The upstream `<TooltipBoundingBox>`
flips the inline `style.visibility` from `hidden` to `visible` when
the tooltip should paint (verified via `node_modules/recharts/lib/
component/TooltipBoundingBox.js:90`). I built a singleton
`MutationObserver` that watches every wrapper on the page for
`style`-attribute changes and feeds a tiny external store.

### New files

- `src/components/insights/chart-tooltip-observer.ts` — module-scoped
  observer + subscriber API + SSR-safe snapshot. Cleanly handles:
  - multiple subscribers (singleton observer)
  - observer connect on first subscriber, disconnect on last
  - SSR (no `document`) — no-ops without throwing
  - wrappers that exist before subscribe (initial scan)
  - new wrappers added later (childList mutations)
  - removed wrappers (decrement count cleanly)
  - test-reset hook for cross-test isolation

- `src/components/insights/use-chart-tooltip-active.ts` — `useSync-
  ExternalStore` wiring. Returns `false` on SSR so the FAB renders
  interactive on the initial server pass.

### FAB wire-up

`src/components/insights/layout-coach-fab.tsx` reads the hook and
applies the active-state classes:
- `pointer-events-none opacity-0` while the wrapper is visible
- `aria-hidden=true` + `tabIndex=-1` for keyboard / SR users
- `data-chart-tooltip-active="true"` for e2e selector hooks
- `transition-opacity duration-150 motion-reduce:transition-none`
  so the fade is smooth and honours user preference

### Tests

`src/components/insights/__tests__/chart-tooltip-observer.test.ts`
- 5 cases: server snapshot, empty snapshot, unsubscribe shape, SSR
  no-op, multi-subscriber.

`src/components/insights/__tests__/layout-coach-fab.test.tsx`
- 6 cases: no-op outside provider, slot under provider, no active-
  flag on SSR paint, transition utility present, `lg:hidden`,
  German label.

The end-to-end auto-hide behaviour (chart hover/long-press → FAB
fades) belongs on the Playwright mobile suite — runtime DOM
observation isn't a unit-test concern.

---

## F20 verification — Coach drawer scroll behaviour

### Findings

1. **Drawer cannot be opened from `/`.** Confirmed via inspection.
   `<CoachLaunchProvider>` and `<LayoutCoachFab>` / `<LayoutCoachMount>`
   only mount inside `src/app/insights/layout.tsx`. The dashboard
   (`/`) and root layout have no Coach trigger. The maintainer's
   "Coach desktop blockt komplett" probably referred to something
   else, OR is the F20 root cause: there's no way to reach the Coach
   from `/`. Adding a global Coach trigger is IW7's territory
   (`src/components/layout/**`) per the prompt.

2. **Internal drawer scroll works.** `<CoachDrawerBody>` lays out
   three columns; each pane (history rail list, message thread,
   sources rail) carries `overflow-y-auto` + `min-h-0`. The
   `<CoachDrawer>` itself uses `flex h-[100dvh]` (or `90dvh` on
   phone) with `min-h-0` children — content scrolls inside the
   drawer, not the page behind it.

3. **Body scroll-lock is standard Radix behaviour.** Searched the
   codebase for any custom `document.body.style.overflow` toggle or
   manual `overflow: hidden` mutation — none exists outside Radix's
   own `Dialog` primitive. Radix Dialog locks the body while open
   and restores it on close; that's the modal contract and is
   correct. There is no body-lock-but-shouldn't-be situation to
   fix.

### No code change

F20 needed verification only. The drawer's scroll behaviour is
correct; the unreachable-from-dashboard surface is an IW7 concern
(global menu / sidebar mount of a Coach trigger).

---

## Quality gates

- `pnpm exec eslint` on every touched file — 0 errors / 0 warnings.
- `pnpm typecheck` on touched files — clean. Repo-wide typecheck
  still surfaces a pre-existing `useQuery`-undefined error in
  `src/components/insights/sleep-overview.tsx`, which is from
  another agent's in-flight uncommitted change (outside my file
  set).
- `pnpm test src/components/insights/coach-panel` — 92 / 92 passing
  (was 90 before; +2 from heading regression tests).
- `pnpm test src/components/insights` — 343 / 343 passing.

---

## Files touched

New files:
- `src/components/insights/chart-tooltip-observer.ts`
- `src/components/insights/use-chart-tooltip-active.ts`
- `src/components/insights/__tests__/chart-tooltip-observer.test.ts`
- `src/components/insights/__tests__/layout-coach-fab.test.tsx`

Edited files:
- `src/components/insights/coach-panel/history-rail.tsx`
- `src/components/insights/coach-panel/sources-rail.tsx`
- `src/components/insights/coach-panel/__tests__/history-rail.test.tsx`
- `src/components/insights/coach-panel/__tests__/sources-rail.test.tsx`
- `src/components/insights/layout-coach-fab.tsx`

No i18n keys added or modified — the heading promotion reuses
existing `insights.coach.historyTitle` / `insights.coach.sourcesTitle`
which already exist across all six locales (`de`, `en`, `es`, `fr`,
`it`, `pl`).

---

## Deferred / out-of-scope

1. **Global Coach trigger from `/` (F20 root cause).** IW7's
   territory (`src/components/layout/**`). The drawer is fully
   functional once opened, but the user has no way to open it from
   the dashboard today.

2. **Playwright assertion for chart-tooltip auto-hide.** Belongs in
   the e2e mobile suite. Pin the regression there once the suite
   runs cleanly post-IW9 bfcache work.

3. **Semantic heading audit beyond the rails.** `CoachInput`'s info
   popover, `SourceChips`, `MessageThread`'s thread-empty state all
   use `<p>` or `<span>` — none of those are sections that need a
   heading, but a v1.4.34 a11y pass could double-check the message-
   thread region landmark (the empty-state currently has no
   `<h3>` for the "no conversation yet" pane — arguably warranted,
   arguably overkill).
