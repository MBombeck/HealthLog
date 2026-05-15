# Round 3d MB2 — tap-target floor sweep

Bucket MB2 of the v1.4.27 R3d mobile fix pass. Owns CF-7, CF-8, CF-13,
CF-14, CF-18, CF-22, CF-27, CF-28, CF-29, CF-45, CF-54, CF-60, CF-63,
CF-64.

## Commits landed on develop

| SHA | Subject |
|---|---|
| `fb6fb4f5` | `feat(ui): lift Button, Input, Select, DropdownMenu defaults to honour the WCAG 2.5.5 floor` |
| `b2568340` | `refactor(ui): move PasswordInput into the shared UI layer with a 44 px toggle` |
| `44554729` | `chore(insights): apply the tap-target floor across the insights surface` |
| `beb2b40f` | `chore(coach): lift the rail-tray chevrons out of the overlay` |
| `bba8921e` | `chore(measurements,medications): apply the tap-target floor across list and form surfaces` |
| `17aed374` | `chore(dashboard): apply the tap-target floor across the dashboard tile and onboarding chrome` |
| `4464d2c9` | `chore(charts,errors): apply the tap-target floor across charts and error chrome` |

Total: 7 commits. All gates (typecheck + lint + 3989 unit tests) green.
Pushed to `origin/develop`.

## Primitive default changes (commit 1 — `fb6fb4f5`)

- `src/components/ui/button.tsx`
  - `default`: `h-9` → `h-10` (40 px)
  - `lg`: `h-10` → `h-11` (44 px)
  - `icon`: `size-9` → `size-10`
  - `icon-lg`: `size-10` → `size-11`
  - `sm` / `xs` / `icon-sm` / `icon-xs` unchanged (compact contexts).
- `src/components/ui/input.tsx`
  - `h-9` → `h-10`.
- `src/components/ui/select.tsx`
  - Trigger `data-[size=default]:h-9` → `data-[size=default]:h-10`.
- `src/components/ui/dropdown-menu.tsx`
  - `DropdownMenuItem` gains `min-h-11` plus `py-2` (was `py-1.5`).

## DialogContent close-X (Decision I)

`src/components/ui/dialog.tsx` close-X grew from `h-6 w-6` (24 px) to
`min-h-9 min-w-9` (36 px), repositioned to `top-3 right-4`. This is the
documented exception per Decision I — 36 px (WCAG 2.5.8 minimum, not the
2.5.5 floor) is the intentional compromise because a 44 px close-X
would crowd the dialog header.

The change landed in the parallel MB1 `feat(ui): introduce the
ResponsiveSheet primitive` commit (`65fd0bff`) because both buckets
share the same `dialog.tsx` file in the working tree.

## PasswordInput move (Decision J — commit 2 `b2568340`)

- Moved: `src/components/settings/password-input.tsx` → `src/components/ui/password-input.tsx`
- Toggle wrapper: bare `<button>` → `inline-flex h-11 w-11 items-center
  justify-center rounded-md` (44 px hit area per WCAG 2.5.5).
- Input gets `pr-12` so user input never collides with the toggle.
- Consumer imports updated:
  - `src/components/settings/account-section.tsx`
  - `src/components/settings/ai-section.tsx`
  - `src/components/settings/integrations-section.tsx`
  - `src/components/settings/ntfy-card.tsx`
  - `src/components/settings/telegram-card.tsx`
  - `src/components/admin/_shared.tsx`

## Surface sweep — every file touched

### Insights (commit 3 — `44554729`)

- `src/components/insights/hero-strip.tsx` — drop `size="sm"` from weekly report, ask-the-Coach, weekly banner read/share/export buttons so they sit at the new 40 px primitive default.
- `src/components/insights/suggested-prompts.tsx` — chip floor `min-h-9` → `min-h-11`.
- `src/components/insights/insight-advisor-card.tsx` — regenerate icon buttons drop `h-7 w-7` override (size="icon" default 40 px takes over); legacy-payload CTAs drop `size="sm"`/`h-7`.
- `src/components/insights/coach-panel/coach-drawer.tsx` — window pill `h-7` → `h-11`; new-chat/settings/close header icons `size-9` → `size-11`.
- `src/components/insights/coach-panel/coach-input.tsx` — composer hint icon `h-7 w-7` → `h-11 w-11`.
- `src/components/insights/coach-panel/message-thread.tsx` — thumbs feedback row `py-0.5 text-[11px]` → `min-h-11 py-1.5 text-xs`.

### Coach rail-tray (commit 4 — `beb2b40f`)

- `src/components/insights/coach-panel/coach-drawer-body.tsx` — rail-tray triggers lifted out of the absolute overlay into a sub-header strip; strip carries `xl:hidden`, history trigger keeps `lg:hidden`; both buttons at `min-h-11`.
- `src/components/insights/coach-panel/history-rail.tsx` — drop `opacity-0 group-hover:opacity-100` reveal on per-row delete; `size-6` → `size-11` always-visible.
- `src/components/insights/coach-panel/__tests__/coach-drawer-mobile-trays.test.tsx` — re-baseline assertions: drop "thread region is relative" check; add "strip wrapper carries `xl:hidden`" + "history trigger has `min-h-11`" assertions.

