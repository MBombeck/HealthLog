---
file: .planning/research/v1428-r4-simplifier.md
purpose: R4 simplifier review — dead code, duplications, missed consolidations across the v1.4.28 diff
created: 2026-05-16
contributor: R4 simplifier
---

# R4 simplifier review — v1.4.28

Read-only review of the 50-commit diff since `v1.4.27`. Focus: the six new primitives introduced by the round (`<MetricEmptyState>`, `<HealthChartDynamic>`, `<MobileRailTray>`, `useInsightsAnalytics`, `<ChartSkeleton>`, `<HealthScoreDeltaExplainer>`), the seven Insights sub-pages, the Coach-launch consolidation (target: 3 shapes), the retire-from-code directives (FB-A1, FB-A2, FB-E1, FB-E2, FB-J1, FB-J2), and locale-bundle hygiene.

Tally:

| Tier | Count |
|---|---|
| High | 2 |
| Medium | 5 |
| Low | 3 |
| Dead-code candidates (i18n orphans) | ~49 keys × 6 locales |

No Critical findings. The new primitives landed in the right places; the surviving pattern duplications all sit one tier below the maintainer's Critical / High floor.

---

## High

### S-H1 — `<HealthChartDynamic>` re-export not consumed by two surviving call sites

- **file:line** — `src/components/insights/trends-row.tsx:33-44`, `src/components/insights/vo2-max-chart-row.tsx:29-39`
- **What's redundant** — `8f3bfc37` migrated five `dynamic(() => import("@/components/charts/health-chart"))` call sites (`src/app/page.tsx` + the four sub-pages) onto the shared `<HealthChartDynamic>` re-export, and the docstring on `src/components/charts/health-chart-dynamic.tsx:8-22` claims "six call sites". Two consumers were missed: `trends-row.tsx` and `vo2-max-chart-row.tsx`. Both still hand-roll the same `dynamic(...)` block plus a local degenerate `ChartSkeleton` (`<div className="bg-muted/40 h-[220px] w-full animate-pulse rounded-md motion-reduce:animate-none" />`) that bypasses the canonical `<ChartSkeleton>` primitive landed in `d286220b` (proper border, aria-busy, sr-only label, header-row mirror, chart-height CSS variable contract).
- **How to simplify** — Replace each `const HealthChart = dynamic(...)` with `import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic"` and rename the JSX consumer. The prop shapes already match — `vo2-max-chart-row.tsx:208-216` forwards `chartKey | types | title | colors | unit | compareBaseline | userTimezone`, all of which pass straight through `dynamic()`'s inferred type. Delete the local `ChartSkeleton` constants. Net: ~25 LOC removed across the two files; both surfaces inherit the better loading shell automatically.
- **Effort** — S (≤30 min, mechanical).
- **In-scope-for-v1.4.28** — yes. Same primitive, same primary intent the round's R3d already executed; finishing the migration prevents the docstring from becoming a lie before the round closes.

### S-H2 — Insights mother page still hand-rolls the analytics query the new hook replaced

- **file:line** — `src/app/insights/page.tsx:135-144`
- **What's redundant** — `useInsightsAnalytics()` (`src/hooks/use-insights-analytics.ts`) consolidated the React-Query block five sub-pages duplicated. The mother page (`/insights`) still inlines its own `useQuery({ queryKey: ["analytics"], queryFn: ... })` block with a private `AnalyticsData` interface, even though the hook reads the exact same endpoint into the exact same cache slot. The hook uses `queryKeys.analytics()`; the mother page hard-codes `["analytics"]` — minor consistency drift and a future query-key-collision exposure of the type `feedback_react_query_key_collision.md` warns against.
- **How to simplify** — Either (a) consume `useInsightsAnalytics()` directly and pick the metric the page is actually gating on, or (b) add a typed mother-page variant that returns the full `AnalyticsData` payload (the hook returns `SubPageAnalyticsData` — the mother page reads more fields). Option (b) is the safer call because the mother page's gate is "any data at all" not a per-metric gate.
- **Effort** — S.
- **In-scope-for-v1.4.28** — yes; one file, no contract change.

---

## Medium

