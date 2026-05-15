---
file: .planning/research/v1427-r1-coach-insights.md
slot: R1.3
purpose: v1.4.27 audit — Coach helper chips, textarea hint footer, metric token leak on Insights sub-pages, data-driven hiding of metrics with zero observations
findings_covered: 14, 15, 16, 17, 18, 19
predecessor_plan: .planning/v1427-plan.md
mode: read-only
target_tag: v1.4.27
---

# R1.3 — Coach and Insights data-driven audit

Six findings, two concerns: the Coach reply-decoration surface bleeds raw values, and the Insights sub-pages render their metric scaffold regardless of whether a series carries any observations. The `metric:PULSE` leak on `/insights/puls` (plus its five siblings) is a producer-side gap — the per-metric status generators normalize whitespace but never strip the chart tokens the same prompt instructs the model to embed.

Headline outcome — the `InsightStatusCard` text payload is the single source of the visible regression. Add `stripChartTokens` at the producer (six `*-status.ts` helpers) and at the consumer (`InsightStatusCard`) to close the defence-in-depth gap. The Coach helper row already gates raw values behind `<details>`; the bug Marc reported is that the row also surfaces a verbose prose preview underneath the assistant bubble — collapse to the disclosure only.

---

## Finding 16 — `metric:PULSE` raw token leak (HIGH severity)

### Root cause in one paragraph

The Insights sub-page `<InsightStatusCard text={status?.text}>` renders the status string at `src/components/insights/insight-status-card.tsx:97` with **no token strip**. The `text` payload comes from `generate*StatusForUser` in `src/lib/insights/{pulse,weight,bmi,mood,blood-pressure,medication-compliance}-status.ts`. Every one of those helpers parses the model reply, runs it through `normalizeSummaryText` (whitespace collapse only — `src/lib/insights/pulse-status.ts:51-53`), then persists it to `auditLog.details` and returns it verbatim. The pulse prompt at `src/lib/ai/prompts/pulse.ts:50` explicitly invites the model to "embed exactly one `metric:PULSE` token in the text to inline the pulse chart" — but the sub-page does not render that chart and never strips the token. The bilingual prompts at `src/lib/ai/prompts/{pulse,blood-pressure,weight,bmi,mood}.ts` all carry the same invitation. The result: every sub-page status card surfaces the literal `metric:PULSE` / `metric:WEIGHT` / `metric:BLOOD_PRESSURE_SYS` substring at the end of the prose. The mother-page `InsightAdvisorCard` already wraps every prose surface in `stripChartTokens` (`src/components/insights/insight-advisor-card.tsx:580/601/629/638`), which is why the leak only shows on the routed sub-pages.

### Why the canonical regex didn't catch it

`stripChartTokens` exists at `src/lib/insights/chart-tokens.ts:184` and already covers three permissive patterns (colon-form `metric:<TYPE>`, capitalised-Metric two-word form, orphan enum identifiers). The regex is correct — it just isn't called on the status-card render path. The leak is purely a wiring oversight on the consumer side and the absence of defence-in-depth on the producer side.

### Proposed fix — two layers

**Layer 1 — consumer side (`InsightStatusCard`)**: wrap `text` with `stripChartTokens` at the render site. One-line change in `src/components/insights/insight-status-card.tsx`:

```tsx
import { stripChartTokens } from "@/lib/insights/chart-tokens";
…
<p className="text-muted-foreground text-sm leading-relaxed">
  {stripChartTokens(text)}
</p>
```

**Layer 2 — producer side (six `*-status.ts` helpers)**: extend `normalizeSummaryText` to call `stripChartTokens` before whitespace collapse so the cached `auditLog.details.text` payload is already clean. This protects every future consumer of `result.text` (Telegram notifications, future PDF export, mobile JSON consumers). The signature stays a `string → string` pure function; the existing tests at `src/lib/insights/__tests__/*-status.test.ts` will catch any unintended cleave.

```ts
function normalizeSummaryText(value: string): string {
  return stripChartTokens(value).replace(/\s+/g, " ").trim();
}
```

Touch surface (six files, identical 3-line patch):

- `src/lib/insights/pulse-status.ts`
- `src/lib/insights/weight-status.ts`
- `src/lib/insights/bmi-status.ts`
- `src/lib/insights/mood-status.ts`
- `src/lib/insights/blood-pressure-status.ts`
- `src/lib/insights/medication-compliance-status.ts`

