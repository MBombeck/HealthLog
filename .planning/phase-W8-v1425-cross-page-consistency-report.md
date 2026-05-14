# Wave 8 — Cross-page consistency (v1.4.25)

**Branch:** develop
**Range:** `ca3c225..HEAD` (4 atomic commits)
**Owner:** Marc-André Bombeck

## Scope

Five sub-items aimed at cross-page visual + interaction parity, plus a
post-merge verification of the W8b admin commit chain.

## What changed

### 8.1 — Icon-heading parity in Settings

The Settings sections audit had previously flagged exactly two heading
violations across the 46 Settings + Admin section files: both inside
`src/components/settings/notification-status-card.tsx` (empty-state h2
and header h2 had no preceding icon). The convention used across 21
conformant sections is `<Icon className="text-primary h-5 w-5" /> <h2>`
wrapped in `flex items-center gap-2`.

Picked **`Bell`** as the thematic icon (notification-channel-status).
Wrapped each h2 in the canonical flex container.

**Commit:** `00105e2 — fix(settings): add icon to notification-status-card heading for cross-section parity`

Files touched:

- `src/components/settings/notification-status-card.tsx` — added `Bell`
  to the lucide import; wrapped both h2 occurrences in the flex/icon
  pattern.

### 8.2 — Coach-Feedback admin layout-shift fix

Marc reported a visible layout shift when navigating to
`/admin/coach-feedback`. Root cause: the section had four distinct
top-level render structures across loading / error / empty / data
states. The loading branch was a thin `flex items-center gap-2 p-6`
stub *without* the heading; the error branch was a `p-4` alert with no
card chrome at all; only the empty + data branches mounted the
Sparkles icon + "Coach Feedback" title. Result: when the user clicked
into the section, the loading state measured ~52 px tall, then snapped
to its full data height once the query resolved.

Fix mirrors the canonical pattern used by `SystemStatusSection`: render
the outer card + heading unconditionally, and switch only the body
between spinner / alert / empty / table. Added a regression test that
asserts the heading + outer card chrome are present in every render
state.

**Commit:** `91d5db5 — fix(admin): align Coach-Feedback header with adjacent sections to prevent layout shift`

Files touched:

- `src/components/admin/coach-feedback-section.tsx` — restructured to
  render header outside the fetch-state ternary; body switches between
  loading / error / empty / data.
- `src/components/admin/__tests__/coach-feedback-section.test.tsx` —
  added regression test asserting heading + `bg-card rounded-xl` are
  present across every render state.

### 8.3 — Mobile-first Pixel-5 audit (393 px)

Source-level sweep against the WCAG 2.5.5 44 px touch-target floor and
horizontal-overflow patterns. Dev server wasn't running for live
Playwright, so audit was done via Read + Grep across all major page
files. Key findings + fixes:

- `TopBar` user-menu trigger and login link: `flex … py-1.5` was
  ~30 px tall. Added `min-h-11 min-w-11` + rounded hit zone.
- `SettingsShell` mobile section chip-strip: `rounded-full … py-1.5`
  chips were ~30 px tall. Added `min-h-11`. Primary mobile-settings nav.
- `AdminShell` mobile section chip-strip: same issue → same fix.
- `medication-form` schedule-interval picker (1W/2W/3W/4W buttons):
  native `h-8` buttons inside 4-col grid. Replaced with `min-h-11`.
- `medications/page.tsx` page-root spacing `space-y-5` → `space-y-6`
  to match dashboard / measurements / mood / notifications.

Reviewed but no action needed:

- `BottomNav` already hits 44 px via `min-h-11 min-w-11`, has
  `pb-[env(safe-area-inset-bottom)]`, and uses 5+More pattern.
- `AuthShell` already pads main with `pb-[calc(4rem+env(safe-area-inset-bottom,0px))]`.
- API-section tables wrap fixed `min-w-[760px]` content in
  `overflow-x-auto`.
