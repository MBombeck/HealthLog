---
file: .planning/round-3-b7-symmetry-cleanup-report.md
purpose: B7 implementation report for v1.4.27 — symmetry sweep + dead-code cleanup + low-tier polish
contributor: B7
baseline: cef9bc14
landed: d10e0f28
---

# Bucket B7 — implementation report

## Commits

| # | sha       | subject |
|---|-----------|---------|
| 1 | `39fef7d3` | `chore(ui): unify heading weight, card cadence, and label-input gap across settings and admin` |
| 2 | `32a023df` | `chore(ui): apply M7 + L1 + L3 + L4 polish across medication form, motion-reduce, details aria, therapy timeline` |
| 3 | `9b0b1c6b` | `chore(ui): repair stray motion-reduce tokens that bled into JSDoc comments and pair the mood chart spinner` |
| 4 | `205ee1dd` | `chore(api): surface every safeRequestProp fallback through a console warning` |
| 5 | `988bbf1a` | `feat(workouts): wire pickCanonicalWorkout into the list read path and collapse the attach route N+1` |
| 6 | `6a76f746` | `feat(coach): extend the snapshot window enum with lastYear` |
| 7 | `3a7599c8` | `chore(api): delete the orphan /api/audit-log surface and seed the five README-tied admin orphans into v1.4.28` |
| 8 | `3ec1f44d` | `chore(lib): extract shared allMessages and resolveKey between context and server-translator` |
| 9 | `39571c6e` | `chore(lib): derive metricPriorityObjectSchema from SOURCE_PRIORITY_METRIC_KEYS` |
| 10 | `f72d2de2` | `chore(cleanup): retire dead exports across glp1 modules and scheduling helpers` |
| 11 | `d10e0f28` | `chore(charts): align chart-tick timezone handling across the chart surface` |

## Deliverables vs fix-plan

### Commit 1 — heading weight + card cadence + label-input gap (F13 symmetry)

Standardised to `font-semibold` across every divergent `<h2>` / `<h3>` in `src/components/settings/` and `src/components/admin/`. Five files touched:

- `account-section.tsx` — `text-sm font-medium` → `text-sm font-semibold` (two passkey sub-headings)
- `integrations-section.tsx` — withings-credentials sub-heading
- `user-management-section.tsx` — edit + reset-password sub-headings
- `thresholds-editor-section.tsx` — card root `space-y-5` → `space-y-4`
- `ai-section.tsx` — card root `space-y-6` → `space-y-4`

The password-change dialog at `account-section.tsx:610-642` lifted `space-y-1.5` → `space-y-2` across all three label-input pairs.

### Commit 2 — M7 + L1 + L3 + L4 polish

- **M7**: `medication-form.tsx` — Dialog inline-control sweep. Day-of-week and interval buttons (`h-8`) lifted to `min-h-11`; the trailing `<DropdownMenuTrigger>` (`h-9 w-9`) to `h-11 w-11`; label-input gaps (`space-y-1.5`) to `space-y-2`.
- **L1**: 70 files swept by `python3` script — added `motion-reduce:animate-none` to every `animate-spin` / `animate-pulse` / `animate-bounce` className across `src/components/**` and `src/app/**` (121 token insertions). The drift-on-quote-delimiter bug that hit nine files in this commit was repaired in commit 3.
- **L3**: `inventory-section.tsx` + `coach-panel/message-thread.tsx` get explicit `aria-controls` / `id` pairing between `<summary>` and the disclosed panel; `glp1-medication-card.tsx` already shipped the pattern.
- **L4**: `therapy-timeline.tsx` — sr-only `<h4>{entry.medicationName}</h4>` per timeline entry.

L2 (Health Score disclaimer) — owned by B1 commit 6 per coordination notes. Not re-touched.

### Commit 3 — hotfix for the JSDoc-comment bleed

The L1 motion-reduce script treated apostrophes inside `/* … */` JSDoc bodies as quote delimiters and appended the utility into the comment body across nine files. Repaired each via a targeted regex pass:

