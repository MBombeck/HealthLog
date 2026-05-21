# v1.4.42 Design-review findings

## Verdict
APPROVE

## Critical (visible regression — CLS / contrast / a11y break)
None.

## High (placeholder mismatch, focus order, motion)
None.

## Medium
None.

## Low
None.

## Strengths

- **Tile-strip placeholder now byte-for-byte matches the live `TrendCard` chrome.**
  `src/app/page.tsx:1416` — fallback className is
  `bg-card border-border flex h-full min-h-[6rem] w-full min-w-0 flex-col rounded-xl border p-4 md:p-6`.
  Compared against the live tile container at
  `src/components/charts/trend-card.tsx:241`
  (`bg-card border-border flex h-full w-full min-w-0 flex-col rounded-xl border p-4 md:p-6`),
  the placeholder is the same class set plus the explicit
  `min-h-[6rem]` for the all-suspend edge. Closes v1.4.41 L1 + L2
  follow-ups in one motion. No `gap-*` / `space-*` / `items-*` drift
  on the live tile — the children-positioning chrome (`flex
  min-w-0 flex-col`) is the entire layout contract on the
  `TrendCard` root.

- **`aria-hidden="true"` retained and still correct.** The placeholder
  is a self-closing `<div />` — no descendants exist that could be
  focusable, so adding `flex min-w-0 flex-col` cannot accidentally
  surface a tab stop. Focus order is unaffected.

- **Suspense double-comment consolidation is documentation-only.**
  `src/app/page.tsx:1402-1411` — the v1.4.40 W-RSC + v1.4.41
  W-FRONTEND-FACTORY block pair collapsed into one 9-line block with
  a single-line history trailer. JSX structure is byte-identical:
  the `<Suspense fallback={…}>{entry.node}</Suspense>` markup, the
  `<div key={entry.id} className="flex min-w-0">` wrapper, and the
  `trendCards.map` outer scaffold all stayed in place. The
  structural Suspense test pin
  (`src/app/__tests__/dashboard-suspense-boundaries.test.ts`) keys
  on the `aria-hidden="true"` marker and the `<Suspense>` count, not
  on comment text — stays green.

- **queryKey factory long-tail migration (`e2018b2d`) is a pure
  refactor across 40 files.** Every change in
  `src/components/{settings,medications,admin}`, `src/hooks/`, and
  three `src/app/medications` / `src/app/targets` files follows the
  same pattern: `queryKey: ["literal", …]` → `queryKey:
  queryKeys.<entry>(…)`. Spot-checked
  `src/components/settings/ai-section.tsx`,
  `src/components/settings/integrations-section.tsx`,
  `src/components/medications/medication-card.tsx`,
  `src/components/medications/glp1-medication-card.tsx`,
  `src/components/medications/intake-history-list-v2.tsx`,
  `src/components/admin/login-overview-section.tsx`,
  `src/hooks/use-workouts.ts` — every diff is a queryKey / invalidate
  call-site rewrite. No queryFn body, no JSX, no className, no copy,
  no enabled-gate, no select shape, no staleTime changed. Design
  surface is byte-identical.

- **Factory-entry shape parity is test-pinned.**
  `src/lib/__tests__/query-keys.test.ts:104-167` asserts the literal
  array shape for every new entry — `medicationCompliance` ↔
  `["medications", id, "compliance"]`, `withingsStatus` ↔
  `["withings", "status"]`, `adminAuditLogFiltered` ↔ 10-element
  array with `(filter, page, perPage, actor, actionFilter, target,
  range)` in the same positional order the prior bare-literal used.
  `workoutsRecentList(opts)` returns `["workouts", "recent", opts]`,
  matching the prior `[...queryKeys.workoutsRecent(), opts]` shape.
  Cache-slot identity preserved → no silent eviction on first paint
  after deploy.

- **iOS Workouts dedup is a write-side-only change.** The new
  `pickCanonicalWorkoutRows()` runs pre-`createMany` inside
  `src/app/api/workouts/batch/route.ts:255-303`. Losers surface to
  iOS as `{ index, status: "duplicate" }` — the exact per-entry
  envelope shape pinned by
  `src/app/api/workouts/__tests__/batch-create.test.ts`. The three
  pre-existing envelope tests were updated to space their two-row
  payloads outside the new 90 s dedup window so they continue to
  exercise envelope semantics rather than collide with the W5 pass.
  iOS UI is not touched.

- **Doctor-report PDF rendering path is unaffected by the regex
  rewrite.** `src/lib/doctor-report-data.ts:171` swaps a control-byte
  character class for the equivalent `[\x00-\x1F\x7F]`. Same regex
  semantics (NUL through US + DEL); the file just becomes UTF-8
  source rather than a binary blob. `sanitisePracticeName()` is
  consumed by `src/app/api/doctor-report/route.ts` and
  `src/app/api/doctor-report/pdf/route.ts` — the PDF renderer
  downstream sees identical bytes for any practice-name input.

- **No bare-literal queryKey leaks remain in the newly-guarded
  surface.** `eslint-plugins/healthlog/queryKey-factory.js` extended
  `GUARDED_DIRECTORIES` to cover the four migrated trees plus three
  named files; the lint rule + the in-repo factory-walker test
  (`src/lib/__tests__/query-keys.test.ts:263-290`) ensure a future
  PR introducing a bare-literal in `settings/`, `medications/`,
  `admin/`, or `src/hooks/` lands red before merge. Design tokens
  for cache invalidation are now a single-source-of-truth concern.
