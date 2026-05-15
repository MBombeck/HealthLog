# Round 3d — MB6 — v1.4.27 regression fixes + auth and public-page polish

Branch: `develop`
Commits: `fc8a5855`, `de0c1633`, `117eb87f`, `e52b64bf`
Scope: CF-4, CF-5, CF-6, CF-15, CF-16, CF-23, CF-24, CF-25, CF-26, CF-62, CF-65.

The two unconditional v1.4.27 regressions are resolved: `/about` now
returns 200 unauthenticated, and every insights empty-state CTA now
links into the live `/measurements` page (no more 404). The
measurements page auto-opens the add-measurement dialog with the
right `defaultType` from the query param.

## Commits

### Commit 1 — `fc8a5855`

`fix(auth): unblock the about page for unauthenticated visitors`

- `src/components/layout/auth-shell.tsx` — `/about` joins the
  client-side `PUBLIC_PATHS` list. `isStandalonePublicPage` also
  matches `/about` so the route renders edge-to-edge with its own
  header/footer (same shape as `/privacy`); the public-page wrapper
  would have centred the credit page into the sign-in card frame.
- `src/app/about/page.tsx` — sticky header gains
  `pt-[env(safe-area-inset-top)]` so the brand row clears the iOS
  notch / Dynamic Island on the credit page.
- `src/app/privacy/page.tsx` — same safe-area treatment on the
  privacy sticky header. A default-closed `<details>` Contents TOC
  is mounted above the body with anchor links to every numbered
  section so a long-form policy stays navigable on a narrow viewport
  without forcing the reader past three screens of text first. The
  19 HealthKit identifier `<code>` elements gain `break-all` so the
  longest camelCase entries (`heartRateVariabilitySDNN`,
  `environmentalAudioExposure`) wrap inside narrow viewports.

CF-IDs cleared: CF-5, CF-25 (privacy + about), CF-26, CF-62.

### Commit 2 — `de0c1633`

`fix(auth): lift the register submit button and add a branded
not-found page`

- `src/app/auth/register/page.tsx` — submit button promoted to
  `size="lg"` + `min-h-11 w-full` so the primary action stays
  finger-tap reachable on narrow viewports. Lines distinct from
  MB3's aria-invalid wiring inside the form fields.
- `src/app/not-found.tsx` — new file. Decision-L lighter wrapper:
  branded `<Logo>` + 404 eyebrow + headline + paragraph + a single
  "Back to dashboard" `<Link>`. `min-h-dvh` follows the dynamic
  viewport on iOS Safari, `pt-[calc(env(safe-area-inset-top)+3rem)]`
  keeps the headline clear of the notch.
- `src/components/error-details.tsx` — outer wrapper gains
  `min-h-dvh flex flex-col justify-center` so server-error panels
  centre on the available viewport instead of hugging the notch.
  Lines distinct from MB2's action-row button work.
- `src/app/global-error.tsx` — root-level error boundary picks up
  `minHeight: "100dvh"` and a `calc(env(safe-area-inset-top, 0px) +
  24px)` top padding. The two inline buttons (Retry / Copy details)
  lift to `minHeight: 44` with `padding: 10px 16px` to match the
  app-wide tap-target floor.

CF-IDs cleared: CF-6, CF-23, CF-24, CF-65.

### Commit 3 — `117eb87f`

`fix(medications): widen the schedule day-of-week grid for narrow
viewports and drop the DrugLevelChart dead axis labels`

- `src/components/medications/medication-form.tsx` — the schedule
  day-of-week row was previously one flex row carrying the wide
  "Daily" pill (min-w-24 ≈ 96 px) plus seven weekday pills with
  `flex-1`. At 320 px the row exceeded the form width and the last
  weekday clipped off-screen. The new layout stacks the Daily pill
  above a fixed `grid grid-cols-7` so every weekday keeps the 44 px
  tap-target floor regardless of container width. Lines distinct
  from MB1's `<ResponsiveSheet>` mount, MB2's reset kebab, and MB3's
  input attribute work elsewhere in the same file.
- `src/components/medications/DrugLevelChart.tsx` — dropped two
  dead axis decorations:
  - empty `<text>` child of `<XAxis>` (no content, painted an
    invisible SVG node beneath the x-axis).
  - duplicate Recharts `label={…}` prop on `<YAxis>` that tried to
    paint the unit-less caption inside a 1 px-wide axis where it
    could never be read.
  The external `<p>` above the chart remains the single source of
  truth for the caption. Lines distinct from MB7's `md:p-6` drop on
  the same component.

CF-IDs cleared: CF-4, CF-16.

### Commit 4 — `e52b64bf`

`fix(insights): point the empty-state CTAs at the existing
measurements route`

- `src/app/insights/blutdruck/page.tsx` — CTA href
  `/measurements/new` → `/measurements?add=BLOOD_PRESSURE`.
- `src/app/insights/gewicht/page.tsx` — CTA →
  `/measurements?add=WEIGHT`.
- `src/app/insights/puls/page.tsx` — CTA →
  `/measurements?add=PULSE`.