### S-M1 — `MoodChart` dynamic-import duplicated three times

- **file:line** — `src/components/insights/trends-row.tsx:46-52`, `src/app/page.tsx:48-54`, `src/app/insights/stimmung/page.tsx:29-35`
- **What's redundant** — Three callers each declare `dynamic(() => import("@/components/charts/mood-chart").then(...))` with `{ ssr: false, loading: () => <ChartSkeleton /> }`. Same primitive opportunity that `<HealthChartDynamic>` already addresses for `<HealthChart>`.
- **How to simplify** — Add a sibling `<MoodChartDynamic>` re-export next to `health-chart-dynamic.tsx`. Three call sites collapse to a one-line import.
- **Effort** — S.
- **In-scope-for-v1.4.28** — defer-to-v1.4.29 unless the round is already touching `MoodChart` for FB-K. The `<HealthChartDynamic>` precedent makes this a four-line file and a three-line per-caller change, so opportunistic if R3d revisits.

### S-M2 — Inline `["analytics"]` literal cache key vs `queryKeys.analytics()`

- **file:line** — `src/app/insights/page.tsx:136`, plus the hook at `src/hooks/use-insights-analytics.ts:58`
- **What's redundant** — Two writers of the same cache slot; one uses the helper, one hard-codes the array. The `queryKeys` registry exists precisely to prevent this. Folded into S-H2; pulling out for severity granularity because the literal also exists independent of the hook migration.
- **How to simplify** — Replace `queryKey: ["analytics"]` with `queryKey: queryKeys.analytics()`.
- **Effort** — S (one line).
- **In-scope-for-v1.4.28** — yes.

### S-M3 — Local `ChartSkeleton` constants shadow the canonical primitive

- **file:line** — `src/components/insights/trends-row.tsx:34-36`, `src/components/insights/vo2-max-chart-row.tsx:29-31`
- **What's redundant** — Both files define `const ChartSkeleton = () => <div className="..." />` with a 220 px fixed height + a single `bg-muted/40` div. The shared `<ChartSkeleton>` (`src/components/charts/chart-skeleton.tsx`) honours the chart-height CSS variable, paints a layout-stable card chrome, exposes `aria-busy + role="status"`, and includes the sr-only "Loading chart…" label. The local versions are strictly worse on a11y, layout-stability, and motion-reduce conformance.
- **How to simplify** — Delete both local constants and pass `() => <ChartSkeleton />` from the shared module (the same shape the dashboard adopts at `src/app/page.tsx:53`). Falls out of S-H1 once the call sites migrate to `<HealthChartDynamic>`.
- **Effort** — S (paired with S-H1).
- **In-scope-for-v1.4.28** — yes.

### S-M4 — ~49 confirmed orphan i18n keys across six locales

- **file:line** — `messages/{de,en,es,fr,it,pl}.json` — see appendix at bottom.
- **What's redundant** — A 78-key orphan scan against the live source produces 29 false positives (dynamic key lookups like `medications.site${suffix}` or `medications.sideEffects.entries.${entryI18nKey(row.entry)}` or `onboarding.shell.step${n}of4`) and ~49 confirmed orphans with zero runtime consumer. The biggest cluster (18 keys) sits in the `insights.*` namespace and traces back to the J1/J2 InsightAdvisorCard retire (`startAnalysis`, `refreshAnalysis`, `heroFinding{Positive,Neutral,Attention,Warning}`, `keyTakeaway`, `findingsTitle`, `recommendationsTitle`, `correlationsTitle`, `dataFoundation`, `dataGaps`, `heroRegenerate`, `recommendation.*`, `generalStatusBadge.critical`). Smaller clusters in `insights.coach.*` (11 keys — settings-evidence + rate-limit + sources-rail copy with no current consumer), sub-page empty-state drafts (7 keys), `medications.*` intake-history copy (6 keys orphaned by the FB-E1/E2 retire — `invalidTimestamp`, `loginRequiredIntakes`, `noIntakesYet`, `pageInfo`, `previousPage`, `nextPage`), `medications.source{Web,Api,Reminder,Import}` (4 keys; `measurements.source*` is the real consumer), `admin.feedback.tab*` (4 keys), confidence-band placeholders (3 keys), and `format.timeShort` + `format.dateTime` (2 keys).
- **How to simplify** — Sweep ~49 keys × 6 locales in one mechanical commit. Pairs with the FB-J1/J2 + FB-E1/E2 retire buckets the round already executed — the test guard at `src/app/__tests__/insights-polish.test.ts` confirms no source consumer remains.
- **Effort** — S (one batch edit, contained to `messages/*.json`).
- **In-scope-for-v1.4.28** — yes. The R4 i18n reviewer will likely flag the same orphans; closing them now keeps the i18n / dead-code reviewer reports clean.

