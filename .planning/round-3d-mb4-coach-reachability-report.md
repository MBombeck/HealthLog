# R3d MB4 — Coach reachability + mobile chrome

Owner of CF-3, CF-9, CF-11 (verified), CF-31 (verified), CF-40, CF-73, CF-74.
Branch: `develop`. Pass-1 (MB1/MB2/MB3) landed before any MB4 work.

## What landed

Four atomic commits on `develop`, all gates green.

1. `246c1def` — `feat(coach): mount the drawer at the insights layout with a launch context`
   - New `<CoachLaunchProvider>` in `src/lib/insights/coach-launch-context.tsx`
     exposes `useCoachLaunch() → { open, prefill, askCoach, setOpen }`.
   - New `<LayoutCoachMount>` client bridge renders the `<CoachDrawer>`
     beside the provider so the `insights/layout.tsx` server file stays
     server-side.
   - `src/app/insights/layout.tsx` now wraps every routed sub-page in
     `<CoachLaunchProvider>` + mounts the drawer.
   - `src/app/insights/page.tsx` consumes the context instead of an
     inline `useState` + `<CoachDrawer>` pair.
   - Each of the seven sub-pages (`blutdruck`, `gewicht`, `puls`,
     `stimmung`, `medikamente`, `bmi`, `schlaf`) mounts a new
     `<CoachLaunchButton>` — sticky FAB on `<lg`, inline action on `lg+`.
   - Smoke contract for the provider in
     `src/lib/insights/__tests__/coach-launch-context.test.tsx`
     (3 tests; verifies hook shape + provider mount + null fallback).

2. `79dbdfbd` — `feat(coach): hide the drawer window pill on phone viewports and pin title truncation`
   - Wraps the drawer header's window-pill `<Select>` in a
     `hidden sm:block` container. Phone users reach the same override
     via the sources-rail picker (right-edge tray).
   - Pins `min-w-0` on `<SheetTitle>` so very long titles always clip.
   - The bottom-sheet branch on `<sm` was already wired in MB1
     (the drawer reads `useIsMobile("sm")` to flip side="bottom") so
     CF-9 needed no further edits here.

3. `40916d31` — `feat(coach): swap the sources-rail toggle to a shadcn Checkbox`
   - New primitive `src/components/ui/checkbox.tsx` (shadcn pattern
     backed by `radix-ui`'s `Checkbox` namespace).
   - `sources-rail.tsx` drops its raw `<input type="checkbox">` for the
     new `<Checkbox>` — keyboard contract (Space toggles, Tab moves),
     focus ring, touch-friendly hit target. Existing sources-rail tests
     still pass (the `data-slot="coach-sources-checkbox"` marker is
     preserved on the primitive).

4. `650d4f8e` — `feat(coach): re-pin the message-thread scroll when the soft keyboard opens`
   - `message-thread.tsx` adds a `window.visualViewport.resize`
     listener with the same wasPinned guard as the existing
     scroll-on-message effect. When the soft keyboard slides in the
     thread re-pins to the bottom so the tail stays visible.

## CF coverage

- CF-3 — drawer mount move + provider — **done** (commit 1).
- CF-9 — bottom-sheet on `<sm` — **already landed in MB1**, verified.
- CF-11 — history-rail delete reveal — **already landed in MB2**,
  verified (history-rail.tsx ships the always-visible `<Button>` with
  the `data-confirming` confirmation styling; no further edit needed).
- CF-31 — info-icon popover — **already landed in MB3**, verified
  (coach-input.tsx swapped Tooltip → Popover at the composer hint).
- CF-40 — sources-rail Checkbox swap — **done** (commit 3).
- CF-73 — SheetTitle truncate — **done** (commit 2 — `min-w-0 truncate`).
- CF-74 — visual viewport scroll re-pin — **done** (commit 4).

## Tests

- Smoke contract for the new context — 3 tests, all green.
- `pnpm vitest run src/components/insights src/lib/insights` →
  **51 files / 471 tests passed**.
- `npx tsc --noEmit` → clean.
- `npx eslint src/components/insights src/lib/insights src/components/ui/checkbox.tsx src/app/insights` → clean.

## Files touched (final)

New:
- `src/lib/insights/coach-launch-context.tsx`
- `src/lib/insights/__tests__/coach-launch-context.test.tsx`
- `src/components/insights/coach-launch-button.tsx`
- `src/components/insights/layout-coach-mount.tsx`
- `src/components/ui/checkbox.tsx`

Modified:
- `src/app/insights/layout.tsx` (provider + drawer mount)
- `src/app/insights/page.tsx` (consume context, drop inline mount)
- `src/app/insights/blutdruck/page.tsx`
- `src/app/insights/gewicht/page.tsx`
- `src/app/insights/puls/page.tsx`
- `src/app/insights/stimmung/page.tsx`
- `src/app/insights/medikamente/page.tsx`
- `src/app/insights/bmi/page.tsx`
- `src/app/insights/schlaf/page.tsx`
- `src/components/insights/coach-panel/coach-drawer.tsx` (window-pill +
  SheetTitle)
- `src/components/insights/coach-panel/sources-rail.tsx` (Checkbox swap)
- `src/components/insights/coach-panel/message-thread.tsx`
  (visualViewport listener)

## Coordination notes

- The branch HEAD moved a lot during this bucket (multiple sibling
  buckets landing in parallel). The MB4 commits sit on top cleanly;
  no merge conflicts and the sub-page edits (CoachLaunchButton
  mounts) survived MB6's empty-state CTA href swaps intact because
  the touch zones were disjoint (imports + body tail vs the
  EmptyState block).
- `<CoachLaunchProvider>` returns `null` from `useCoachLaunch()` when
  consumed outside the provider so the launch button degrades to
  rendering nothing rather than crashing on a non-Insights surface.
- The `scope` argument on `askCoach(prefill, scope)` is currently
  reserved (the parameter is accepted but the rail does not yet
  pre-narrow to a metric); ready for v1.4.28 to wire when the
  sources-rail starts honouring per-metric narrowing.