- `account-section.tsx` (2 places), `about-section.tsx`, `ai-section.tsx`, `api-token-overview-section.tsx`, `glp1-medication-card.tsx`, `DrugLevelChart.tsx`, `mood-chart.tsx`, `health-chart.tsx`, `glp1-tile.tsx` — total 10 comment fixes.

Also threaded the missing `motion-reduce:animate-none` through the mood-chart spinner that the script had skipped after the working-tree juggle with B6's parallel commits.

### Commit 4 — safeRequestProp warning + verification of BL-P1-2 / BL-P1-4

The W7d narrowing landed earlier in `61d156e7`; what remained was to add the `console.warn` on every fallback so misfires surface in the dev console + run log. Verification of the related items:

- **BL-P1-2** (`BASE_SYSTEM_PROMPT` + `INSIGHTS_SYSTEM_PROMPT` bare exports): already retired in `41c7425b` (chore(ai)). Bare symbol grep returned zero hits; only locale-suffixed `_DE` / `_EN` forms remain, which are out of scope per the deliverable.
- **BL-P1-4** (stale comment at `targets/route.ts:807`): the brace `}` was already cleaned up; the current line reads `// src/lib/ai/prompts/general-status.ts already enforce this`. Verified via line-707 grep before commit.
- **`globals.css` `@source` path**: the path `../../.planning` from `src/app/globals.css` resolves correctly to `<repo-root>/.planning` per Tailwind v4 docs (paths are relative to the stylesheet). The earlier `61d156e7` already pinned `source("../..")` on the `@import` so the auto-detection root is repo-root. No further change.

### Commit 5 — workout dedup wiring + attach-route N+1 collapse

- New `src/app/api/workouts/route.ts` — paginated GET that runs every fetch through `pickCanonicalWorkout()` with `DEFAULT_WORKOUT_SOURCE_PRIORITY` and the 5-min cluster window. Adds `FETCH_MULTIPLIER = 2` so the canonical-page query stays full after dedup.
- `src/app/api/workouts/batch/route.ts` — the `Promise.all(withoutExternal.map(p => tx.workout.findFirst(...)))` route-attach loop collapses to a single batched `tx.workout.findMany` with one `OR` row per entry. Per-batch round-trip count drops from 1+N to 2 for a 100-row batch; the createdAt-DESC tie-break is preserved via in-memory grouping.
- New `src/app/api/workouts/__tests__/canonical-dedup.test.ts` — four cases: twin collapse, proximity-window separation, sport-type isolation, limit clamp.

### Commit 6 — Coach `lastYear` snapshot window

- `types.ts` — added `lastYear` to `coachScopeWindowSchema` between `last90days` and `allTime`; extended `CoachProvenance.windows` union.
- `snapshot.ts` — `windowToDays(lastYear) === 365`. Seeded the provenance window set with the resolved scope window so the source-chip surfaces the year-in-review chip even when the per-metric branches only add `last30days` / `last90days`.
- `__tests__/snapshot.test.ts` — added `respects the scope.window — lastYear flags the year-in-review window` assertion.
- `source-chips.tsx` — added `lastYear` entry to `WINDOW_KEYS` so the i18n resolver looks up `insights.coach.window.lastYear`.

The `insights.coach.window.lastYear` i18n key is missing across all six locale bundles. Resolves through the fallback chain to the raw key string until B6 lands the translations; the key is deferred to v1.4.28 in the backlog file.

### Commit 7 — orphan endpoint deletions + v1.4.28 defer

Orphan-endpoint grep verification (each `grep -rln <route> src/`, plus follow-up grep in `tests/`, `scripts/`, `playwright/`, `e2e/`, root docs):