`src/lib/insights/general-status.ts` should get the same treatment for parity; the mother-page consumer already strips so this is purely additive cache hygiene.

### Cache-poisoning consideration

Old cached `auditLog.details.text` rows already carry the leaked token. The Layer-1 consumer wrap means existing caches render clean immediately, no migration needed. New writes after Layer 2 lands will be clean on disk. The pulse-status route returns within 24h-rolled cache windows so the contaminated rows naturally expire — no Prisma migration required.

### Regression test

Add `src/components/insights/__tests__/insight-status-card.test.tsx`:

```ts
it("strips metric: tokens from the rendered prose", () => {
  render(<InsightStatusCard text="Your pulse is stable. metric:PULSE" … />);
  expect(screen.getByRole("paragraph")).toHaveTextContent("Your pulse is stable.");
  expect(screen.queryByText(/metric:PULSE/)).toBeNull();
});
```

Plus one symmetric helper-level test per status generator confirming the cached `text` field contains no `metric:` substring.

### Sleep sub-page note

`/insights/schlaf` renders `<SleepOverview>` which fetches its own chart data — there is no AI prose path on the sleep sub-page today, so finding 16's "Schlaf" mention does not apply to a status card. If the bug surfaces on `/insights` (mother page) sleep-related advisor copy, that path already strips via `InsightAdvisorCard`. Recommend: confirm the maintainer was referring to the cross-metric advisor mentioning sleep in prose rather than a sleep-specific status card.

---

## Finding 14 — Coach helper chips with literal values

### Current layout

`src/components/insights/coach-panel/message-thread.tsx:386-486` composes the assistant bubble out of three stacked surfaces:

1. The prose bubble (line 411) — `stripChartTokens(content)` already applied, fine.
2. `<SourceChips provenance={metricSource} />` (line 427) — the pill row showing metric+window+sample-count. **This is fine** — it's labels-only, no raw values.
3. The evidence disclosure `<details>` (lines 428-486) — opens to a `<ul>` of `keyValues` with the raw measurements (`<strong>{kv.value}{kv.unit}</strong> ({kv.window})`).

Marc's report — "literal metric values exposed (e.g. 'Blutdruck letzte 30 Tage: 226') then 'Worauf bezieht sich das?' beneath" — describes a row that **renders the value prose unconditionally**, with the disclosure as a secondary hint. Reading the current code, the values ARE inside the `<details>` element — but `evidenceDefaultOpen` (line 435) is `true` when the user's `coachPrefs.showEvidenceByDefault` flag is set. The flag defaults to `false` in `useCoachPrefs`, but if Marc enabled it (or if the default flipped between v1.4.23 H4 and now), the disclosure mounts open and the values are visible without an explicit click.

### Proposed fix

Two-part adjustment:

1. **Drop the default-open path.** Remove the `evidenceDefaultOpen` prop wiring (line 114, 242-303). The disclosure stays a true progressive-disclosure surface: collapsed by default for every reply, the user clicks to expand. The pref it depends on (`showEvidenceByDefault`) becomes dead; either retire it in the settings sheet (`coach-settings-sheet.tsx`) or repurpose it as "Always show source chips" (the chip row is the lightweight label-only summary).

2. **Tighten the summary label.** The `<summary>` line 442-455 currently reads `{t("insights.coach.evidenceLabel")}` — "Worauf bezieht sich das?" in DE. Keep this. The chip row already answers "which metric / window / how many samples"; the `<details>` opens to show the actual numbers. No further label change.

### Touch surface

- `src/components/insights/coach-panel/message-thread.tsx` — drop `evidenceDefaultOpen` prop wiring (3 lines)
- `src/components/insights/coach-panel/__tests__/message-thread.test.tsx` — adjust the test that asserted the default-open behaviour
- `src/components/insights/coach-panel/coach-settings-sheet.tsx` — remove or relabel the `showEvidenceByDefault` toggle

The chip row itself (`SourceChips`) stays unchanged — it is labels-only and is the intended "what is this?" surface.

---

## Finding 15 — Verbose textarea hint footer

### Current layout

`src/components/insights/coach-panel/coach-input.tsx:177-198` renders a hint line directly under the textarea:

```tsx
<span data-slot="coach-input-hint" className="text-muted-foreground text-[11px]">
  {t("insights.coach.composerHint")}
</span>
```

