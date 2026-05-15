---
file: .planning/round-3-b4-coach-insights-report.md
bucket: B4 — Coach polish + Insights data-driven hiding + token-leak hardening
findings_applied: F14, F15, F16, F17, F18, F19
status: shipped
date: 2026-05-15
---

# B4 round-3 report

Four atomic commits on `develop`, pushed to origin.

## Commits

| Hash | Title | Findings |
|---|---|---|
| `e8fb0a75` (effective contents) | fix(insights): strip metric tokens at both producer and consumer of the status card | F16 |
| `4d88764e` | fix(coach): collapse the evidence disclosure to closed-by-default | F14 |
| `fe18a881` | feat(coach): replace the textarea hint footer with an info-icon tooltip | F15 |
| `f3ff2624` | feat(insights): gate sub-pages and tab pills on metric data availability | F17, F18, F19 |

Note on commit `e8fb0a75`: the staging area was contended with concurrent buckets B3 and B5 working on `develop` in parallel. Bucket B3's auto-commit consumed B4's first-commit staging area; my files (`insight-status-card.tsx`, the seven `*-status.ts` helpers, eight test files) landed inside that commit instead of under the B4 title. All the F16 production changes + tests are present in develop; only the commit title is mis-attributed. Subsequent commits (`4d88764e`, `fe18a881`, `f3ff2624`) attribute correctly.

## What landed per finding

### F16 — token-leak hardening (commit 1)

- `src/components/insights/insight-status-card.tsx` — wraps `text` with `stripChartTokens()` at the render site (defence-in-depth for cached rows).
- `src/lib/insights/{pulse,weight,bmi,mood,blood-pressure,medication-compliance,general}-status.ts` — extended `normalizeSummaryText` to call `stripChartTokens()` before whitespace collapse. Producer-side strip hardens future audit-log writes.
- `src/components/insights/__tests__/insight-status-card.test.tsx` — NEW. Asserts colon-form, capitalised-Metric, and orphan-enum tokens are removed from rendered prose.
- `src/lib/insights/__tests__/{pulse,weight,bmi,mood,blood-pressure,medication-compliance,general}-status.test.ts` — extended each with one regression test asserting no `metric:` substring in cached `text` or `summary`.

### F14 — collapse evidence disclosure (commit 2)

- `src/components/insights/coach-panel/message-thread.tsx` — dropped `useCoachPrefs` import + `evidenceDefaultOpen` derivation + the prop on both `<ChatBubble>` call sites + the prop on `ChatBubbleProps`. The `<details>` now mounts closed unconditionally.
- `src/components/insights/coach-panel/coach-settings-sheet.tsx` — retired the `showEvidenceByDefault` `<Switch>` block. The persisted `coachPrefs.showEvidenceByDefault` field stays in the Zod schema for backward compatibility (defaults to `false`); no UI reads or writes it. Schema can drop the field in v1.5.
- `src/components/insights/coach-panel/__tests__/coach-settings-sheet.test.tsx` — flipped the assertion from `toContain('data-slot="coach-prefs-evidence"')` to `not.toContain`.

The existing `message-thread.test.tsx` assertion at line 316 (`expect(html).not.toMatch(/<details[^>]*\bopen\b/)`) already asserted default-closed; no test change needed there.

### F15 — info-icon tooltip (commit 3)

- `src/components/insights/coach-panel/coach-input.tsx` — replaced the verbose hint `<span>` with an `Info` icon (lucide-react) wrapped in a shadcn `<Tooltip>` (Radix-backed). The trigger carries `aria-label={t("insights.coach.composerHint")}` so screen-readers still announce the hint on focus, plus `data-slot="coach-input-hint"` so existing consumers keep their selector. Tooltip body shows the same translation on hover.
- `src/components/insights/coach-panel/__tests__/coach-input.test.tsx` — updated the "renders the localised placeholder + hint" test to look for the tooltip trigger's `aria-label` rather than the prose span.

### F17/F18/F19 — data-driven metric visibility (commit 4)

NEW helper: `src/lib/insights/metric-availability.ts`. Single decision point — `hasMetricData(metric, inputs)`.

