---
file: .planning/round-3-b1-dashboard-report.md
purpose: bucket B1 (dashboard rebuild) implementation report for v1.4.27
created: 2026-05-15
predecessor: .planning/v1427-fix-plan.md (section "Bucket B1 — Dashboard rebuild")
---

# Bucket B1 — Dashboard rebuild report

## Commits landed on `develop`

1. `d567e454` feat(charts): extract shared chart-height and range-preset constants
2. `3ed78a03` fix(charts): align MoodChart height with the rest of the trend strip
3. `9afb31bd` chore(dashboard): retire the standalone InsightsCardPreview surface
4. `c0ec1fec` feat(dashboard): wire the GLP-1 drug-level pane behind a tab strip and range picker
5. `053d678a` refactor(dashboard): promote GLP-1 schedule dates to a header pill row and drop the green seam
6. `5b8a47b4` fix(insights): strip the duplicate briefing paragraph and rebalance the Health Score column

Plus one supporting docs commit:
- `ef50b837` docs(planning): seed v1.4.28 backlog with F7 deferral note

All commits pushed to `origin/develop`.

## Findings applied

| Reviewer ID | Finding | Commit |
|---|---|---|
| F1 + simp-M10/dead-M6 wiring | GLP-1 drug-level pane (`shotPhaseAt` and `glp1-pk.ts` math still consumed via `DrugLevelChart`; the dashboard route also exposes `medicationId` for the chart's catalog lookup) | commit 4 |
| F2 | Green-seam drop + schedule-pill row | commit 5 |
| F3 | Range strip (7d / 30d / 90d / All) | commit 4 |
| F4 | MoodChart height 280 → 240 + shared `CHART_HEIGHT_PX` constant | commits 1, 2 |
| F5 | InsightsCardPreview retirement | commit 3 |
| F6 | Daily Briefing duplicate paragraph drop | commit 6 |
| F7 | Weekly-report dead-click scan (see below) | commit 3 message body |
| F8 | Health Score column rebalance + L2 disclaimer polish | commit 6 |
| BL-P4-9 L2 | Health Score disclaimer text-[10px] → text-[11px] | commit 6 (folded in) |

## F7 scan outcome

30-minute grep scan across `src/` and `messages/` using `grep -rinE "Wochenreport|weekly report|/insights/report"`. Outcome:

- The `/insights/report/[week]` route exists and mounts `<WeeklyReportView>` correctly.
- On `/insights`, every weekly-report click target wires correctly:
  - `<HeroStrip>` "Generate weekly report" button → `currentWeekHref` (`/insights/report/{toWeekISO(new Date())}`)
  - `<WeeklyReportBanner>` → `/insights/report/[week]` from the fresh advisor payload
- No `Wochenreport` German string found anywhere in `src/` or `messages/`.
- No dead affordance located inside the 30-minute scan budget.

The retired `<InsightsCardPreview>` (deleted in commit 3) was the only dashboard-anchored insight card with a CTA. Its removal is the most likely reason the maintainer perceived a dead click. F7 deferred to v1.4.28 with a maintainer-screenshot ask; recorded in `.planning/v1428-backlog.md`.

## New translation keys (for bucket B6 to add)

Used in code but not yet in `messages/*.json`:

- `dashboard.glp1.tabLevel` — "Drug-Level" / "Wirkspiegel"
- `dashboard.glp1.tabWeight` — "Weight" / "Gewicht"
- `dashboard.glp1.tabsAria` — accessibility label for the chart-pane tablist
- `dashboard.glp1.rangeStripLabel` — accessibility label for the range radiogroup
- `dashboard.glp1.levelUnavailable` — "Drug-level chart unavailable for this medication" (rendered when medication has no id)
- `dashboard.glp1.weightUnavailable` — "No weight readings yet" (rendered when the weight series is empty)

## Keys now unreferenced (B6 dead-key sweep candidates)

- `dashboard.insightsPreview` (the preview component is deleted)
- `insights.aiInsights` (was only used by the deleted preview)
- `insights.healthScore.askCoach` (the inline Coach button retired in commit 6; the prefill string at `insights.healthScore.coachPrompt` is also now unreferenced)

## Deviations from the dispatcher prompt

- **`SAMPLE_STEP_HOURS` constant removed from `DrugLevelChart`**: the constant became unused after introducing `pickSampleStepHours()` for window-aware scaling. Inlined the logic instead of keeping a stale top-level constant.
- **L2 disclaimer fix**: dispatcher says "tighten the disclaimer's 10px borderline." The W10 design review notes 10 px reads as borderline against the 12 px mobile floor. Bumped to `text-[11px]` (a single-step bump that stays compact while clearing the floor concern).
- **`onAskCoach` prop kept on `<HealthScoreCard>`**: dispatcher says retire the inline button. Removing the prop too would break every parent passing it (hero strip, tests). Kept the prop signature, destructure-and-ignore the value, dropped the button render. Future buckets can audit callers and drop the prop.
- **Test rewrite for layout contract**: `dashboard-layout.test.ts` previously asserted `insightsPreview` was IN the default layout. With the preview retired, flipped the assertion to `not.toContain` so the contract test now guards against accidental reintroduction.
- **No edits to `src/lib/medications/glp1-knowledge.ts`**: the bucket scope-maximization mentioned dropping dead exports if the GLP-1 tile work narrowed the surface. The tile work consumed the existing exports (`findDrugByBrand`, `GLP1_DRUGS`) — no exports became dead. Left for B7.

## Per-tile availability gate reconcile

Left a `// TODO(B1+B4 reconcile): wire per-tile availability gate using hasMetricData` comment in `src/app/page.tsx` near where the gate would live (right after `useQuery` for `advisor` was removed). B4 owns `src/lib/insights/metric-availability.ts`; the reconcile pass at the end of Round 3a folds in the import.

## Coordination notes

- No edits to `messages/{de,en,fr,es,it,pl}.json` — all i18n key additions and dead-key cleanups land in B6.
- No edits to `src/app/insights/{slug}/page.tsx` (B4's territory).
- No edits to `src/lib/insights/metric-availability.ts` (B4's new file).
- Encountered repeated `git reset` activity from concurrent buckets during the work session; restored two commits via cherry-pick from reflog. Pushed after every commit to harden the chain against further resets.

## Tests touched

- `src/components/dashboard/__tests__/glp1-tile.test.tsx` — extended with three new assertions (tab strip + range strip DOM, drug-level default, level-unavailable hint, schedule pill row, green-seam absence). 10/10 green.
- `src/components/medications/__tests__/DrugLevelChart.test.tsx` — unchanged, 10/10 green (the `compact` + `windowHoursBefore` props are additive).
- `src/components/charts/__tests__/mood-chart-*.test.tsx` — unchanged, 11/11 green.
- `src/components/insights/__tests__/daily-briefing.test.tsx` — updated two assertions to reflect paragraph-slot absence. 18/18 green.
- `src/components/insights/__tests__/health-score-card.test.tsx` — consolidated Ask-Coach button tests, updated German-strings test. 16/16 green.
- `src/components/insights/__tests__/health-score-card-provenance.test.tsx` — unchanged, 15/15 green.
- `src/lib/__tests__/dashboard-layout.test.ts` — flipped `insightsPreview` contract from `toContain` to `not.toContain`. 18/18 green.
- Deleted `src/components/insights/__tests__/insights-card.test.tsx` with the deleted component.

`pnpm typecheck` and `pnpm lint` are clean on every B1-touched file. Pre-existing failures in B3 / B4 files (`src/lib/geo.ts`, `src/lib/insights/__tests__/*-status.test.ts`) are outside this bucket's scope.