The `composerHint` translation reads "Enter zum Senden, Shift+Enter für neue Zeile" (DE) / "Enter to send, Shift+Enter for new line" (EN). Combined with the disclaimer line in `message-thread.tsx:285-290` and the send button, the composer footer is dense.

### Proposed fix

Replace the prose hint with an `Info` icon next to the send button, wrapping a Radix `<Tooltip>` that renders the existing `composerHint` translation on hover/focus. The icon takes 16×16 px versus the current ~140 px prose footprint, freeing vertical room.

Implementation sketch:

```tsx
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

<div className="mt-1.5 flex items-center justify-end gap-2">
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        aria-label={t("insights.coach.composerHint")}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex h-7 w-7 items-center justify-center rounded focus-visible:ring-2"
      >
        <Info className="size-3.5" aria-hidden="true" />
      </button>
    </TooltipTrigger>
    <TooltipContent>{t("insights.coach.composerHint")}</TooltipContent>
  </Tooltip>
  <Button …>send</Button>
</div>
```

### Touch surface

- `src/components/insights/coach-panel/coach-input.tsx` (~10 lines)
- `src/components/insights/coach-panel/__tests__/coach-input.test.tsx` — update the hint-presence assertion to look for the tooltip trigger's `aria-label`

Translation keys stay the same; the consumer changes from a `<span>` to a tooltip body so screen-reader users still hear the hint on focus.

---

## Findings 17-19 — Data-driven metric visibility

### Current rendering posture

Every Insights sub-page renders its scaffold unconditionally. The visibility decision lives inside individual chart components — `vo2-max-chart-row.tsx:202-220` reads `hasData = count > 0` from the analytics summary and swaps the chart for an empty-state placeholder. The sub-page itself still mounts, the tab strip still lists the pill, and the dashboard tile (where applicable) still renders.

The analytics endpoint at `/api/analytics` already produces `summaries: Record<MeasurementType, DataSummary>` with a `count: number` per type (`src/lib/analytics/trends.ts:192-220`). Per-type counts are the natural foundation for the gating helper. For mood + medication compliance (event-driven, no `Measurement` rows), the gating signals already exist: `getEarnabilityFlags` at `src/lib/gamification/expansion-metrics.ts:317-329` gives `hasMood` and `hasMedication` from `moodEntryCount` and the `hasMedication` boolean.

### Proposed unified gating helper

`src/lib/insights/metric-availability.ts` (new file, ~80 LOC):

```ts
import type { DataSummary } from "@/lib/analytics/trends";

/** Subset of insight surfaces we gate on. Mirrors `SUB_PAGE_SLUGS` plus
 *  the cross-page metrics that don't have a routed sub-page (VO2 max,
 *  body fat, sleep stages). */
export type MetricKey =
  | "BLOOD_PRESSURE_SYS"
  | "BLOOD_PRESSURE_DIA"
  | "PULSE"
  | "WEIGHT"
  | "BMI"           // derived from WEIGHT + height
  | "MOOD"          // event-driven; not in `summaries`
  | "MEDICATION"    // event-driven
  | "SLEEP_DURATION"
  | "VO2_MAX"
  | "STEPS"
  | "ACTIVE_ENERGY";

export interface MetricAvailabilityInputs {
  summaries: Record<string, DataSummary> | undefined;
  hasMood: boolean;
  hasMedication: boolean;
}

export function hasMetricData(
  metric: MetricKey,
  inputs: MetricAvailabilityInputs,
): boolean {
  if (metric === "MOOD") return inputs.hasMood;
  if (metric === "MEDICATION") return inputs.hasMedication;
  if (metric === "BMI") {
    const w = inputs.summaries?.WEIGHT?.count ?? 0;
    return w > 0;
  }
  const count = inputs.summaries?.[metric]?.count ?? 0;
  return count > 0;
}
```

The helper is the single decision point. Three render gates consume it:

#### Gate (a) — sub-page render

Each `src/app/insights/{slug}/page.tsx` reads the analytics summary it already fetches and short-circuits when `hasMetricData(metric, inputs) === false`. The redirect-vs-empty-state question:

- **Empty-state route** — render a `<SubPageShell>` with a CTA pointing to `/measurements/new` or `/settings/data-sources` (depending on whether the metric is manually entered or sync-derived). This matches Apple Health's pattern — empty surfaces lead to onboarding hints.
- **Redirect route** — `redirect("/insights")` so the user lands on a populated overview.

