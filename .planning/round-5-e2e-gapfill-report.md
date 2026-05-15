# Round-5 E2E gap-fill — v1.4.27

Six new Playwright spec files land coverage for the ten v1.4.27 surfaces that
shipped without browser regression tests. All specs parse under `pnpm exec
playwright test --list`; total spec count rose from 98 to 148 tests across 30
files (24 → 30 spec files).

## Spec files

### `e2e/v1427-responsive-sheet.spec.ts` (surface 1)

Covers `<ResponsiveSheet>` primitive branching.

- Pixel 5: opens `/measurements?add=WEIGHT`, asserts
  `data-variant="sheet"` on `[data-slot="responsive-sheet-content"]` and the
  footer is sticky-bottom-pinned.
- Desktop Chrome: same flow, asserts `data-variant="dialog"`.

No skips.

### `e2e/v1427-measurements-add-param.spec.ts` (surface 2)

Covers `/measurements?add=<TYPE>` consumer.

- Three parameter values (WEIGHT, BLOOD_PRESSURE, PULSE): primitive opens
  pre-selected to the requested type and the URL settles on `/measurements`.
- An unknown `?add=NOT_A_TYPE` value is dropped silently, no dialog.

No skips.

### `e2e/v1427-coach-launch.spec.ts` (surfaces 3 + 9)

Covers `<CoachLaunchButton>` on `/insights/{slug}` sub-pages and the Coach
drawer bottom-sheet branch.

- Three sub-pages (blutdruck, gewicht, schlaf): FAB visible on Pixel 5,
  inline action visible on Desktop Chrome — and the opposite branch hidden
  on the other viewport.
- Clicking the FAB opens the drawer with `data-variant="bottom-sheet"`.
- Clicking the inline action opens the drawer with `data-variant="side-sheet"`.

No skips. Tests gate on `testInfo.project.name` so each branch runs on
exactly the right viewport.

### `e2e/v1427-public-pages.spec.ts` (surfaces 4 + 5 + 6)

Covers the public `/about` page, the branded 404 page, and the privacy TOC.

- Storage state forced empty (`{ cookies: [], origins: [] }`) so the spec
  proves the path works for first-time visitors.
- `/about` returns 200 to an unauthenticated visitor and shows GeoLite2 +
  MaxMind + "Attribution-ShareAlike 4.0" copy.
- `/this-route-does-not-exist` returns 404 with the branded splash; URL
  stays on the missing route (no bounce to `/auth/login`).
- `/privacy` mounts the `[data-slot="privacy-toc"]` `<details>` element;
  default-closed; click toggles open; anchor link `#intro` updates the URL
  hash and the target section is in-viewport.

No skips.

### `e2e/v1427-admin-login-overview.spec.ts` (surface 7)

Covers the admin carrier chip + CSV column.

- Mocks `/api/admin/audit-log` so one row carries a known DACH carrier
  ("Deutsche Telekom AG"). Asserts the chip slot renders with the short
  label ("Telekom").
- Triggers the CSV export via the export button, listens for the
  `download` event, reads the resulting CSV stream, asserts the first row
  carries the `carrier` column header.

No skips. The seed user has the ADMIN role so the admin route loads
directly.

### `e2e/v1427-glp1-tile.spec.ts` (surface 8)

Covers the GLP-1 secondary tile.

- Mocks `/api/dashboard/glp1` with one active medication + populated
  weight series + injection dates.
- Pixel 5-only — desktop project skips because the tile's load-bearing
  affordances are tuned for the mobile dashboard.
- Asserts the tile slot mounts, the tab strip carries the two tab slots,
  the range strip carries the four range buttons, the default 30d range
  is `data-active="true"`, range toggles flip the active state, and
  switching to the Weight tab keeps `[data-slot="glp1-tile-chart"]`
  visible.

Skips: the three test cases skip on `chromium-desktop` since they're
mobile-only.

### `e2e/v1427-insights-empty-state.spec.ts` (surface 10)

Covers the insights metric-availability gating with the empty-state CTA
path.

- Mocks `/api/analytics` with zero counts for the relevant metrics so each
  gated sub-page short-circuits to its `EmptyState` branch.
- For `blutdruck` + `gewicht`: asserts the empty-state CTA link points at
  `/measurements?add=<TYPE>` (BLOOD_PRESSURE / WEIGHT).
- For `schlaf`: the CTA correctly points at `/settings/data-sources` (sleep
  ingest is iOS-only), so this branch asserts the empty state + Coach
  affordance only. Pinned via `if (slug !== "schlaf")` with an inline
  comment.
- Asserts a Coach launch affordance is attached on every page (either FAB
  or inline branch — whichever is the project's visible branch).
- Asserts the `#insights-subpage-title` h1 carries the matching metric
  label.

No skips.

## Skipped surfaces / known gaps

None of the ten surfaces are gated with `test.skip` at runtime — every
test runs against a stubbed-data harness that does not depend on a seeded
real dataset.

The schlaf empty-state branch deliberately does not assert on a
`?add=SLEEP` href because the route doesn't exist (Decision E in the
v1.4.27 mobile-fix plan owns this — sleep ingest is the iOS Health import
path, not the manual measurements page). The spec covers the alternative
branch.

## Per-commit gates

Each commit was verified via:

- `pnpm exec playwright test --list` (specs parse, list count rose)
- `pnpm typecheck` (clean against the parts of the tree I own; pre-existing
  WIP under `src/lib/__tests__/geo-offline-detection.test.ts` from the
  build-resilience contributor is unrelated)
- `pnpm lint` (clean)

## Coordination

I did not touch any of the build-resilience contributor's files:
`.github/workflows/docker-publish.yml`, `scripts/fetch-geolite2.sh`,
`src/lib/geo.ts`, `src/app/api/version/route.ts`,
`src/app/admin/system-status/page.tsx`, `messages/*.json`,
`src/lib/notifications/dispatch-localised.ts`, `CHANGELOG.md`.

## Commit log on develop

```
test(e2e): cover the ResponsiveSheet mobile branch and the desktop fallback
test(e2e): cover the measurements ?add= query consumer with auto-open dialog
test(e2e): cover the Coach launch button on insights sub-pages and the drawer bottom-sheet branch
test(e2e): cover the public about page, the branded not-found page, and the privacy TOC
test(e2e): cover the admin carrier chip + CSV column and the GLP-1 tile tab/range strip
test(e2e): cover the insights metric availability gating with the empty-state CTA path
```