### Measurements + medications (commit 5 — `bba8921e`)

- `src/components/measurements/measurement-list.tsx` — mobile-row edit + delete `size-8` → `size-11`; pagination chevrons `size="sm"` → `size-11` icon-buttons with `aria-label`; edit-dialog kebab `h-9 w-9` → `size-11`; `DeleteButton` default `h-8 w-8` → `size-11`; empty-state CTAs drop `size="sm"`.
- `src/components/measurements/measurement-form.tsx` — reset kebab `h-9 w-9` → `size-11`.
- `src/components/medications/intake-history-list.tsx` — desktop + mobile per-row edit + delete `size-8` → `size-11`; pagination chevrons `size="sm"` → `size-11` icon-buttons; edit-dialog kebab → `size-11`; in-file `DeleteButton` → `size-11`.
- `src/components/medications/SideEffectsSection.tsx` — per-entry delete `h-7 w-7` → `size-11`.
- `src/components/medications/inventory-section.tsx` — live-pen "mark as in use" / "mark as used up" pills drop `size="sm"`/`h-7` so they sit at `min-h-11`; past-pen delete `h-6 w-6` → `size-11` icon-button.
- `messages/en.json` + `messages/de.json` + `messages/es.json` + `messages/fr.json` + `messages/it.json` + `messages/pl.json` — add `measurements.previousPage` / `measurements.nextPage` / `medications.previousPage` / `medications.nextPage` keys so the new pagination icon-buttons carry accessible labels in every locale.

### Dashboard, onboarding, settings (commit 6 — `17aed374`)

- `src/components/dashboard/glp1-tile.tsx` — range-strip radio buttons gain `inline-flex min-h-11 items-center justify-center px-3`; tab pills (level/weight) lift the same way.
- `src/components/onboarding/getting-started-checklist.tsx` — dismiss-all CTA drops `size="sm"` (40 px default); per-row dismiss `X` button wraps in `inline-flex h-11 w-11`.
- `src/components/settings/dashboard-layout-section.tsx` — reorder up + down arrows `h-5 w-5` → `size-11`; column-header spacer `w-5` → `w-11` to keep grid alignment.
- `src/components/settings/sources-section.tsx` — metric source ladder + device-type ladder arrows stack vertically on `<sm` (`flex flex-col gap-1 sm:flex-row sm:gap-2`); each button keeps `h-11 w-11`.

### Charts, errors, public surfaces (commit 7 — `4464d2c9`)

- `src/components/charts/health-chart.tsx` — band overlay positioning fix: `right: 18px` → `right: 8px` to match the underlying ComposedChart margin. (Y-axis default width is already 76 px, well above the 36 px floor the plan note referenced.)
- `src/components/error-details.tsx` — drop `size="sm"` from retry, copy, report-issue buttons (40 px default).
- `src/app/auth/login/page.tsx` — back-to-passkey toggle wraps in `inline-flex min-h-11 w-full items-center justify-center`.
- `src/app/privacy/page.tsx` — header HealthLog + Sign-in links wrap in `inline-flex min-h-11`.
- `src/app/about/page.tsx` — same header lift as `/privacy`.

## Deviations from the plan

- **`coach-drawer.tsx` co-touched lines.** MB1 + MB4 had concurrent in-flight edits to `coach-drawer.tsx` while MB2 was lifting the header icons. The MB4 `useIsMobile` import + `isPhoneViewport` variable landed inside MB2's `chore(insights): apply the tap-target floor across the insights surface` commit because the parallel worker had already written those lines before MB2 staged. `useIsMobile` is unused inside MB2's commit but is harmless (no lint warning) and is consumed by MB4's later `<sm` bottom-sheet branch.
- **`use-is-mobile.ts` pulled into MB2's insights commit.** Same root cause — the untracked file existed in the working tree when MB2 ran `git commit`. The hook is MB1's surface but the file landed under MB2's authorship. The work is correct; the attribution is mixed.
- **DialogContent close-X landed under MB1's commit.** MB1's `feat(ui): introduce the ResponsiveSheet primitive` (`65fd0bff`) committed before MB2 could stage its close-X edit, and the MB2 edit was already written in the working tree. Decision I says MB2 owns this; the work is correct; the attribution sits with the MB1 commit.
- **Y-axis width default lift skipped.** The plan note suggested `28 → 36 px` but the actual current default is `yAxisWidth = 76`. No callsite passes a narrower value. Treated the note as already-satisfied; the more load-bearing chart fix was the band-overlay `right: 18px → right: 8px` correction, which landed.
- **i18n parity work.** A pre-existing parity failure in `i18n-locale-integrity.test.ts` (MB3's `measurements.filterByType` only in en+de) was visible during MB2's run. MB2 added its own keys (`measurements.previousPage` / `measurements.nextPage` and `medications.previousPage` / `medications.nextPage`) to all six locale files. MB3 later landed `chore(i18n): fan filterByType across the remaining locale files` (commit `1ca70225`) which closed the prior gap; the full test suite is now green on the final push.

## Gates

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` — 356 files, 3989 tests passing, 1 skipped, 0 failing.