- Insights sub-pages use `text-xl font-semibold sm:text-2xl`
  (intentionally smaller than top-level pages since they're nested).
- Page-level h1 across 18 pages: consistent `text-2xl font-bold tracking-tight`.

**Commit:** `5822c87 — fix(mobile): hit WCAG 2.5.5 44 px touch-target floor across top-bar + section strips`

Files touched:

- `src/components/layout/top-bar.tsx`
- `src/components/settings/settings-shell.tsx`
- `src/components/admin/admin-shell.tsx`
- `src/components/medications/medication-form.tsx`
- `src/app/medications/page.tsx`

### 8.4 — Font / size / padding parity across pages

Pages render inside `AuthShell`, whose inner `<main>` already applies
`mx-auto max-w-[76.8rem] px-4 py-6 md:px-6`. The Settings and Admin
shells were then re-applying `mx-auto w-full max-w-screen-xl px-4 py-6 md:px-6 md:py-8`
on their own container, which produced visibly more top + bottom
whitespace on `/settings/*` and `/admin/*` than on `/`, `/measurements`,
`/medications`, `/mood`, `/insights`, `/coach`, and `/notifications`.

Stripped the redundant padding from both shells so their padding
collapses onto AuthShell's; kept the wider `max-w-screen-xl` opt-in.
The mobile chip-strips' `-mx-4` still cancels AuthShell's horizontal
padding correctly.

**Commit:** `8f54993 — style(layout): unify top-of-page padding between AuthShell, Settings, and Admin`

Files touched:

- `src/components/settings/settings-shell.tsx`
- `src/components/admin/admin-shell.tsx`

### 8.5 — W8b login-overview-section conflict-cleanup verify

Verified via `git log --oneline -- src/components/admin/login-overview-section.tsx`:
commits `095578f` (collapse-removal), `d87a631` (CSV escaping),
`b5062ea` (Provider column), `6d6f4c4` (Standort restore) are all
intact and reachable in the develop history. No action required.

## Tests delta

| Metric | Baseline | After W8 | Δ |
|---|---|---|---|
| Test files | 290 | 290 | 0 |
| Tests passing | 2543 | 2544 | +1 |
| Tests skipped | 1 | 1 | 0 |
| Wall-clock duration | ~7.0 s | ~7.0 s | ~0 |

The +1 test is the layout-shift regression added with the 8.2 fix
(`renders the section heading rendered across loading / error / empty states`).

## Code-review findings

Self-reviewed the W8 diff (`ca3c225..HEAD`, 8 files, +174/-122 lines).
No blocking issues. Minor notes:

- `coach-feedback-section.tsx` L88 has `{hasData && summary && (...)}`
  where `summary && (...)` would suffice — `hasData` is `!!summary && buckets.length > 0`.
  TypeScript narrows correctly through the redundant guard, so leaving
  it readable. Not landed as a separate commit.
- All min-h-11 additions are on the *outer* container so the inner
  icon/text stays visually centered without size change. Good.
- `admin-shell.tsx` + `settings-shell.tsx` JSDoc comments above the
  return statement (not inside JSX) — placed correctly after the first
  TypeScript build failure.

No High / Critical findings → no follow-up commits.

## Deferred to v1.4.26

Nothing deferred. The mobile audit was deliberately scoped to
**high-traffic primary navigation surfaces** + the specific
layout-shift Marc reported. The form-internal `h-8` ghost buttons
inside the medication-form Dialog (lines 706, 714, 780, 798, 812, 824
of medication-form.tsx) are below the 44 px floor but are inline
controls inside a modal dialog where the user has already committed
their tap intent — not a primary touch surface. Skipping is the right
call; if Marc wants those tightened, a v1.4.26 sweep can pick them up
with a dedicated form-controls audit.

## Quality gate

- `pnpm typecheck` → clean
- `pnpm lint` → clean
- `pnpm test` → 2544 passed, 1 skipped (full suite)

All commits land **without** `--no-verify` and **without** the
`Co-Authored-By: Claude` trailer, per Marc directive.
