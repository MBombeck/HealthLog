---
file: .planning/research/v1427-r4-simplifier.md
purpose: R4 code-simplifier review for v1.4.27 (read-only)
contributor: R4
baseline: develop @ 617d4518
scope: 422 commits / 268 files / +19,103 / -3,142 between main..develop
---

# v1.4.27 R4 — code-simplifier review

Read-only sweep of the v1.4.27 diff for duplication, dead code, inline
constants, premature abstraction, convoluted control flow, stale
comments, component bloat, and test-fixture duplication. Most findings
are Medium-Low because R3b B7 already retired the v1.4.25 W4 dead-code
candidates and B7-C8 already centralised the i18n resolver and source-
priority schema derivation.

Severity legend: **High** (ship-blocking-on-merit), **Medium** (worth a
v1.4.27.1 or early v1.4.28 follow-up), **Low** (background hygiene the
next sweep can fold in).

## Summary

| Tier | Count |
|---|---|
| High | 1 |
| Medium | 7 |
| Low | 9 |
| Total | 17 |

| Theme | Findings |
|---|---|
| Insights sub-page duplication | F-H1, F-M1, F-M2 |
| Premature abstraction / unused props | F-M3, F-M4, F-L1 |
| Test-fixture duplication | F-M5 |
| Component bloat | F-M6, F-L2 |
| Stale comments / version markers | F-M7, F-L3 |
| Inline constants / convoluted control flow | F-L4, F-L5, F-L6, F-L7 |
| Minor cosmetic | F-L8, F-L9 |

---

## High

### F-H1 — Seven insights sub-pages duplicate the same data-fetch + empty-state scaffold

`src/app/insights/{blutdruck,bmi,gewicht,puls,schlaf,stimmung,medikamente}/page.tsx` each carry an identical block:

```ts
const { data: analytics } = useQuery({
  queryKey: ["analytics"],
  queryFn: async () => {
    const res = await fetch("/api/analytics");
    if (!res.ok) throw new Error("Failed");
    const json = await res.json();
    return json.data as AnalyticsData;
  },
  enabled: isAuthenticated,
  staleTime: 60 * 1000,
});

if (
  isAuthenticated &&
  analytics &&
  !hasMetricData("WEIGHT", {
    summaries: analytics.summaries,
    hasMood: false,
    hasMedication: false,
  })
) {
  return (
    <SubPageShell title={t("…")}>
      <EmptyState icon={<Scale className="size-6" />} title={…} description={…}
        action={<Button size="sm" asChild><Link href="/measurements?add=WEIGHT">…</Link></Button>}
      />
    </SubPageShell>
  );
}
```

The same six-line `useQuery({ queryKey: ["analytics"] … })` repeats in
**eight** locations (verified):

- `src/app/insights/page.tsx:122`
- `src/app/insights/blutdruck/page.tsx:57`
- `src/app/insights/bmi/page.tsx:57`
- `src/app/insights/gewicht/page.tsx:51`
- `src/app/insights/puls/page.tsx:60`
- `src/app/insights/schlaf/page.tsx:39`
- `src/app/insights/stimmung/page.tsx:50` (via `["insights","comprehensive"]` variant)
- `src/components/insights/sleep-overview.tsx:71`
- `src/components/insights/insights-layout-shell.tsx:47`

`InsightsLayoutShell` already runs the same fetch and threads the
result into `availability` for the tab strip; the sub-page replicas
hit the same React-Query cache key so they're "free" beyond
duplicated typings (`AnalyticsData` redeclared seven times) and the
identical 14-line `EmptyState` block.

**Fix**: Extract `useInsightsAnalytics()` + a `<MetricEmptyState>`
helper that takes `(metric, icon, addType)` and renders the
`SubPageShell` + `EmptyState` + CTA in one place. Each sub-page
shrinks ~30-40 LOC and the next metric (`steps`, `active-energy`,
`vo2-max`) added in v1.4.28 is a one-file change. Same goes for the
five-line `<InsightStatusCard … text={status?.text ?? null}
hasProvider={status?.hasProvider ?? false} cached={status?.cached
?? false} updatedAt={status?.updatedAt ?? null}
loading={isStatusLoading} />` block repeated identically across
six pages — fold into `<InsightStatusCard status={…} loading={…}
title={…} icon={…} />` and unwrap inside the card.