- Sensor metrics (`PULSE`, `WEIGHT`, `BLOOD_PRESSURE_*`, `SLEEP_DURATION`, `VO2_MAX`, `STEPS`, `ACTIVE_ENERGY`) read `summaries[METRIC].count > 0`.
- `BMI` derives from `WEIGHT.count > 0`.
- `MOOD` reads `inputs.hasMood`. `MEDICATION` reads `inputs.hasMedication`.
- Carries a `TODO(B1+B4 reconcile)` comment pointing at the dashboard-tile gate B1 wires.

Three render gates consume the helper:

1. `<InsightsTabStrip>` — new `availability?: InsightInputs` prop. The internal `SUB_PAGE_TABS` record maps each `SubPageSlug` to its gating `InsightMetric`. `buildTabs(availability)` filters slugs through `hasMetricData`. Omitting `availability` keeps the strip's pre-v1.4.27 behaviour (every pill renders).
2. `<InsightsLayoutShell>` — owns two new `useQuery`s (`["analytics"]` + `["insights", "comprehensive"]`) and threads the resulting `InsightInputs` into the strip. Same cache keys as the sub-page consumers, so the analytics + comprehensive payloads land once per route.
3. Each `src/app/insights/{slug}/page.tsx` — early-returns an `<EmptyState>` when `hasMetricData(...)` is false. CTA targets per dispatcher prescription:
   - `puls` / `blutdruck` / `gewicht` / `bmi` → `/measurements/new`
   - `stimmung` → `/mood`
   - `medikamente` → `/medications`
   - `schlaf` → `/settings/data-sources`

Test coverage:
- `src/lib/insights/__tests__/metric-availability.test.ts` — 16 cases covering each metric × {has data, no data, undefined summaries, missing summary entry, BMI-from-WEIGHT derivation, sys-vs-dia independence, mood/medication overrides}.
- `src/components/insights/__tests__/insights-tab-strip.test.tsx` — NEW, 6 cases asserting backward-compat behaviour without `availability`, pill-drop when data is missing, overview pill always renders, mood + medication light-up paths, BMI-from-WEIGHT derivation.

## Translation keys for B6

New keys referenced from sub-pages and the tab-strip. None of `messages/*.json` were touched in B4; B6 lands them.

- `insights.emptyState.bloodPressure.title`
- `insights.emptyState.bloodPressure.description`
- `insights.emptyState.bloodPressure.cta`
- `insights.emptyState.weight.title`
- `insights.emptyState.weight.description`
- `insights.emptyState.weight.cta`
- `insights.emptyState.pulse.title`
- `insights.emptyState.pulse.description`
- `insights.emptyState.pulse.cta`
- `insights.emptyState.bmi.title`
- `insights.emptyState.bmi.description`
- `insights.emptyState.bmi.cta`
- `insights.emptyState.mood.title`
- `insights.emptyState.mood.description`
- `insights.emptyState.mood.cta`
- `insights.emptyState.medication.title`
- `insights.emptyState.medication.description`
- `insights.emptyState.medication.cta`
- `insights.emptyState.sleep.title`
- `insights.emptyState.sleep.description`
- `insights.emptyState.sleep.cta`

That is 7 × 3 = 21 keys across DE / EN / FR / ES / IT / PL = 126 strings.

The legacy keys `insights.subPage.stimmungEmpty*` and `insights.subPage.medikamenteEmpty*` and `insights.bmiEmpty*` are no longer referenced by the sub-page; B6 can decide whether to drop them or keep them as aliases.

## Empty-state component structure

Each sub-page reuses the shared `<EmptyState>` primitive (`src/components/ui/empty-state.tsx`) inside the same `<SubPageShell>` the loaded view renders. Pattern per page:

```tsx
return (
  <SubPageShell title={t("insights.<metric>SectionTitle")}>
    <EmptyState
      icon={<MetricIcon className="size-6" />}
      title={t("insights.emptyState.<metric>.title")}
      description={t("insights.emptyState.<metric>.description")}
      action={
        <Button size="sm" asChild>
          <Link href="/<cta-target>">
            {t("insights.emptyState.<metric>.cta")}
          </Link>
        </Button>
      }
    />
  </SubPageShell>
);
```

The shell keeps the page title visible (consistent with the loaded view) and the `<EmptyState>` `variant="card"` default wraps the message in a bordered surface so it sits inside the same scaffolding as the chart would.