### S-M5 — Commit-subject vs commit-content mislabel for `235e52cb` (post-hoc only)

- **file:line** — git history `235e52cb` (subject: "refactor(charts): single HealthChartDynamic re-export"; actual content: MobileRailTray carve-out + tests).
- **What's redundant** — The mislabel is metadata-only; no source duplication landed. `8f3bfc37` ("refactor(charts): collapse health-chart dynamic imports onto re-export") shipped the actual `HealthChartDynamic` migration. The audit confirms `235e52cb` did NOT duplicate the MobileRailTray work — the file `src/components/insights/coach-panel/mobile-rail-tray.tsx` exists once, with one consumer (`coach-drawer.tsx:33`). Same for `8f3bfc37` — no shadow copy of the migration in the diff.
- **How to simplify** — No code change. Flag the mislabel in the release closure report so future bisects against `235e52cb` searching the diff for "HealthChartDynamic" don't waste cycles.
- **Effort** — S (documentation, not code).
- **In-scope-for-v1.4.28** — yes (closure report note).

---

## Low

### S-L1 — `schlaf` page documents the missing `<InsightStatusCard>` slot but the test doesn't pin the deferral

- **file:line** — `src/app/insights/schlaf/page.tsx:64-75`
- **What's redundant** — A 12-line comment block explains that sleep has no `/api/insights/sleep-status` route yet and the section is intentionally absent for parity-with-deferred-pending-v1.5. Useful as a marker, but neither `src/app/__tests__/insights-polish.test.ts` nor the sub-page test pins "no `<InsightStatusCard>` is mounted on schlaf yet" with a comment or `it.skip("...")` slot. Future contributors may delete the comment as stale.
- **How to simplify** — Either (a) collapse the comment to a one-line marker referencing the v1.5 ticket, or (b) add a pinned test assertion that schlaf does not mount `<InsightStatusCard>` yet, with the `// remove this assertion in v1.5` marker. Choice (b) earns its keep — it converts the comment into a guard.
- **Effort** — S.
- **In-scope-for-v1.4.28** — defer-to-v1.4.29.

### S-L2 — `<HealthChartDynamic>` docstring says "six call sites" — drift after migration

- **file:line** — `src/components/charts/health-chart-dynamic.tsx:11-17`
- **What's redundant** — The docstring lists the six pre-migration call sites by name. Once S-H1 consumes the primitive from `trends-row.tsx` + `vo2-max-chart-row.tsx`, the count is eight, not six. Future contributors reading this for context will be slightly off-by-two.
- **How to simplify** — Update the docstring count when S-H1 lands. One-line edit.
- **Effort** — S (paired with S-H1).
- **In-scope-for-v1.4.28** — yes (only if S-H1 is in-scope).

### S-L3 — `daily-briefing.tsx:337-342` carries a multi-line BK-M2 commentary that would read cleaner as a one-liner

- **file:line** — `src/components/insights/daily-briefing.tsx:336-342`
- **What's redundant** — A six-line comment block explains the variant flip from outline to default. The maintainer's "feedback_marc_voice_english.md" prefers terse code comments. The change itself is one line of code (`variant="outline"` → no prop); the commentary outweighs the change.
- **How to simplify** — Collapse to "BK-M2 — empty-state CTAs render as the primary affordance." or remove entirely once the test pinning the data-slot lands (it already does at `daily-briefing-empty-cta`).
- **Effort** — S.
- **In-scope-for-v1.4.28** — defer-to-v1.4.29 (cosmetic).

---

