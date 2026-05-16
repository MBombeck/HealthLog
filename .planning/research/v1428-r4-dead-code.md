---
file: .planning/research/v1428-r4-dead-code.md
purpose: R4 dead-code scan — orphans introduced or surfaced by the v1.4.28 diff
created: 2026-05-16
contributor: R4 dead-code
---

# R4 — dead-code scan for v1.4.28

The v1.4.28 sweep landed three surface retirements (`Glp1Tile`, `InsightAdvisorCard`, `WeeklyReportView`) plus two GLP-1 detail-page disclosures (`IntakeHistoryList`, `InventorySection`). The R4-v1.4.27 single-commit recommendation also landed — the 14 orphan exported functions/consts from `v1427-r4-dead-code.md §2`, the `__testables` block in `glp1-snapshot.ts`, the legacy `getInsightsSystemPrompt` helper and the `InsightsOutput` interface are all gone from `src/`. `MedicationComplianceChart.compareBaseline` was re-wired with an explicit `void compareBaseline` discard plus a v1.4.27 RC3 caption (Section 7.1 of the predecessor resolved).

What v1.4.28 left behind: a small set of orphans surfaced by the retire moves. The `DrugLevelChart.compact` rendering path lost its only mount (the tile is gone, the standalone medication-detail page mounts without `compact`). `shotPhaseAt` in `glp1-pk.ts` has tests but no production consumer. Two component files (`trends-row.tsx`, `vo2-max-chart-row.tsx`) still declare local `ChartSkeleton` constants identical to the shared one the v1.4.28 H4 fix introduced. Five admin/monitoring routes remain orphan (unchanged decision from v1.4.27 §1.1). The `OpenAPI` route description still names the retired weekly-report block.

No High-tier findings.

## Severity-grouped findings

| Severity | Items | Decision required |
|---|---|---|
| Medium | **3** | Wire vs drop — each is a measurable LOC reduction |
| Low | **9** | Drop-or-keep per item, one-to-three lines each |
| Informational | **3** | Pre-existing or intentional; no action |

---

## Medium findings (3)

### M1 — `DrugLevelChart.compact` mode is unconsumed

`src/components/medications/DrugLevelChart.tsx:123` declares the `compact?: boolean` prop; lines 226, 237, 244, 254, 270, 293, 319, 331 branch on it; lines 115–122 + 228–236 + 461 carry the doc comments. The only consumer was the GLP-1 dashboard tile (retired in `8e5f71b1`). The standalone mount at `src/app/medications/[id]/history/page.tsx:90` does not pass `compact`. `grep -rn "compact=" src/app | grep -i drug` returns zero.

`compact` mode also pulled in the `windowHoursBefore` override (`DrugLevelChart.tsx:133`), which has the same zero consumers post-retire.

**Decision:** drop the `compact` branch + `windowHoursBefore` prop + their three doc-comment blocks. Estimated diff: roughly `-90 / +0` LOC across `DrugLevelChart.tsx`. Risk: low — verified no test exercises `compact={true}`.

### M2 — `shotPhaseAt` is test-only after the tile retire

`src/lib/medications/glp1-pk.ts:303` exports `shotPhaseAt(drug, doses, asOf)`. Grep for the symbol returns only the declaration plus four test assertions in `__tests__/glp1-pk.test.ts:155–171`. The doc comment at line 292 names "the GLP-1 tile" as the consumer — that tile is gone. The `ShotPhase` type at line 301 is consumed only inside the same module.

**Decision:** drop `shotPhaseAt` + `ShotPhase` from the module + the matching test block. Sibling exports `computeOneCompartment` + `RESEARCH_MODE_DISCLAIMER_VERSION` + `PkSample` + `OneCompartmentOptions` still serve `DrugLevelChart.tsx` and `/api/auth/me/research-mode/route.ts` — keep them. Estimated diff: roughly `-60 / +0` LOC.

### M3 — five admin/monitoring routes still orphan (unchanged from v1.4.27 §1.1)

Re-verified at HEAD:

| Endpoint | src callers | tests | README | CHANGELOG |
|---|---|---|---|---|
| `/api/admin/ai-settings` | 0 | 0 | L362–363 | L752, L3261 |
| `/api/admin/backup/test` | 0 | 0 | L368 | L752 |
| `/api/admin/status-overview` | 0 | self-tests | L367 | L753 |
| `/api/monitoring/glitchtip/test` | 0 | self-tests | L381 | — |
| `/api/monitoring/umami/test` | 0 | self-tests | L382 | — |