| Endpoint | src callers | tests/scripts | README | CHANGELOG | AGENTS | Action |
|---|---|---|---|---|---|---|
| `/api/audit-log` | 0 | 0 | — | — | — | **deleted** |
| `/api/admin/ai-settings` | 0 | 0 | L362–363 | L752, L3261 | — | defer v1.4.28 |
| `/api/admin/backup/test` | 0 | 0 | L368 | L752 | — | defer v1.4.28 |
| `/api/admin/status-overview` | 0 | tests/ exists | L367 | L753 | L194 | defer v1.4.28 |
| `/api/monitoring/glitchtip/test` | 0 | tests/ exists | L381 | — | — | defer v1.4.28 |
| `/api/monitoring/umami/test` | 0 | tests/ exists | L382 | — | — | defer v1.4.28 |

The `/api/audit-log` deletion is one route file (1 281 B). No DTO or test fixture existed; the planning text mentioned them as "DELETE candidates" but the surface had already been pared back by an earlier sweep.

Five admin / monitoring endpoints defer to v1.4.28 — per the fix-plan directive, a README mention counts as a consumer reference. The v1.4.28 backlog seed captures each grep finding plus the maintainer-decision framing.

The `insights.coach.window.lastYear` i18n key is also seeded into the v1.4.28 backlog under B7 (B6 territory).

### Commit 8 — shared `allMessages` + `resolveKey` extract

New `src/lib/i18n/shared-resolve.ts` with the per-locale message map and the dotted-key resolver. `context.tsx` and `server-translator.ts` both import from it; the two duplicate copies are gone. Net 61/-66 LOC.

### Commit 9 — derive `metricPriorityObjectSchema`

The 14-key listing on `metricPriorityObjectSchema` and the parallel 14-key block on `sourcePrioritySchema`'s flat shape now derive from `SOURCE_PRIORITY_METRIC_KEYS` via `Object.fromEntries`. Adding a metric class is a single-line constant edit instead of three parallel listings.

### Commit 10 — dead-export retirement + simp-M6 / simp-M7 / BL-P4-5

**glp1-knowledge.ts** — 8 of the 10 export symbols flagged by dead-M5 dropped via export-keyword removal (kept as internal types). `routeForBrand` and `GLP1_DRUG_IDS` retained as exports because grep showed the glp1-knowledge + ladder test suites read them; the deliverable's "10 unused" count was test-aware and the actual prod-only count is 8. Per-symbol verification table:

| Symbol | prod refs | test refs | Action |
|---|---|---|---|
| `Glp1Route` | 0 | 0 | export → internal type |
| `Glp1DrugClass` | 0 | 0 | export → internal type |
| `Glp1Pharmacology` | 0 | 0 | export → internal type |
| `Glp1Storage` | 0 | 0 | export → internal type |
| `Glp1Pen` | 0 | 0 | export → internal type |
| `Glp1AdverseReactions` | 0 | 0 | export → internal type |
| `Glp1Indications` | 0 | 0 | export → internal type |
| `Glp1SourceCitations` | 0 | 0 | export → internal type |
| `routeForBrand` | 0 | 1 (glp1-knowledge.test) | kept (test-only reader) |
| `GLP1_DRUG_IDS` | 0 | 2 (glp1-pk.test, ladder.test) | kept (test-only reader) |

**scheduling/cadence.ts** — `ExpectedDose` interface drops its `export` keyword (used internally only). The dead-M7 surface called out `ExpectedDose` plus several functions (`expandScheduleSlots`, `pairDoses`, `missedDoses`) — but the latter three are read by `__tests__/cadence.test.ts`, so they stay exported.

**simp-M6**: `pairDoses` — replaced the centre-sort + windowStart re-sort double-pass with a single `windowStart` sort. Sorting by `windowStart` and by `(start+end)/2` produce the same order for non-overlapping windows (which is the only shape pairDoses sees).

**simp-M7**: `escalationDue` parameter rename `drugId` → `drugIdForCeiling` + per-parameter JSDoc clarification per the W21-simplifier finding.

**BL-P4-5**: `__testables.WEEKDAY_KEYS` plus the underlying private constant retire from `glp1-snapshot.ts` (zero callers anywhere).

### Commit 11 — chart-tick timezone audit (BL-P4-2)

