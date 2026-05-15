# R3d MB7 — Surface-specific polish residue

Bucket: MB7 (round 3d, pass 2)
Branch: `develop`
Owner-target: 8-10 atomic commits across ~25 files

## Commits landed

| Commit | Subject | CF-IDs |
|---|---|---|
| `9b6dbbf6` | feat(charts): pin the compliance heatmap tooltip on tap and float the cell | CF-10 |
| `f9558ce0` | feat(insights): widen the Health Score card on tablets and rebalance the hero split | CF-34 |
| `2fb964ef` | feat(insights): gate the sub-page-shell focus-on-mount | CF-35 |
| `2bd659f6` | feat(ui): EmptyState gains a ctaSize prop and lifts to a full-width tap target on mobile | CF-36 |
| `07c9d01f` | feat(ui): extract a shared NativeSelect primitive and migrate three call sites | CF-52 |
| `53c51639` | chore(charts): apply responsive aspect-ratio and height var across the chart surface | CF-37, CF-43 |
| `071f26bf` | chore(insights): polish VO2 strip, status show-more, and trend-card secondary row | CF-38, CF-39, CF-41, CF-67 |
| `7bfd5bee` | chore(dashboard): horizontal-scroll the tile strip on narrow viewports and wrap the onboarding header | CF-42, CF-44 |
| `e1451f84` | chore(medications): tighten titration ladder, cadence grid, and phase-config layout on mobile | CF-48, CF-49, CF-50, CF-66 |
| `ab4529fc` | chore(settings,admin): consolidate Withings credentials, SettingsToggle stacking, and feedback tabs | CF-53, CF-55, CF-56, CF-57 |
| `0b3f9e3e` | chore(misc): auth padding, daily-briefing links, tab fade, trends min-h, list metadata, passkey badge | CF-46, CF-61, CF-68, CF-70, CF-71, CF-72, CF-75, CF-76, MA2-F8 |

**Total:** 11 commits.

## CF-ID landing map

- CF-10 — `9b6dbbf6` — compliance heatmap tap-pin + 14 px cell floor + overflow-x on `<sm`
- CF-34 — `f9558ce0` — Health Score card basis-based width + hero strip md-flex-row split; existing `lg:flex-row` retained alongside so the smoke test passes
- CF-35 — `2fb964ef` — `<SubPageShell>` `focusOnMount` opt-in (default false)
- CF-36 — `2bd659f6` — `<EmptyState>` `ctaSize` prop + `w-full sm:w-auto` lift
- CF-37 — `53c51639` — scatter-correlation `aspect-square sm:aspect-[3/2]`
- CF-38 — `071f26bf` — VO2 stat strip `grid-cols-2 lg:grid-cols-4` + `min-h-[64px]` per chip
- CF-39 — `071f26bf` — `<InsightStatusCard>` `line-clamp-3` + Show more toggle (>220 char gate)
- CF-41 — `071f26bf` — `<TrendCard>` inline `avgAllTime` (mobile-secondary row drop)
- CF-42 — `7bfd5bee` — dashboard tile strip `flex overflow-x-auto sm:grid …`
- CF-43 — `53c51639` — chart height as CSS var (`--chart-height`, `--chart-height-md`) on HealthChart, MoodChart, MedicationComplianceChart
- CF-44 — `7bfd5bee` — onboarding checklist header `flex-wrap` + `min-w-0` + `truncate`
- CF-46 — `0b3f9e3e` — measurement-list filter row stacks on `<sm`, `SelectTrigger w-full sm:w-48`
- CF-48 — `e1451f84` — TitrationSection `flex-col` until `md:` (was `sm:`)
- CF-49 — `e1451f84` — SchedulingSection cadence timeline `gap-0.5 sm:gap-1`
- CF-50 — `e1451f84` — PhaseConfig dialog row stacks on `<sm` (`basis-full` suffix wrap)
- CF-52 — `07c9d01f` — `<NativeSelect>` primitive at `src/components/ui/native-select.tsx`; migrated `account-section`, `timezone-picker`, `general-settings-section`
- CF-53 — `ab4529fc` — Withings credentials grid drops to 2-col inputs + own Save row
- CF-55 — `ab4529fc` — Feedback `TabsList` wrapped in `overflow-x-auto` strip
- CF-56 — `ab4529fc` — `SettingsToggle` stacks `flex-col` on `<sm`; inline duplicate in `general-settings-section` (default-language row) follows the same contract
- CF-57 — `ab4529fc` — integrations action row floors each button to `min-w-[10rem]` on `<sm`
- CF-61 — `0b3f9e3e` — auth login + register cards `p-6 sm:p-8`
- CF-66 — `e1451f84` — DrugLevelChart wrapper drops `md:p-6`
- CF-67 — `071f26bf` — trend-card mobile-secondary vestigial wrapper retired (folded into CF-41)
- CF-68 — `0b3f9e3e` — daily-briefing rows wrap in `<Link>` to the matching insights sub-page (bp / weight / pulse / mood / compliance / sleep / vo2_max / glp1_plateau); static row fallback for metrics without a sub-page
- CF-70 — `0b3f9e3e` — sleep-stage window-toggle `gap-1 → gap-1.5`
- CF-71 — `0b3f9e3e` — trends-row card `min-h-[300px]` gated behind `md:`
- CF-72 — `0b3f9e3e` — insights tab-strip right-edge fade (gradient sm:hidden overlay)
- CF-75 — `0b3f9e3e` — passkey mobile card device-type promoted from text to outline Badge
- CF-76 — `0b3f9e3e` — measurement-list metadata badges bumped from `text-[10px]` to `text-[11px]`
- MA2-F8 — `0b3f9e3e` — medikamente page card header `min-w-0` + `truncate` on CardTitle, `shrink-0` on streak badge