## Pattern-by-pattern table

| Pattern | Expected consumers | Actual consumers | Survivors |
|---|---|---|---|
| `<HealthChartDynamic>` re-export | every site that dyn-imports `health-chart` | 6 (dashboard + 4 sub-pages + sleep-duration-chart) | 2 survivors: `trends-row.tsx`, `vo2-max-chart-row.tsx` |
| Local `ChartSkeleton` shadow | 0 (use canonical primitive) | 2 (trends-row, vo2-max-chart-row) | 2 — same files as above |
| `<MoodChart>` `dynamic()` | 1 (shared `<MoodChartDynamic>` re-export, future) | 3 (dashboard, trends-row, stimmung) | 3 — no consolidation yet |
| `<MedicationComplianceChart>` `dynamic()` | 1 | 1 (dashboard only) | 0 — not worth consolidating |
| `useInsightsAnalytics()` hook | 5 hard-data sub-pages | 5 (puls, blutdruck, gewicht, bmi, schlaf) | 0 (mother page S-H2 is one tier up) |
| `<MetricEmptyState>` primitive | every empty-state on insights sub-pages | 6 (5 hard-data + stimmung) | 1 survivor: `medikamente/page.tsx:126` uses `<EmptyState>` directly — appropriate (event-driven gate, different prop shape including `ctaSize="lg"`) |
| `<HealthScoreDeltaExplainer>` | 1 (HealthScoreCard) | 1 | 0 — clean |
| `<MobileRailTray>` | 1 (CoachDrawer) | 1 | 0 — clean |
| `<ChartSkeleton>` canonical | every chart loading slot | 5 explicit + transitively via `<HealthChartDynamic>` | 2 local shadows (S-M3) |
| Coach-launch shapes | 3 target (FAB / inline / per-card icon) | 3 (`coach-launch-fab`, `coach-launch-inline`, `target-coach-cta`) | 0 — lands at 3 as planned |
| Inline `dynamic(@/components/charts/health-chart)` calls | 0 (all behind `<HealthChartDynamic>`) | 2 | 2 — same S-H1 callers |
| Inline `useQuery({ queryKey: ["analytics"] })` blocks | 0 (all behind hook) | 1 (mother page) | 1 — S-H2 |
| `messages/*.json` duplicate top-level keys | 0 | 0 | clean — all 6 locales pass `json.object_pairs_hook` duplicate check |
| `messages/*.json` cross-locale key parity | 2278 keys × 6 locales matching | 2278 × 6 (perfect parity) | 0 — full parity |
| Orphan i18n keys (no runtime consumer) | 0 | ~49 confirmed | ~49 — S-M4 |
| FB-A1 GLP-1 tile retire | 0 references | 0 references | clean |
| FB-A2 DrugLevelChart dashboard mount retire | 0 dashboard references | 0 dashboard mounts (component still consumed by `/medications/[id]/history`) | clean |
| FB-E1 IntakeHistoryList retire | 0 mount-references | 0 mounts (one stale comment at `medications/[id]/history/page.tsx:125` is descriptive, not load-bearing) | clean |
| FB-E2 InventorySection retire | 0 mount-references | 0 mounts (backend `inventory` lib + API kept for iOS contract) | clean |
| FB-J1 InsightAdvisorCard retire | 0 references | 0 (test guard at `insights-polish.test.ts:96-102`) | clean |
| FB-J2 "Insights aktualisieren" retire | 0 references | 0 (no `heroRegenerate` / `refreshAnalysis` consumer; orphan keys captured in S-M4) | clean — but orphan i18n |
| FB-H3 "Wochenbericht erstellen" hero retire | 0 references | 0 source consumers | clean |

---

## Summary

The v1.4.28 simplification work is in good shape. The six new primitives landed in the right places; the Coach-launch surface narrowed to the target three shapes (`coach-launch-fab` mobile, `coach-launch-inline` desktop pill, `target-coach-cta` per-card icon); the six scope-reduction directives (FB-A1, FB-A2, FB-E1, FB-E2, FB-J1, FB-J2) all cleared the source tree; cross-locale key parity is perfect across all six locales; no duplicate JSON keys.

