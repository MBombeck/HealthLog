# Phase W7e — Atomic Dead-Code Cleanup (Cat-A subset)

Branch: `develop` at `/Users/marc/Projects/HealthLog`
Session: v1.4.25 Wave 7e — touch-disjoint Cat-A items only.
Input research: `.planning/research/w10-dead-code-candidates.md` (10
Cat-A items, 17 Cat-B items, 3 Cat-C items, 414 dead i18n keys).
Scope: 5 of 10 Cat-A items executed; the remaining 5 deferred to W10
reconcile (see §Deferred).

## Items executed

### 7e.1 — Drop the four untracked `/api/export/*` route duplicates

Working-tree directories that were never committed (likely from a
stalled refactor that wanted `.csv` / `.json` suffix routes alongside
the suffix-less ones):

- `src/app/api/export/full-backup.json/`
- `src/app/api/export/measurements.csv/`
- `src/app/api/export/medications.csv/`
- `src/app/api/export/mood.csv/`

**Verification evidence:**

```
$ git log --all --oneline -- "src/app/api/export/full-backup.json/route.ts"
(empty)

$ git log --all --oneline -- "src/app/api/export/measurements.csv/route.ts"
(empty)

$ git ls-files src/app/api/export/
src/app/api/export/__tests__/per-type-routes.test.ts
src/app/api/export/full-backup/route.ts
src/app/api/export/measurements/route.ts
src/app/api/export/medications/route.ts
src/app/api/export/mood/route.ts
src/app/api/export/route.ts

$ grep -rn '/api/export/' src/components src/app --include='*.tsx' --include='*.ts'
src/components/settings/export-section.tsx:393:  endpoint="/api/export/measurements"
src/components/settings/export-section.tsx:420:  `/api/export/medications${query}`,
src/components/settings/export-section.tsx:494:  endpoint="/api/export/mood"
src/components/settings/export-section.tsx:511:  "/api/export/full-backup",
…
```

Every UI caller hits the suffix-less variant. The `.csv` / `.json`
directories are dupes that were never reachable. **Action:** removed
with `rm -r` (no commit needed — untracked).

### 7e.2 — Delete `InsightsPageHero` + its test

Files: `src/components/insights/insights-page-hero.tsx` (`@deprecated`
since v1.4.20 phase B1) and the matching
`src/components/insights/__tests__/insights-page-hero.test.tsx`.

**Verification evidence:**

```
$ grep -rn "InsightsPageHero\|insights-page-hero" src --include="*.tsx" --include="*.ts"
src/components/insights/insights-page-hero.tsx:32: data-slot="insights-page-hero"   (self)
…
src/components/insights/hero-strip.tsx:20:   * Replaces the v1.4.16 `<InsightsPageHero>` with …    (comment-only)
src/components/insights/__tests__/hero-strip.test.tsx:10: * Replaces v1.4.16 `<InsightsPageHero>`. … (comment-only)
src/components/insights/__tests__/insights-page-hero.test.tsx:5:import { InsightsPageHero } from …  (test of dead code)
```

Two remaining post-delete references are *historic markers* in
`hero-strip.tsx` doc-block and its test doc-block — they describe what
HeroStrip replaced. Left intact as authorship/lineage notes.

**Commit:** `1149ae5 chore(insights): remove @deprecated InsightsPageHero (zero callers since v1.4.20)`

### 7e.3 — Delete `IntakeTimeline`

File: `src/components/medications/intake-timeline.tsx`. Exported but no
production consumer.

**Verification evidence:**

```
$ grep -rn "IntakeTimeline\|intake-timeline" src --include="*.tsx" --include="*.ts"
src/components/medications/intake-timeline.tsx:31: interface IntakeTimelineProps {
src/components/medications/intake-timeline.tsx:36: export function IntakeTimeline({
src/components/medications/intake-timeline.tsx:39: }: IntakeTimelineProps) {
```

Three hits — all inside the file. No tests existed.

**Commit:** `784105d chore(medications): remove unused IntakeTimeline component`

### 7e.4 — Delete `ComplianceCharts` wrapper

File: `src/components/charts/compliance-charts.tsx`. The wrapper
composed `<ComplianceHeatmap />` + `<ComplianceLineChart />`, but no
caller mounted the wrapper — analytics pages mount the two children
directly.

**Verification evidence:**

```
$ grep -rn "ComplianceCharts\|compliance-charts" src --include="*.tsx" --include="*.ts"
src/components/charts/compliance-charts.tsx:38: interface ComplianceChartsProps {
src/components/charts/compliance-charts.tsx:42: export function ComplianceCharts({ medications }: ComplianceChartsProps) {
```

Two hits — both inside the file. Children (`ComplianceHeatmap`,
`ComplianceLineChart`) remain alive and were not touched.

**Commit:** `94e048f chore(charts): remove unused ComplianceCharts wrapper`