Estimated impact: ~250 LOC across seven page files collapses to
~70-90 LOC plus one shared hook + one shared component.

---

## Medium

### F-M1 — `AnalyticsData` interface declared seven times

Same shape repeats verbatim across every insights sub-page plus
`InsightsLayoutShell`:

```ts
interface AnalyticsData {
  summaries: Record<string, DataSummary>;
}
```

(blutdruck:37, bmi:20, gewicht:21, puls:43, schlaf:30, stimmung — uses
a slimmer `ComprehensiveMoodData`, sleep-overview — uses its own,
insights-layout-shell uses `AnalyticsPayload`). Move to
`src/lib/analytics/types.ts` (already houses `DataSummary`) and import.

### F-M2 — `dynamic(() => import("@/components/charts/health-chart"))` repeats six times

The same `next/dynamic` block plus the `{ default: mod.HealthChart }`
unwrap appears unchanged in:

- `blutdruck/page.tsx:40-46`
- `bmi/page.tsx:33-39`
- `gewicht/page.tsx:34-40`
- `puls/page.tsx:35-41`
- `dashboard/glp1-tile.tsx:38-44` (plus the same shape for `DrugLevelChart`)
- `insights/page.tsx` (similar)

Each consumer pays the same boilerplate to keep SSR off the chart's
Recharts bundle. Promote a single `src/components/charts/health-chart.dynamic.ts`
re-export (`export const HealthChartDynamic = dynamic(...)`) so the
six consumer files lose four lines apiece.

### F-M3 — `<EmptyState ctaSize="lg">` prop landed with zero consumers

`src/components/ui/empty-state.tsx:48` introduced a `ctaSize` prop in
this release for the eight insights sub-page CTAs (CF-36 in the
mobile-fix-plan). The prop, the `[&>a]:min-h-11 …` selector logic,
and the doc-comment all landed — but no consumer passes `ctaSize="lg"`:

```
grep -rn "ctaSize" src/  →  4 hits, all inside empty-state.tsx itself
```

Either the eight CTAs (puls/blutdruck/bmi/gewicht/schlaf/stimmung/
medikamente/main insights page) should be lifted to `ctaSize="lg"`,
or the prop should be revisited in v1.4.28 once consumers actually
opt in. The plan-fix expected eight migrations; the diff has zero.

### F-M4 — `useCoachLaunch().setOpen` exported but only one consumer

`src/lib/insights/coach-launch-context.tsx:50` exposes `setOpen` on
the context value, but the only consumer is
`src/components/insights/layout-coach-mount.tsx` which forwards it to
`<CoachDrawer onOpenChange={launch.setOpen} />`. Every other consumer
(`coach-launch-button.tsx`, the hero strip's suggested-prompt chips,
and the main `/insights` page) reads only `open` + `askCoach`.
Tighten the public surface to `{ open, prefill, askCoach }` and have
the drawer mount read a sibling helper (`closeCoach()`).

Less importantly: `CoachLaunchScope.metric` is doc-stamped "Reserved
for v1.4.28" and is currently `void`-discarded in `askCoach`. Per the
project's "no premature abstraction" principle, drop the parameter
until v1.4.28 actually wires it; today every call site passes one
argument, never two.

### F-M5 — Seven insight-status test files duplicate the same mock prelude

`src/lib/insights/__tests__/{blood-pressure,bmi,general,medication-compliance,mood,pulse,weight}-status.test.ts`
each lead with the same 15-25 line `vi.mock()` block for `@/lib/db`,
`@/lib/ai/provider`, `@/lib/insights/memory`, and (where applicable)
`@/lib/medication-category`:

```ts
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: vi.fn() }, … } }));
vi.mock("@/lib/ai/provider", () => ({ resolveProvider: vi.fn() }));
vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));
```

Extract `src/lib/insights/__tests__/_mocks.ts` with `setupInsightStatusMocks()`
(or rely on Vitest's `setupFiles`) so adding the next status surface in
v1.4.28 doesn't duplicate the prelude again.

### F-M6 — `CoachDrawer` weighs in at ~560 LOC

`src/components/insights/coach-panel/coach-drawer.tsx` carries the
single bottom-sheet/right-sheet switcher, the prefill-reset hook,
the window-pill `<Select>`, the header-action cluster, the body
mount, and **two** mobile rail trays (history + sources) — each rail
tray reproducing the same `<Sheet><SheetContent side="left|right" …>
<SheetHeader>… <div className="h-full min-h-0 overflow-y-auto">…
</div></SheetContent></Sheet>` shape with a different rail prop.

Carve `<MobileRailTray side="left|right" title=… open=… onOpenChange=…>
{rail}</MobileRailTray>` so the two trays share one definition (and
become the natural target for the v1.4.28 unification with the new
`<ResponsiveSheet>` primitive). Drawer should drop to ~400 LOC.

### F-M7 — Heavy stale v1.4.x version markers in code comments

Counted across `src/` (excluding generated/prisma and `__tests__`):

- `v1.4.16-19` markers: **288 lines**
- `v1.4.20-23` markers: **261 lines**
- `v1.4.27` markers: **127 lines**

Many are scaffolding rationale (`v1.4.20 phase B2b`, `v1.4.22 W5`,
`v1.4.23 H4`) that has long since stopped being useful context — the
PR/commit log carries the historical narrative; the source comment
just adds noise. Examples actively misleading the reader:

- `trend-card.tsx:79-83` "v1.4.15 Fix 4 — 7-day trend delta" — fine
  rationale for the prop's existence, but stale since the field
  shape was reshaped by v1.4.22 A2.
- `glp1-tile.tsx:23-26` "v1.4.25 W6 — GLP-1 status tile" inside a
  v1.4.27 file that was substantially rewritten in B1.

Recommendation: a one-off pass that strips version-prefix tags
older than `v1.4.25` (keeping the descriptive sentence that follows).
Probably v1.4.28 hygiene work; not urgent enough for v1.4.27.1.

---

## Low

### F-L1 — `CHART_MINI_HEIGHT_PX` exported with no consumer

`src/lib/charts/constants.ts:24` exports `CHART_MINI_HEIGHT_PX = 160`
intended for "compact / mini variant used by inline previews". Zero
consumers in code:

```
grep -rn CHART_MINI_HEIGHT_PX src/  →  2 hits, both inside constants.ts itself
```

The `<HealthChart mini ...>` callers (glp1-tile, hero-strip) hard-code
their own heights. Either wire the constant or drop it; today it pays
for nothing.

### F-L2 — `next/dynamic` `{ default: mod.X }` unwrap repeats with no shared helper

A specific dynamic-import idiom for SSR-off charts shows up six times
verbatim — `(mod) => ({ default: mod.HealthChart })`. The Next.js
docs accept `dynamic(() => import("X").then(m => m.HealthChart))`
directly when the module is a named export. The hand-rolled wrapper
is a workaround for an older Next bug; the in-line tests still pass
with the simpler form. Same caveat applies to `DrugLevelChart`,
`MoodChart`. Drops six lines per call site.

### F-L3 — Stale TODO / "reserved for v1.4.28" markers in shipped code

- `coach-launch-context.tsx:36-39` — `CoachLaunchScope.metric` "Reserved
  for v1.4.28" (see F-M4 above).
- `coach-launch-context.tsx:67-68` — `void scope;` discard with a
  comment explaining it. The whole parameter chain can go (F-M4).
- `glp1-tile.tsx:60-64` — `rangePointsToHours()` helper with an
  inline `HOURS_PER_DAY = 24` constant defined directly above. Could
  use the existing `MS_PER_DAY` family from `src/lib/time` (if it
  exists) or just inline `points * 24` — the helper is one consumer.

### F-L4 — `useIsMobile()` is two hooks bolted together

`src/hooks/use-is-mobile.ts` takes a `breakpoint: "sm" | "md" = "md"`
parameter to switch between `639.98px` and `767.98px`. Three consumers
read `useIsMobile()` (md default) and one reads `useIsMobile("sm")`
(Coach drawer). The branching plus the `breakpoint` dependency in the
effect adds complexity for one outlier. Two named hooks
(`useIsBelowMd()` + `useIsBelowSm()`) sharing a private helper would
read more cleanly; alternatively, accept a px number so the hook is
extension-friendly.

### F-L5 — `<ResponsiveSheet>` body branches duplicate the `hideHeader` flag rendering

`src/components/ui/responsive-sheet.tsx:96-194` mounts the same
`hideHeader ? <Header className="sr-only">…</Header> : <Header>…</Header>`
shape twice — once inside the Sheet branch, once inside the Dialog
branch — with only the underlying primitives (`SheetHeader` vs
`DialogHeader`) varying. Carve a `renderHeader(Header, Title,
Description, props)` helper, or even thinner: render the
`hideHeader === true` case via `<VisuallyHidden>{title}</VisuallyHidden>`
which is what the `sr-only` wrappers approximate. Drops ~25 LOC.

### F-L6 — `glp1-tile.tsx`'s `useDateWithWeekday()` + `useDeltaDisplay()` hooks each have one consumer

Both private hooks live inside the GLP-1 tile and are called exactly
once (line 189 + line 190). The "hook with useMemo" pattern is
overkill for two helpers that the caller could pass a `fmt` parameter
to and call as a plain function. Less code, same behaviour, easier
to test.

### F-L7 — `metric-availability.ts` falls back to a string key lookup that an enum-driven map would catch at compile time

`src/lib/insights/metric-availability.ts:88` reads
`inputs.summaries?.[metric]?.count ?? 0`. The `summaries` type is
`Record<string, DataSummary>` so the lookup tolerates typos in
`metric`. Tighten to `Record<InsightMetric, DataSummary>` so a future
metric added to `InsightMetric` without a matching summary key fails
typecheck instead of returning `false` silently (the function comment
explicitly hopes for this).

### F-L8 — `<CoachLaunchButton>` renders two button copies and toggles them via `lg:hidden` / `hidden lg:inline-flex`

`src/components/insights/coach-launch-button.tsx:50-91` paints the same
sparkle-icon button twice — one as FAB (`<lg`), one inline (`lg+`).
Both share `accessibleLabel`, both share `onClick`, both share the
same Sparkles icon, and only the className differs. CSS-level
visibility toggling is fine; the duplication could collapse with a
small `const cls = useMediaClass()` helper or two `data-variant`
slots driven by the same JSX. Low priority — the two branches do read
clearly today.

### F-L9 — `src/components/dashboard/glp1-tile.tsx:430-468` `TabButton` + `DeltaCaption` carved into the same file

Both helpers exist solely to colocate styling inside the tile.
`TabButton` (30 LOC) is a private segmented-control button whose
`role="tab"` and `min-h-11` shape would suit a shared
`<SegmentedTab>` if we end up shipping a second segmented control
(Insights tabs flirt with the same idiom). Today it's premature; flag
for v1.4.28 once a second consumer arrives.

---

## Verification of B7 dead-code cleanup (no findings)

`R3b B7` already deleted the v1.4.25 W4 dead candidates flagged by
`w10-dead-code-candidates.md`. Spot-checked:

- `IntakeTimeline`, `ComplianceCharts`, `InsightsPageHero` — files gone, only stale
  comment references in `hero-strip.tsx:20` and the hero-strip test header
  (harmless documentation residue).
- `queryKeys.insightsGeneralStatus` — gone.
- `BASE_SYSTEM_PROMPT` / `INSIGHTS_SYSTEM_PROMPT` bare exports — gone (only `_DE` / `_EN` forms remain).
- `/api/audit-log` route — gone (admin variant `/api/admin/audit-log` retained).
- Eight GLP-1 type re-exports + `WEEKDAY_KEYS` from `glp1-snapshot` — internalised.

No additional dead-code findings beyond F-L1 (`CHART_MINI_HEIGHT_PX`).

---

## Convoluted control flow — clean

Re-checked the contention spots from the diff:

- `glp1-tile.tsx:390-426` — ternary chain (`activeTab === "level" && med.medicationId
  ? <DrugLevelChart …/> : activeTab === "level" ? <p …unavailable/> :
  med.weightSeries.length > 0 ? <HealthChart … /> : <p …unavailable/>`).
  Reads as a four-way switch and is hard to grok at a glance, but
  refactoring to a `match`-style helper would add ceremony for the
  same number of branches. Leave it.
- `responsive-sheet.tsx:96-193` — branch reads cleanly enough; F-L5
  is the only refactor worth doing.
- `sources-section.tsx:184-194` — `reorderLadder<T>(list, index, delta)`
  is a clean centralisation of the prior `moveSource` / `moveDeviceType`
  drift. Good.

## Test-fixture duplication — focal point

F-M5 covers the seven status-test prelude. Beyond that, the Coach,
insight, ResponsiveSheet, and Native-Select test files each pull in
their own bespoke mocks. The volume is fine; the seven repeated
preludes are the single concentrated win.

## Component bloat (>300 LOC / functions >80 LOC) — clean apart from F-M6

| File | LOC | Verdict |
|---|---|---|
| `src/app/page.tsx` | 1264 | Out-of-scope (dashboard mount) |
| `src/components/charts/health-chart.tsx` | 1643 | Out-of-scope (touched lightly) |
| `src/components/medications/medication-form.tsx` | 1126 | Out-of-scope (touched only for `min-h-11` etc.) |
| `src/components/insights/coach-panel/coach-drawer.tsx` | 560 | F-M6 — split mobile rail trays |
| `src/components/settings/sources-section.tsx` | 605 | OK — the per-axis sections are necessarily verbose |
| `src/components/settings/api-section.tsx` | 598 | Has the dual desktop-table / mobile-card-list shape twice; consider a `<ApiTokenTable variant="desktop|mobile">` carve-out for v1.4.28 (medium-low) |
| `src/components/admin/login-overview-section.tsx` | 527 | Same dual-render pattern; v1.4.28 follow-up |
| `src/app/insights/medikamente/page.tsx` | 281 | OK — colocated `MedicationComplianceCalendar` carries its own data fetch |

The dual desktop-table / mobile-card-list pattern (api-section,
login-overview-section, app-log-preview-section, recent-audit-preview)
is the next natural duplication theme. v1.4.27 didn't ship a
shared `<ResponsiveTable>` primitive — and shouldn't, until a fifth
consumer arrives. Flag for v1.4.28 when the iOS-era admin views land.

## Recommended ordering for a v1.4.28 simplification micro-bucket

1. F-H1 — extract `useInsightsAnalytics()` + `<MetricEmptyState>`
   (single biggest win; touches eight files).
2. F-M1 — `AnalyticsData` to a shared types module (one-line edit per consumer).
3. F-M3 — wire the eight insights `<EmptyState>` consumers to
   `ctaSize="lg"` so the prop earns its keep.
4. F-M5 — shared insight-status test prelude.
5. F-M4 — tighten `useCoachLaunch()` public surface; drop
   `CoachLaunchScope` until v1.4.28 actually uses it.
6. F-M2 — single `<HealthChartDynamic>` re-export.
7. F-M6 — `<MobileRailTray>` carve-out from `CoachDrawer`.
8. F-M7 — old version-marker scrub (mechanical, defer-able).
9. F-L1 — drop `CHART_MINI_HEIGHT_PX` or wire it.
10. The rest of the Low tier can fold into adjacent same-file edits
    when they come up.