Two High findings: `<HealthChartDynamic>` missed two consumers (`trends-row.tsx`, `vo2-max-chart-row.tsx`) that still hand-roll the same dynamic-import + a degenerate `ChartSkeleton` shadow, and the Insights mother page still inlines the same React-Query analytics block the new hook consolidated for its five sub-pages. Both High items are ~30 minutes of mechanical work each and fit the round's "less scope, more depth" framing.

The ~49 confirmed orphan i18n keys × 6 locales (~294 entries) are mostly fallout from the J1/J2 InsightAdvisorCard retire, the FB-E1/E2 intake-history retire, the heroRegenerate retirement, plus four `medications.source*` duplicates of `measurements.source*` that were never consumed. Sweep in one batch commit.

The two mislabelled commits (`235e52cb` carrying MobileRailTray under a HealthChartDynamic subject; `0e7c97c5` carrying briefing-variant + trends-row equal-height in one commit) introduced no source-level duplication — `8f3bfc37` was the actual HealthChartDynamic migration, not a re-do. Document the metadata drift in the release closure report and move on.

Defer to v1.4.29: the `<MoodChartDynamic>` re-export carve-out (S-M1), the `schlaf` test-pinning of the deferred status slot (S-L1), and the daily-briefing comment trim (S-L4). All cosmetic.

---

## Appendix — confirmed orphan i18n keys (~49)

Grouped by retire-source:

**FB-J1 / J2 InsightAdvisorCard + regenerate retirement (18 keys)**
- `insights.startAnalysis`
- `insights.refreshAnalysis`
- `insights.heroRegenerate`
- `insights.heroFindingPositive`
- `insights.heroFindingNeutral`
- `insights.heroFindingAttention`
- `insights.heroFindingWarning`
- `insights.keyTakeaway`
- `insights.findingsTitle`
- `insights.recommendationsTitle`
- `insights.correlationsTitle`
- `insights.dataFoundation`
- `insights.dataGaps`
- `insights.generalStatusBadge.critical`
- `insights.recommendation.confidenceHigh`
- `insights.recommendation.confidenceMedium`
- `insights.recommendation.feedbackConfirmed`
- `insights.recommendation.legacyPayloadCta`

**`insights.coach.*` orphans (11 keys)** — settings-evidence copy, rate-limit titles, sources-rail strings left behind after the MobileRailTray carve-out:
`dailyLimitTitle`, `errorBudget`, `providerRateLimitTitle`, `refusalInjection`, `refusalOutOfScope`, `settingsEvidenceHint`, `settingsEvidenceLabel`, `sourcesFooter`, `sourcesFresh`, `sourcesStale`, `voiceComingSoon`.

**Confidence-band placeholders (3 keys)** — German-suffixed key names with no English consumer: `insights.confidenceGering`, `insights.confidenceHoch`, `insights.confidenceMittel`.

**Admin feedback inbox tabs (4 keys)** — defined but the inbox uses `admin.feedback.tabs.*` instead: `admin.feedback.tabOpen`, `tabAcknowledged`, `tabResolved`, `tabArchived`.

**Sub-page empty-state duplicates (7 keys)** — earlier draft of `<MetricEmptyState>` keys the consumer migrated off: `insights.subPage.medikamenteEmpty{Action,Description,Title}`, `insights.subPage.stimmungEmpty{Action,Description,Title}`, `insights.subPage.therapyTimelineDescription`.

**Intake-history page copy orphaned by FB-E1 retire (6 keys)** — `medications.invalidTimestamp`, `loginRequiredIntakes`, `noIntakesYet`, `pageInfo`, `previousPage`, `nextPage`. The IntakeHistoryList block retired; this copy went with it.

**`medications.source*` duplicates of `measurements.source*` (4 keys)** — `medications.sourceWeb`, `sourceApi`, `sourceReminder`, `sourceImport`. The measurement-list renderer reads `measurements.*`; the `medications.*` set is unused.

**Format helpers with no consumer (2 keys)** — `format.timeShort`, `format.dateTime`. Every formatter call site uses `useFormatters()` instead.

Mechanical sweep: ~50 keys × 6 locales. One commit.