Recommendation: empty-state with CTA. Redirecting from a direct URL the user typed feels unmoored; the CTA path keeps the navigation intent visible.

#### Gate (b) — top nav strip render

`src/components/insights/insights-tab-strip.tsx:65-82` builds the pill list. Today every `SubPageSlug` maps unconditionally to a pill. Wire `hasMetricData` into `buildTabs()`:

```ts
function buildTabs(availability: MetricAvailabilityInputs): TabEntry[] {
  const subPages: Record<SubPageSlug, { labelKey: string; metric: MetricKey }> = {
    blutdruck:   { labelKey: "insights.navBloodPressure",   metric: "BLOOD_PRESSURE_SYS" },
    gewicht:     { labelKey: "insights.navWeight",          metric: "WEIGHT" },
    puls:        { labelKey: "insights.navPulse",           metric: "PULSE" },
    stimmung:    { labelKey: "insights.navMood",            metric: "MOOD" },
    medikamente: { labelKey: "insights.navMedication",      metric: "MEDICATION" },
    bmi:         { labelKey: "insights.navBmi",             metric: "BMI" },
    schlaf:      { labelKey: "insights.navSleep",           metric: "SLEEP_DURATION" },
  };
  return [
    { href: INSIGHTS_OVERVIEW_PATH, labelKey: "insights.navOverview" },
    ...SUB_PAGE_SLUGS
      .filter((slug) => hasMetricData(subPages[slug].metric, availability))
      .map((slug) => ({
        href: `${INSIGHTS_OVERVIEW_PATH}/${slug}`,
        labelKey: subPages[slug].labelKey,
      })),
  ];
}
```

The tab strip lives in `src/app/insights/layout.tsx` — surface the `availability` from the same `/api/analytics` cache key the sub-pages read (`["analytics"]`). React Query unwraps from the same key so the data is single-fetch.

#### Gate (c) — dashboard tile render

The dashboard already has per-tile visibility through Settings → Dashboard layout (`src/lib/dashboard-layout.ts`). The data-driven gate adds a second axis: a tile that is **opted in** but has **zero observations** today renders the empty-state hint. Marc's directive ("no data ⇒ hide everywhere") extends to the dashboard too — apply `hasMetricData` as a render predicate in the tile registry, with an override flag for tiles that intentionally show empty-state CTAs (e.g. onboarding "Add your first weight" prompts).

Concrete wiring: in `src/app/page.tsx` (dashboard), surface `analytics.summaries` to the tile components and let each tile gate itself via `hasMetricData`. The opt-in flag (`dashboardLayout.visible[tileKey]`) AND the data-presence flag MUST both be true for a tile to render.

### Finding 18 — auto-light-up when iOS HealthKit connects

Once the iOS native client uploads `STEPS` / `ACTIVE_ENERGY` / `HEART_RATE_VARIABILITY` / `VO2_MAX` measurements (the v1.4.23 `Measurement.source = "appleHealth"` ingest path is already live), `summaries[METRIC].count` flips from 0 to ≥1. Because every gate above reads from the same `summaries` payload, the corresponding sub-page, tab pill, and dashboard tile all light up automatically on the next React-Query refetch — no separate "feature flag enables Steps tab" path required.

This is the cleanest possible auto-include behaviour: **first measurement defines existence**. Future metrics (Audio Exposure, Time in Daylight, etc.) follow the same rule with zero per-metric wiring beyond a row in `MetricKey` + the slug → metric map.

### Finding 19 — confirmation that the pattern propagates

The proposed `hasMetricData` helper is the single source of truth for sub-page render (a), tab strip render (b), and dashboard tile render (c). Empty sleep sub-page = `summaries.SLEEP_DURATION.count === 0` ⇒ sub-page hides OR shows empty-state CTA, tab strip pill drops, dashboard sleep tile (if opted-in) renders empty-state. Pattern confirmed.

### Touch surface (findings 17-19)

New:
- `src/lib/insights/metric-availability.ts`
- `src/lib/insights/__tests__/metric-availability.test.ts`

Modified:
- `src/components/insights/insights-tab-strip.tsx` — wire the availability filter
- `src/app/insights/layout.tsx` — surface `summaries` + `hasMood` + `hasMedication` to the tab strip
- `src/app/insights/{blutdruck,gewicht,puls,stimmung,medikamente,bmi,schlaf}/page.tsx` — early-return empty-state when `hasMetricData` is false
- `src/app/page.tsx` (dashboard) — apply availability gate per tile registry