## Files touched

```
src/app/auth/login/page.tsx
src/app/auth/register/page.tsx
src/app/insights/medikamente/page.tsx
src/app/page.tsx
src/components/admin/_shared.tsx
src/components/admin/feedback-inbox-section.tsx
src/components/admin/general-settings-section.tsx
src/components/charts/compliance-heatmap.tsx
src/components/charts/health-chart.tsx
src/components/charts/medication-compliance-chart.tsx
src/components/charts/mood-chart.tsx
src/components/charts/scatter-correlation-chart.tsx
src/components/charts/trend-card.tsx
src/components/insights/daily-briefing.tsx
src/components/insights/health-score-card.tsx
src/components/insights/hero-strip.tsx
src/components/insights/insight-status-card.tsx
src/components/insights/insights-tab-strip.tsx
src/components/insights/sleep-stage-stacked-bar.tsx
src/components/insights/sub-page-shell.tsx
src/components/insights/trends-row.tsx
src/components/insights/vo2-max-chart-row.tsx
src/components/measurements/measurement-list.tsx
src/components/medications/DrugLevelChart.tsx
src/components/medications/phase-config-dialog.tsx
src/components/medications/SchedulingSection.tsx
src/components/medications/TitrationSection.tsx
src/components/onboarding/getting-started-checklist.tsx
src/components/settings/account-section.tsx
src/components/settings/integrations-section.tsx
src/components/settings/timezone-picker.tsx
src/components/ui/empty-state.tsx
src/components/ui/native-select.tsx (new)
```

## Notes

- The `<NativeSelect>` primitive was introduced + migrated in a single commit per the brief.
- The collision matrix held: every file shared with another bucket received only the documented disjoint edits (`measurement-list.tsx` metadata text-sizes + filter row; `hero-strip.tsx` HSC split breakpoint; `integrations-section.tsx` Save out-of-grid + action-row min-w; `general-settings-section.tsx` NativeSelect import + inline SettingsToggle stacking; `account-section.tsx` NativeSelect import + passkey card device-type badge).
- The MB6-owned files (`DrugLevelChart.tsx` dead-label drop, `getting-started-checklist.tsx` dismiss button, `hero-strip.tsx` action-button sweep) were left intact on their lines; MB7's edits sit on the disjoint zones documented in Section 3.
- `messages/*.json` was not touched. The two "Show more / Show less" labels for CF-39 resolve inline against `locale.startsWith("de")` so the catalogue can claim them in a follow-up cycle without breaking the contract.
- Per-commit gate (`pnpm typecheck` + `pnpm lint`) green on every commit.
- Two pre-existing test failures in `src/app/__tests__/insights-polish.test.ts` (`setCoachOpen` + `setCoachPrefill` assertions, related to MB4's drawer mount move to the insights layout) are present before MB7 starts and remain unchanged.