- `src/app/insights/bmi/page.tsx` — CTA →
  `/measurements?add=WEIGHT` (BMI is derived from weight).
- `src/app/measurements/page.tsx` — new `?add=<TYPE>` consumer. The
  page reads `useSearchParams()` during render, opens the
  `<ResponsiveSheet>` with `defaultType` set, then
  `router.replace('/measurements')` strips the query so the back
  button returns to a clean URL. The render-driven `setState` uses
  a `consumedAddParam` sentinel (same pattern as
  `account-section.tsx`) so the strict
  `react-hooks/set-state-in-effect` lint rule passes. An allow-list
  mirrors `MEASUREMENT_TYPES` inside `measurement-form.tsx` so a
  stale or attacker-crafted `?add=` value is dropped silently.

The mood, sleep, and medication empty-states already pointed at
their own dedicated routes (`/mood`, `/settings/data-sources`,
`/medications`) and need no change.

CF-IDs cleared: CF-15.

## Gate results

- `pnpm typecheck` — clean.
- `pnpm lint` — clean for MB6 files (only pre-existing sibling
  warnings remain).
- `pnpm vitest run src/components/__tests__/error-details.test.tsx
  src/app/privacy/__tests__/page.test.tsx
  src/components/medications/__tests__/DrugLevelChart.test.tsx
  src/components/measurements/__tests__/` — 4 + 9 + 10 + 16 = 39
  tests pass.

## Verification of the two regressions

- `/about` returns 200 unauthenticated: confirmed by inspecting
  `auth-shell.tsx` — `/about` is now in `PUBLIC_PATHS` and matched
  by `isStandalonePublicPage`. Combined with the existing entry in
  `proxy.ts` PUBLIC_PATHS the page bypasses the auth redirect end
  to end.
- Insights empty-state CTAs route into the live measurements page:
  confirmed via the new query-param consumer. A tap from
  `/insights/blutdruck` (no BP readings) lands on
  `/measurements?add=BLOOD_PRESSURE`, the page render-time consumer
  opens the dialog with `defaultType="BLOOD_PRESSURE"`, and
  `router.replace` strips the param so the URL becomes
  `/measurements` while the dialog is visible.

## Coordination notes

- The schedule day-of-week grid swap (CF-4) and DrugLevelChart dead
  label drop (CF-16) landed in one commit per the plan; the schedule
  changes are distinct lines from MB1's mount swap, MB3's
  input-attribute work, and MB7's `phase-config-dialog.tsx` row.
- ErrorDetails wrapper lift (CF-65) was sequenced after MB2's
  action-row touch; the diff was line 76 only.
- Privacy + about safe-area work (CF-25) overlaps MB2's existing
  `min-h-11` header link work; both already landed before MB6
  started.
- `not-found.tsx` is English-only; the i18n follow-up commit will
  fan keys when the page picks up a translated string set.
- The measurements page query-param consumer ran into the strict
  `react-hooks/set-state-in-effect` ESLint rule on the first
  iteration. The fix follows the codebase convention from
  `account-section.tsx`: pair the prop value (here the search-param
  string) with a "have we acted on this value yet" sentinel state
  and let render fire the open + replace transition once per
  unique input.
- Working-tree churn from parallel sibling agents repeatedly
  reverted the empty-state CTA edits to the four insights pages
  during the same window the schedule + chart commit was landing.
  The CTA edits were re-applied and locked in immediately via
  `git add` + `git commit` in the same Bash invocation to win the
  race.

## Files changed

- `src/components/layout/auth-shell.tsx` — `PUBLIC_PATHS` add
  `/about`; `isStandalonePublicPage` matches `/about`.
- `src/app/about/page.tsx` — `pt-[env(safe-area-inset-top)]` on the
  sticky header.
- `src/app/privacy/page.tsx` — same safe-area pattern on the sticky
  header; new collapsible Contents TOC; 19 HealthKit `<code>`
  elements gain `break-all`.
- `src/app/auth/register/page.tsx` — submit button `size="lg"
  min-h-11 w-full`.
- `src/app/not-found.tsx` — NEW; branded 404 page per Decision L.
- `src/app/global-error.tsx` — `100dvh` + `safe-area-inset-top` on
  the wrapper, `minHeight: 44` on the inline buttons.
- `src/components/error-details.tsx` — `min-h-dvh flex flex-col
  justify-center` on the outer wrapper.
- `src/components/medications/medication-form.tsx` — schedule
  day-of-week row stacks the Daily pill above a `grid grid-cols-7`
  weekday grid.
- `src/components/medications/DrugLevelChart.tsx` — dropped the
  empty `<XAxis>` child and the duplicate `<YAxis label={…}>` prop.
- `src/app/insights/{blutdruck,gewicht,puls,bmi}/page.tsx` — empty
  state CTA hrefs swap to `/measurements?add=<TYPE>`.
- `src/app/measurements/page.tsx` — `?add=<TYPE>` consumer with an
  allow-list and a `consumedAddParam` sentinel.