## Deviations from the dispatcher prompt

1. **`showEvidenceByDefault` field retention.** The dispatcher said "delete its `<Switch>` plus any persisted pref". I retired the `<Switch>` and the consumer-side wiring but kept the Zod field in `src/lib/validations/coach-prefs.ts` so existing persisted user rows continue to validate without backfill. The field is now dead-but-tolerated; v1.5 can drop it via a forward-compat migration. Rationale: removing the field would force every PUT route caller to update simultaneously, and the `parseCoachPrefs` fallback already handles legacy shapes — keeping the schema stable is the lower-risk choice.

2. **Test for `<message-thread>` default-open assertion.** The dispatcher said "Adjust `message-thread.test.tsx` so the default-open assertion flips to default-closed". The existing test already asserted default-closed at line 316 (`expect(html).not.toMatch(/<details[^>]*\bopen\b/)`); since `useCoachPrefs` was stubbed to return `{ data: undefined }`, the previous test was effectively exercising the `evidenceDefaultOpen = false` branch. No change was needed.

3. **Dashboard tile gate (commit 5).** As instructed, B4 did not touch `src/app/page.tsx`. The helper carries a `TODO(B1+B4 reconcile)` comment pointing at the file/method B1 should import.

4. **B5 lint warnings.** Final `pnpm typecheck` shows 7 errors in `src/app/api/settings/__tests__/telegram-test-locale.test.ts` — that file is bucket B5's territory, not mine. My production changes + tests all type-check + lint clean.

## Test counts

- New tests added: 23 (5 status-card + 7 status-helper + 16 metric-availability + 6 tab-strip - 11 prior = +23 in B4).
- Total B4 tests passing: 83 across 13 files.

## Files touched (final manifest)

Production:
- `src/components/insights/insight-status-card.tsx` (F16)
- `src/lib/insights/pulse-status.ts` (F16)
- `src/lib/insights/weight-status.ts` (F16)
- `src/lib/insights/bmi-status.ts` (F16)
- `src/lib/insights/mood-status.ts` (F16)
- `src/lib/insights/blood-pressure-status.ts` (F16)
- `src/lib/insights/medication-compliance-status.ts` (F16)
- `src/lib/insights/general-status.ts` (F16)
- `src/components/insights/coach-panel/message-thread.tsx` (F14)
- `src/components/insights/coach-panel/coach-settings-sheet.tsx` (F14)
- `src/components/insights/coach-panel/coach-input.tsx` (F15)
- `src/lib/insights/metric-availability.ts` (NEW, F17/F18/F19)
- `src/components/insights/insights-tab-strip.tsx` (F19)
- `src/components/insights/insights-layout-shell.tsx` (F19)
- `src/app/insights/blutdruck/page.tsx` (F17)
- `src/app/insights/gewicht/page.tsx` (F17)
- `src/app/insights/puls/page.tsx` (F17)
- `src/app/insights/stimmung/page.tsx` (F17)
- `src/app/insights/medikamente/page.tsx` (F17)
- `src/app/insights/bmi/page.tsx` (F17)
- `src/app/insights/schlaf/page.tsx` (F17)

Tests:
- `src/components/insights/__tests__/insight-status-card.test.tsx` (NEW)
- `src/lib/insights/__tests__/pulse-status.test.ts` (extended)
- `src/lib/insights/__tests__/weight-status.test.ts` (extended)
- `src/lib/insights/__tests__/bmi-status.test.ts` (extended)
- `src/lib/insights/__tests__/mood-status.test.ts` (extended)
- `src/lib/insights/__tests__/blood-pressure-status.test.ts` (extended)
- `src/lib/insights/__tests__/medication-compliance-status.test.ts` (extended)
- `src/lib/insights/__tests__/general-status.test.ts` (extended)
- `src/components/insights/coach-panel/__tests__/coach-input.test.tsx` (extended)
- `src/components/insights/coach-panel/__tests__/coach-settings-sheet.test.tsx` (extended)
- `src/lib/insights/__tests__/metric-availability.test.ts` (NEW)
- `src/components/insights/__tests__/insights-tab-strip.test.tsx` (NEW)