Test additions:
- `src/lib/insights/__tests__/metric-availability.test.ts` — unit coverage on the helper (12-15 cases: each metric × {has data, no data, undefined summaries, missing summary entry})
- `src/components/insights/__tests__/insights-tab-strip.test.tsx` — assert pills drop when their underlying summary count is zero
- Per-sub-page integration: assert the empty-state CTA renders when `summaries[metric].count === 0`

---

## File-touch matrix (cross-finding)

| File | Finding(s) | Change kind |
|---|---|---|
| `src/components/insights/insight-status-card.tsx` | 16 | Add `stripChartTokens` wrap |
| `src/lib/insights/pulse-status.ts` | 16 | Extend `normalizeSummaryText` |
| `src/lib/insights/weight-status.ts` | 16 | Extend `normalizeSummaryText` |
| `src/lib/insights/bmi-status.ts` | 16 | Extend `normalizeSummaryText` |
| `src/lib/insights/mood-status.ts` | 16 | Extend `normalizeSummaryText` |
| `src/lib/insights/blood-pressure-status.ts` | 16 | Extend `normalizeSummaryText` |
| `src/lib/insights/medication-compliance-status.ts` | 16 | Extend `normalizeSummaryText` |
| `src/lib/insights/general-status.ts` | 16 (parity) | Extend `normalizeSummaryText` |
| `src/components/insights/coach-panel/message-thread.tsx` | 14 | Drop default-open evidence path |
| `src/components/insights/coach-panel/coach-settings-sheet.tsx` | 14 | Retire `showEvidenceByDefault` toggle |
| `src/components/insights/coach-panel/coach-input.tsx` | 15 | Hint span → tooltip icon |
| `src/lib/insights/metric-availability.ts` | 17, 18, 19 | NEW helper |
| `src/components/insights/insights-tab-strip.tsx` | 19 | Filter pills by availability |
| `src/app/insights/layout.tsx` | 19 | Surface availability inputs |
| `src/app/insights/{slug}/page.tsx` (×7) | 17, 18 | Early-return empty-state |
| `src/app/page.tsx` (dashboard) | 19 | Per-tile availability gate |

No cross-finding collisions. Coach + Insights buckets touch disjoint files except for the shared `metric-availability` helper (consumed only).

---

## Recommended fix-surface buckets for Round 2

Two clean buckets for parallel execution:

**Bucket R1.3-A — Insights token leak + status card hardening (finding 16).** Six status generators + InsightStatusCard + regression tests. Low risk, ~80 LOC, mechanical. Lands first.

**Bucket R1.3-B — Coach helper-chip + textarea hint polish (findings 14, 15).** Three Coach component touches + test adjustments. Low risk, ~40 LOC.

**Bucket R1.3-C — Data-driven metric visibility (findings 17, 18, 19).** New helper + tab strip + 7 sub-pages + dashboard. Higher risk (every sub-page touched); requires careful empty-state copy decisions. Coordinate with R1.1 (dashboard) for tile gate wiring.

---

## Open questions for Round 2 consolidator

1. **Empty-state copy for hidden sub-pages** — should `/insights/puls` with zero observations render `<EmptyState>` with CTA to `/measurements/new`, redirect to `/insights`, or 404? Recommend empty-state + CTA.
2. **Should the `showEvidenceByDefault` pref retire entirely, or pivot to "Always show source chips"?** Recommend retire — the chip row already always shows; the pref is now confusing.
3. **Cache hygiene** — drop the contaminated `auditLog.details` rows on deploy, or rely on the daily-key cache rolling forward? Recommend the latter; no migration needed.
4. **Schlaf token leak scope** — Marc lists Schlaf in finding 16, but `/insights/schlaf` has no status-card path. Confirm whether the leak shows on the mother-page advisor card mentioning sleep, or on a different surface entirely.

---

## Anti-goals

- No prompt-template rewrites in this round. The `metric:<TYPE>` invitation in `src/lib/ai/prompts/*.ts` stays; the strip is the right layer.
- No `ALLOWED_CHART_TOKENS` reshape. The allowlist is correct as-is.
- No Coach drawer relocation. Marc's earlier directive ("CoachDrawer lives in the mother page body only") still holds — this round only touches the bubble + input internals.
- No new Prisma migrations. Status cache stays in `auditLog.details`.