The five chart files called out in the deliverable (`sleep-stage-stacked-bar`, `mood-chart`, `health-chart`, `medication-compliance-chart`, plus broader insights surface) all anchor their day-key computations at `Date.UTC(...)` and route ticks through the timezone-aware `tzFmt.date` / `tzFmt.dateShort` pair. They audit clean.

The outlier was `src/components/charts/compliance-heatmap.tsx`:

- Tooltip date formatter parsed the day-key against local tz (`new Date(dateStr + "T00:00:00")`). Pinned to `T00:00:00Z` + `getUTC*` accessor trio.
- The heatmap walk read `getDay()` / `getMonth()` (server-tz) while the dateKey was UTC-anchored via `toISOString().slice(0, 10)`. The Monday-alignment and month-marker placement could land one cell off on an SSR pass running on a non-Berlin host. Swapped to `getUTCDay()` / `getUTCMonth()`.

## Verification

Per-commit gate: `pnpm typecheck` + `pnpm lint` + relevant `pnpm test` — all green on every commit. Final full-suite run at HEAD (d10e0f28): 355 test files, 3 976 tests passing + 1 skipped (no regressions vs the cef9bc14 baseline).

## Deviations from the fix-plan

1. **Estimated commit count**: 7 atomic listed in the fix-plan vs 11 landed. The mid-flight directive ("pack everything in we can") added simp-M6 / simp-M7 / BL-P4-5 / BL-P4-11-S1 / BL-P4-11-S10 / dead-M5 / dead-M7 / BL-P2-3 / BL-code-M3 / BL-P4-2 to B7's scope. The 11 commits split those across thematic concerns without packing unrelated items together.

2. **Commit 3 (hotfix)** was not in the deliverable list — it repairs the broken-comment side-effect of commit 2's L1 sweep. Folded as a small follow-up commit per the directive "If you break a gate, fix the root cause and create a NEW commit — never `--amend` on a hook-rejected commit." The original commit 2's hooks all passed; the broken comment was a runtime-quiet drift caught on the next typecheck pass.

3. **BL-P1-2 / BL-P1-3 / BL-P1-4** were largely no-ops because earlier commits in the v1.4.27 cycle (`41c7425b`, `61d156e7`) had already retired the bare symbol exports + narrowed `safeRequestProp` + cleaned the targets-route stale comment. The remaining piece for commit 4 was the `console.warn` addition on the `safeRequestProp` fallback, which surfaces a tolerated misfire in dev.

4. **Five admin / monitoring orphan endpoints** deferred to v1.4.28 rather than deleted in commit 7. The README references count as consumer per the fix-plan directive; defer is the documented call.

5. **`globals.css` `@source` "fix"** was no-op for the same reason — the path already resolved correctly to `<repo-root>/.planning` per Tailwind v4's relative-to-stylesheet semantics. Confirmed via Tailwind v4 docs query.

6. **`pickCanonicalWorkout` wiring** created a new `GET /api/workouts` route from scratch because no list/read route existed yet; the fix-plan listed the file path but the file was greenfield. The picker contract stays a pure function as specified; the route owns the query window + the response-meta envelope.

7. **`B6 territory respected**: messages/*.json, mood/labels.ts, i18n-drift-guard.test.ts left untouched. Where my motion-reduce sweep accidentally touched a file B6 had uncommitted edits in (mood-list.tsx, mood-chart.tsx), the working tree was left intact for B6 to land alongside their refactor; B6 committed the merge atomically in `22b11427`.

## Untouched untracked files

These untracked files were present in the working tree at the start of the session (created by earlier contributors) and remain untracked:

- `.planning/v1422-w1a-insights-probe.mjs`
- `.planning/v1422-w1a-targets-probe.mjs`
- `.planning/v1422-w1a-tokens-probe.mjs`
- `scripts/audit-a6.mjs`
- `scripts/audit-a6-v2.mjs`

No B7 work depends on them; left for the next contributor or for `.gitignore` cleanup.