### 7e.5 — Drop `queryKeys.insightsGeneralStatus`

File: `src/lib/query-keys.ts:33-34`. Residue from W3f Win 3 (commit
`edae569`) which deleted `/api/insights/general-status` but missed the
query-key factory.

**Verification evidence:**

```
$ grep -rn "insightsGeneralStatus" src --include="*.tsx" --include="*.ts"
src/lib/query-keys.ts:33                       (the constant)
src/lib/__tests__/query-keys.test.ts:19        (the matching test)
```

Both removed. The integrity test now pins `insightsBpStatus` instead so
the "locale included in status key" invariant remains covered.

**Commit:** `5743760 chore(query-keys): drop insightsGeneralStatus leftover from W3f route removal`

## Commits made

| SHA | Title |
| --- | --- |
| `1149ae5` | `chore(insights): remove @deprecated InsightsPageHero (zero callers since v1.4.20)` |
| `784105d` | `chore(medications): remove unused IntakeTimeline component` |
| `94e048f` | `chore(charts): remove unused ComplianceCharts wrapper` |
| `5743760` | `chore(query-keys): drop insightsGeneralStatus leftover from W3f route removal` |

Plus the four untracked-directory deletes (no commit needed):
`src/app/api/export/{full-backup.json,measurements.csv,medications.csv,mood.csv}/`.

## Quality-gate results

- `pnpm lint` — clean across the entire `src/` tree (run after all four
  commits).
- `pnpm vitest run src/lib/__tests__/query-keys.test.ts` — 1 file,
  7 tests, all green.
- `pnpm typecheck` — **4 pre-existing errors** caused by concurrent W9e
  parallel work (locale enum widening to `"en" | "de" | "fr" | "es" | "it" | "pl"`
  while a few consumers still type-narrow to `"en" | "de"`):

  ```
  src/components/medications/medication-card.tsx(449,17): TS2345
  src/components/medications/medication-card.tsx(502,68): TS2345
  src/components/medications/medication-form.tsx(734,66): TS2345
  src/components/targets/target-card.tsx(392,5): TS2322
  ```

  Confirmed pre-existing by `git stash && pnpm typecheck` against the
  baseline (which only failed on the pre-existing W9e-induced errors,
  zero of which trace to my deleted files). None of my deletes touched
  these files. They are the W9e i18n agent's responsibility.

## Deferred to W10 reconcile

The remaining 5 Cat-A items + all Cat-B/C items were left for the W10
reconcile reviewer because they share file neighbourhoods with the
concurrent W9e i18n agent (race risk) or need a human go/no-go.

| Item | Reason for deferral |
| --- | --- |
| A6 — `BASE_SYSTEM_PROMPT` constant in `src/lib/ai/prompts/base-system.ts:196` | File is a near-neighbour of the W9e i18n prompt rewrite; deferring avoids a touch-conflict with the concurrent agent. Reviewer can drop in W10 once W9e lands. |
| A7 — `INSIGHTS_SYSTEM_PROMPT` constant in `src/lib/insights/prompt.ts:106` | Same — file is on the W9e edit list (`src/lib/insights/no-key-fallbacks.ts` is already modified). Race-blocked. |
| C1 — `@deprecated` markers in prompt files | Bundled with A6/A7; cannot drop the marker before dropping the export. |
| C2 — Half-quoted `general-status}.ts` comment in `targets/route.ts:807` | Single-line typo fix; not high-value enough to risk a touch-conflict mid-session. |
| 414 dead i18n keys (top 200 batch) | Race-blocked by W9e — `messages/en.json` and `messages/de.json` are currently being mutated by the W9e agent for fr/es/it/pl locales. Must run AFTER W9e lands. Locale-integrity test will guide the prune. |

All Cat-B items (iOS contract endpoints, external webhooks, admin
surfaces) require a human go/no-go and are left for Marc to triage —
the research file already lists them with confidence scores.

## What couldn't be verified-and-deleted with confidence

Nothing within scope. Every item in 7e.1–7e.5 was re-verified with a
fresh `grep -r` immediately before deletion (the research file is 10+
minutes old, so re-verification was paranoia-mode). The two
`InsightsPageHero` comment-references in `hero-strip.tsx` are historic
lineage notes, not live code references — they don't justify
modification mid-session and the research doc explicitly flagged them
as comment-only.

## Touch-disjoint posture confirmation

The 4 commits touched exactly these files:

```
src/components/insights/insights-page-hero.tsx                       (delete)
src/components/insights/__tests__/insights-page-hero.test.tsx        (delete)
src/components/medications/intake-timeline.tsx                       (delete)
src/components/charts/compliance-charts.tsx                          (delete)
src/lib/query-keys.ts                                                (2 lines removed)
src/lib/__tests__/query-keys.test.ts                                 (3 lines edited)
```

Zero overlap with the W7d / W8c / W9e / W10-i18n agent edit sets that
were already in working-tree at session start.