The v1.4.27 fix-plan parked these in the v1.4.28 backlog (`.planning/v1428-backlog.md:8`). v1.4.28 did not surface a consumer for any of them. Per-endpoint maintainer call still pending: wire-a-consumer (admin status page mount, settings AI panel) vs delete-route-plus-README-line.

**Decision:** carry forward to v1.4.29 unless the maintainer pulls one into v1.4.28. The status-overview endpoint already has a candidate consumer at `src/app/api/admin/backups/route.ts:63` (comment-only reference); the GeoLite2 v1.4.27 work added a new admin system-status page in `82a23069` that *could* mount `/api/admin/status-overview` if that's the intent.

---

## Low findings (9)

### L1 — interface-only `export` keywords (6 symbols)

Six v1.4.28-new interfaces are referenced only inside their declaring module — same pattern as the v1.4.27 §8 zod-derived contract types but **not** zod-backed; these are component-prop / hook-result shapes. Each is a one-word edit (`export interface` → `interface`):

| Symbol | File:line |
|---|---|
| `TimeoutEnvelope<T>` | `src/lib/insights/with-timeout.ts:21` |
| `MetricEmptyStateProps` | `src/components/insights/metric-empty-state.tsx:36` |
| `MobileRailTrayProps` | `src/components/insights/coach-panel/mobile-rail-tray.tsx:33` |
| `AggregatedRow` | `src/lib/measurements/range-aggregation.ts:58` |
| `UseInsightsAnalyticsResult` | `src/hooks/use-insights-analytics.ts:39` |
| `MedicationCardHeaderProps` | `src/components/medications/MedicationCardHeader.tsx:29` |

`DAILY_AGGREGATE_THRESHOLD_DAYS` and `WEEKLY_AGGREGATE_THRESHOLD_DAYS` (range-aggregation.ts:23–24) read as "non-test" hits but the only external consumer is the test file itself, so they're true library-level constants. **Keep** the export keyword on those two — tests are first-class consumers for tuning thresholds.

**Decision:** optional. Drop-the-export pass is a separate hygiene commit; can ride with the M1/M2 sweep.

### L2 — duplicate local `ChartSkeleton` in two components

`src/components/insights/trends-row.tsx:34–36` and `src/components/insights/vo2-max-chart-row.tsx:29–31` each declare a local `const ChartSkeleton = () => (...)` with the same `bg-muted/40 h-[220px]` body. The shared primitive at `src/components/charts/chart-skeleton.tsx:29` (added by v1.4.28 `d286220b` "wire chart-skeleton loading state across dynamic imports") is the canonical version — it paints a richer skeleton with header chrome + sized chart band.

These two are not strictly orphans (the local consts are used inside the same file), but they are the only two `next/dynamic` mounts that did NOT pick up the v1.4.28 skeleton fix. Wiring them through `<ChartSkeleton />` from `@/components/charts/chart-skeleton` would close the L2 finding *and* match the layout-stable behaviour the H4 fix was meant to deliver everywhere.

**Decision:** import the shared `<ChartSkeleton>` in both files; drop the local constants. Estimated diff: roughly `-12 / +4` LOC.

### L3 — stale "GLP-1 tile" comment in `glp1-pk.ts`

`src/lib/medications/glp1-pk.ts:292` — "Surfaces the 'shot phase' chip on the GLP-1 tile (research §2.4)". The tile is gone. If M2 lands the comment goes with it; otherwise trim the line.

### L4 — stale "compact mode … GLP-1 tile" comments in `DrugLevelChart.tsx`

Three blocks reference the retired tile:

| Line | Excerpt |
|---|---|
| 115 | "v1.4.27 B1 — compact rendering for tile-internal mounts (the GLP-1 dashboard tile…)" |
| 228 | "Compact mode mounts the chart inside a host card (the GLP-1 tile) …" |
| 234 | "… made the GLP-1 tile feel oversized relative to the neighbouring trend cards …" |

If M1 lands these go with the `compact` branch. If M1 is deferred, trim "the GLP-1 tile" → "a host card" so the comments don't lie about live surfaces.

### L5 — stale "weekly report" in OpenAPI route description

`src/lib/openapi/routes.ts:757` — `/api/insights/comprehensive` description still reads "Full Insights surface — daily briefing, recommendations with rationale, optional weekly report + storyboard annotations." The `weeklyReport` block was stripped from `src/lib/ai/schema.ts` in v1.4.28; the route no longer emits it. The generated OpenAPI client and the docs site will surface a description that contradicts the schema.

**Decision:** drop "optional weekly report + " from the description. One-line edit.

### L6 — `/api/dashboard/glp1` references in two safety-net comments

The route was deleted in v1.4.28. Two comments still cite it as a representative example of the "no-scope route ⇒ any-token" rule:

- `src/lib/api-handler.ts:323` — naming four routes in a v1.4.25 W10 reconcile note
- `src/lib/__tests__/require-auth-bearer.test.ts:205` — same wording

Both are intentional historical context (the W10 reconcile **did** include `/api/dashboard/glp1`). The example is still semantically valid — the rule applies to any scope-less route — but the cited example no longer exists. Either swap the example for a live scope-less route or strike the parenthetical list.

### L7 — stale `feedback_charts_visual_identity.md` ChartSkeleton justification

`src/components/insights/trends-row.tsx:32` block-comments the local `ChartSkeleton` with "cleared against `feedback_charts_visual_identity.md` — placeholder only, no chart visual change." If L2 lands, the new shared `<ChartSkeleton>` is richer than the local one (header chrome + sized chart band) — that's a visible delta and the comment becomes wrong. The feedback memo's actual rule is "no token reshuffle, no Recharts swap"; the skeleton change is layout-only and does not touch the rendered chart.

**Decision:** when L2 lands, either drop the comment or rewrite it as "skeleton chrome aligned with the dashboard's shared `<ChartSkeleton>` — `feedback_charts_visual_identity.md` covers chart-body identity, which is unchanged."

### L8 — `void compareBaseline` discard is now load-bearing test surface

Resolved in v1.4.27 RC3 (`compareBaseline` is destructured with an explicit `void` discard plus a doc comment at lines 196–202 explaining the prop is intentionally accepted-and-ignored). No further action — flagged only because the v1.4.27 R4 §7.1 "maintainer decision" landed and the file proves the resolution.

### L9 — `MEDICATION_CATEGORIES` import-only consumer

`src/lib/medication-category.ts:4` exports `MEDICATION_CATEGORIES`. The blob scan reports an internal-file-only match. Spot-check returns one cross-file consumer in `src/components/medications/category-select.tsx` that the substring scanner missed because the import collapsed into a named-import block. **No action** — false positive in the heuristic.

---

## Informational (3)

### I1 — v1.4.27 R4 §2 14 orphans all swept

Confirmed at HEAD: every symbol from the v1.4.27 R4 §2 list (`countMessages`, `buildGeneratePrompts`, `_resetSafetyContractsCacheForTests`, `forEachLocaleAndRule`, `getPulseRange`, `trendLinePoints`, `CHART_MINI_HEIGHT_PX`, `formatDateWithWeekday`, `resolveGeneralStatusLocale`, `isSubPageSlug`, `recordHeartbeat`, `EVENT_TYPE_LABELS`, `cleanupExpiredRateLimits`, `sleepStageEnum`) returns zero grep hits in `src/`. The `getInsightsSystemPrompt` helper + `InsightsOutput` interface (§6.1 + §8.1) plus the `glp1-snapshot.ts` `__testables` block (§3.2) are also gone. The v1.4.27 R4 sweep landed in full.

### I2 — i18n keys clean (`pnpm test … i18n-locale-integrity` 26/26)

Re-run at HEAD passes. The new `insights.coach.window.lastYear` key (added in `75773ca0` per the v1.4.27 §4 cross-reference) closes the only missing-key gap from v1.4.27. The custom blob scanner I ran on top reports 69 candidate "dead" keys, but cross-checking against the existing integrity test (which uses the template-prefix-aware logic) confirms each candidate has either a `t("ns.key")` consumer or a template prefix usage the coarse scan misses (e.g. `t(\`insights.recommendation.${key}\`)`). **No dead i18n keys at HEAD.**

### I3 — `@deprecated` markers still zero

`grep -rn "@deprecated" src` returns zero hits. No new deferred markers introduced in v1.4.28.

---

## Orphan-by-orphan table

| ID | Symbol / surface | File:line | Consumers | Severity | Decision |
|---|---|---|---|---|---|
| M1 | `DrugLevelChart.compact` + `windowHoursBefore` | `src/components/medications/DrugLevelChart.tsx:123,133` | 0 prod, 0 tests | Medium | DROP |
| M2 | `shotPhaseAt`, `ShotPhase` | `src/lib/medications/glp1-pk.ts:301,303` | 0 prod, 4 test assertions | Medium | DROP (with tests) |
| M3 | 5 admin/monitoring routes | per table above | README-only | Medium | Defer to v1.4.29 |
| L1 | `TimeoutEnvelope<T>` | `src/lib/insights/with-timeout.ts:21` | declaring-file only | Low | Drop `export` |
| L1 | `MetricEmptyStateProps` | `src/components/insights/metric-empty-state.tsx:36` | declaring-file only | Low | Drop `export` |
| L1 | `MobileRailTrayProps` | `src/components/insights/coach-panel/mobile-rail-tray.tsx:33` | declaring-file only | Low | Drop `export` |
| L1 | `AggregatedRow` | `src/lib/measurements/range-aggregation.ts:58` | declaring-file only | Low | Drop `export` |
| L1 | `UseInsightsAnalyticsResult` | `src/hooks/use-insights-analytics.ts:39` | declaring-file only | Low | Drop `export` |
| L1 | `MedicationCardHeaderProps` | `src/components/medications/MedicationCardHeader.tsx:29` | declaring-file only | Low | Drop `export` |
| L2 | local `ChartSkeleton` (trends-row) | `src/components/insights/trends-row.tsx:34` | same file | Low | Wire to shared |
| L2 | local `ChartSkeleton` (vo2-max-chart-row) | `src/components/insights/vo2-max-chart-row.tsx:29` | same file | Low | Wire to shared |

