# Round 3d — MB5 — Tables → mobile card-list parity (in-scope subset)

Branch: `develop`
Commits: `c77d5252` (commit 1), `0fb0235d` (commit 2)
Scope: CF-19 (`/settings/api` 3 tables), CF-21 (pagination + CSV out of scroll wrappers).
Deferred per Decision O: MA6-F2 / CF-20 six admin tables card-list → v1.4.28.

## Commits

### Commit 1 — `c77d5252`

`feat(settings): pair the API section tables with a mobile card-list rendering`

`src/components/settings/api-section.tsx` gains three dual-rendered tables:

- **API endpoint catalogue** — desktop `<table>` behind `hidden md:block`,
  mobile `<ul data-testid="settings-api-endpoints-mobile-list">` with
  labelled meta rows (method badge + path, Authentication, Body example).
  The catalogue is array-driven so adding a new endpoint stays a
  one-line edit on both surfaces.
- **Active tokens table** — desktop unchanged behind `hidden md:block`,
  mobile `<ul data-testid="settings-api-tokens-mobile-list">` stacks
  name + status badge + Permissions / Created / Last-used as labelled
  paragraphs and exposes a full-width revoke button that clears the 44pt
  tap-target floor. Empty-state on mobile uses a dashed-border
  placeholder so the active-token zero state isn't a blank space.
- **Revoked tokens table (collapsible)** — same pattern, read-only
  mobile card list under
  `<ul data-testid="settings-api-tokens-revoked-mobile-list">`.

Test coverage: `src/components/settings/__tests__/api-section-responsive.test.tsx`
(5 cases) pins:

- desktop table behind `hidden md:block`
- mobile card lists present with stable `data-testid` anchors
- mobile cards contain the same data points as the desktop table
- mobile lists carry no `overflow-x-auto` wrapper
- desktop tables remain mounted (no deletion of the existing surface)

### Commit 2 — `0fb0235d`

`fix(admin): move pagination and CSV export out of the table scroll containers on login-overview and app-log-preview`

`src/components/admin/login-overview-section.tsx` — the empty-state-or-table
branch now renders a `<>` fragment with two siblings:

1. `<div class="overflow-x-auto">…<table/></div>` — table keeps its scroll
   container so wide audit rows pan horizontally on touch.
2. `<div data-testid="login-overview-pagination">` — summary "showing X
   of Y" + prev/next controls + page-N-of-M label, all outside the
   scroll wrapper.

CSV-export button was already in the toolbar row above the table,
unchanged. The recent B3 carrier-chip layout in the auth-provider cell
is untouched.

`src/components/admin/app-log-preview-section.tsx` — same fragment
treatment. Summary line moves under
`<div data-testid="app-log-preview-summary">`. The refresh button was
already in the section header above the wrapper.

Test coverage:
- `src/components/admin/__tests__/login-overview-pagination-position.test.tsx`
  (3 cases) pins the pagination data-testid and asserts the pagination
  div opens after the scroll wrapper has closed and the prev/next button
  copy is not nested inside the wrapper.
- `src/components/admin/__tests__/app-log-preview-summary-position.test.tsx`
  (3 cases) mirrors the same invariants for the app-logs summary line.

## Gate results

- `pnpm exec eslint <MB5 files>` — clean.
- `pnpm exec tsc --noEmit` — clean for MB5 files. (A separate
  `account-section.tsx` TS error landed from another bucket's in-flight
  work; not in MB5 scope.)
- `pnpm vitest run "src/components/admin/__tests__/"
  "src/components/settings/__tests__/"` — 29 files / 188 tests pass,
  including the 11 new + 17 neighbouring tests touching the changed
  surfaces.

## Coordination notes

- The existing desktop `<table>` rendering was preserved in every case
  per the directive — the mobile surface is purely additive.
- The `<ApiTokenOverviewSection>` admin route already shipped a similar
  card-list pattern in v1.4.16 phase A3; the new settings card-lists
  mirror its conventions (`hidden md:block` for desktop, `<ul>` with
  `md:hidden` for mobile, `bg-muted/30 border-border rounded-lg`
  cards).
- The six admin tables MA6-F2 (`feedback`, `backups`, `app-logs`'
  ai-quality + coach-feedback siblings) were NOT touched per Decision O.
  The audit-log table inside `login-overview-section.tsx` was modified
  for the pagination-position fix only; its mobile card-list parity
  remains v1.4.28 scope.
- A pair of insights-coach tests were already failing pre-MB5 from
  another bucket's in-flight Coach mount work; confirmed via
  `git stash`. Not in MB5 scope.
- Working-tree churn from parallel agents repeatedly clobbered the
  manual edits to the two admin section files. The final commit was
  produced by applying the textual replacements via a Python script
  and staging in the same Bash invocation to avoid the race.

## Files changed

- `src/components/settings/api-section.tsx` — dual rendering for 3 tables.
- `src/components/settings/__tests__/api-section-responsive.test.tsx` — new (5 cases).
- `src/components/admin/login-overview-section.tsx` — pagination + summary moved out of scroll wrapper.
- `src/components/admin/app-log-preview-section.tsx` — summary moved out of scroll wrapper.
- `src/components/admin/__tests__/login-overview-pagination-position.test.tsx` — new (3 cases).
- `src/components/admin/__tests__/app-log-preview-summary-position.test.tsx` — new (3 cases).