(L3–L9 are comment-level findings, listed in the next section.)

---

## Stale-comment list

| File:line | Comment excerpt | Recommendation |
|---|---|---|
| `src/lib/medications/glp1-pk.ts:292` | "Surfaces the 'shot phase' chip on the GLP-1 tile (research §2.4)" | Drop with M2, else trim "the GLP-1 tile" |
| `src/components/medications/DrugLevelChart.tsx:115` | "v1.4.27 B1 — compact rendering for tile-internal mounts (the GLP-1 dashboard tile…)" | Drop with M1, else trim |
| `src/components/medications/DrugLevelChart.tsx:228` | "Compact mode mounts the chart inside a host card (the GLP-1 tile)…" | Drop with M1, else trim |
| `src/components/medications/DrugLevelChart.tsx:234` | "made the GLP-1 tile feel oversized relative to the neighbouring trend cards" | Drop with M1, else trim |
| `src/components/medications/DrugLevelChart.tsx:461` | "Chart-area height in CSS pixels; compact mode passes 160." | Drop with M1 |
| `src/lib/openapi/routes.ts:757` | "Full Insights surface — daily briefing, recommendations with rationale, optional weekly report + storyboard annotations." | Drop "optional weekly report + " |
| `src/lib/api-handler.ts:323` | "`/api/dashboard/glp1`) 403'd every narrow-scope token even though those routes did not intend to restrict by scope" | Swap example or strike route name |
| `src/lib/__tests__/require-auth-bearer.test.ts:205` | "`/api/dashboard/glp1` — all four were called without a scope" | Swap example or strike route name |
| `src/components/insights/trends-row.tsx:32` | "cleared against `feedback_charts_visual_identity.md` — placeholder only, no chart visual change" | Rewrite when L2 lands |

Total stale comments: **9**.

---

## Summary

v1.4.28 cleaned up cleanly — the v1.4.27 R4 §2 sweep landed in full (14 orphan exports + the `__testables` block + the legacy `getInsightsSystemPrompt` helper + `InsightsOutput` are all gone) and the three retired surfaces (`Glp1Tile`, `InsightAdvisorCard`, `WeeklyReportView`) plus the two GLP-1 detail disclosures (`IntakeHistoryList`, `InventorySection`) took their direct supporting code with them. The i18n surface remains clean (`pnpm test … i18n-locale-integrity` 26/26) and no `@deprecated` markers slipped in.

What remains is residue. **M1 + M2** are the only real wins: `DrugLevelChart.compact` mode plus `shotPhaseAt` lost their only mount when the tile was retired, so each is a measurable LOC reduction. **M3** is unchanged from v1.4.27 — five admin/monitoring routes still need a per-endpoint maintainer call. **L1** is six new `export interface` declarations that could shed the `export` keyword (matching the v1.4.27 §8 hygiene pattern). **L2** is two duplicate local `ChartSkeleton` constants that could ride the shared primitive the v1.4.28 H4 fix introduced. **L3–L9** are nine stale comments — three of them disappear automatically if M1 + M2 land.

Recommended single commit if R4 is pulled into v1.4.28: M1 + M2 + L2 + the six L1 single-word edits + the L3/L4/L5 comment trims that survive after M1/M2 land. Estimated diff: roughly **-180 / +6** LOC. Risk: low — verified zero non-test consumers for every dropped symbol. M3 stays deferred; L6–L9 are optional polish.

Output:

- Orphan count (Medium + Low symbols/surfaces): **11** (3 Medium + 8 Low; L8 already resolved, L9 false positive)
- Top sweep candidate: **M1** (`DrugLevelChart.compact` mode + `windowHoursBefore` — biggest LOC reduction, removes the tightest coupling to the retired tile)
- Stale comments: **9**
