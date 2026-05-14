# Insights sub-pages — UX research for v1.4.25

Author: Research pass for the `/insights` mother-page split.
Scope: navigation, chart parity, comparison correctness, header restructure, duplicate-card audit, trends-row unification.
Status: research only — no code changes.

---

## 0. Context

The current `/insights` page (`src/app/insights/page.tsx`, ~1820 lines) is a single
monolithic dashboard: sticky tab strip, hero, daily briefing, correlation row,
trends row, AI advisor card, then six anchored scroll sections (general,
bp, weight, pulse, mood, meds, bmi). Marc wants this carved into a mother
page (Hero + Briefing + Trends + Coach) and six routed sub-pages, each
dedicated to one metric, with Dashboard-style per-chart settings. The
Coach drawer stays on the mother page only.

Anchor data points for this report:

- Dashboard chart wiring: `src/app/page.tsx` lines 945–1095 (every
  `<HealthChart chartKey="…" compareBaseline={compareBaseline} />` call).
- Per-chart prefs hook: `src/hooks/use-chart-overlay-prefs.ts`.
- Persistence shape: `src/lib/dashboard-layout.ts` (`ChartOverlayPrefs`,
  `chartOverlayPrefsMap`, `comparisonBaseline` clamping).
- Cog UI: `src/components/charts/chart-overlay-controls.tsx`.
- Chart consumer side (toggles applied): `src/components/charts/health-chart.tsx`
  lines 354–394 and 610–720; `src/components/charts/mood-chart.tsx` 615–700.
- Insights sticky tab strip: `src/app/insights/page.tsx` lines 1704–1816.
- Trends row: `src/components/insights/trends-row.tsx`.
- Hero strip + regenerate button: `src/components/insights/hero-strip.tsx`
  (button at 294–315).
- Duplicate concern: `<InsightAdvisorCard>` (lines 1013–1019) renders
  `insights.aiAnalysisTitle` ("KI-Gesundheitsanalyse"); the following
  general-status section (1021–1042) renders `insights.generalStatusTitle`
  ("Allgemeiner Gesundheitszustand") through `<InsightStatusCard>`.

---

## 1. Benchmark research — how mature health apps structure metric deep-dives

I drew on hands-on knowledge of the named apps plus the most recent
publicly-documented information; library docs (Context7/MDN) were not
needed for this section because the question is about UX conventions
rather than API surface.

### 1.1 Apple Health — Browse tab

Apple Health is the dominant reference for this exact problem because it
ships per-category deep-dive screens that millions of users have been
trained on.

- **URL structure**: native, but conceptually `Browse → Category →
Metric`. Each metric (Blood Pressure, Weight, Heart Rate) is a
  full-screen route with its own back button. Deep-links into a metric
  exist via `x-apple-health://` URIs and Shortcuts.
- **Back affordance**: standard iOS chevron-left in top-left, labelled
  with the parent's title ("Browse"). Always present, always tappable;
  never an inline "back to overview" CTA inside the body.
- **AI / coach surfacing**: Apple Health does _not_ surface its summary
  copy ("Trends", "Highlights", "Notable") inside a per-metric page —
  those live only on the Summary tab. The metric page shows graphs +
  Show All Data + Add Data; cross-cutting narrative stays on Summary.
  This is the strongest external precedent for Marc's "Coach on mother
  page only" rule.
- **Comparison**: per-metric segmented control above the chart with
  D / W / M / 6M / Y / All. Tapping switches both the visible window
  _and_ the aggregation bucket (day → day, week → daily-min/max bars).
- **Empty state**: a one-line "No data" with a "+ Add Data" CTA. No
  fake chart, no placeholder line.
- **Loading state**: native skeleton — the segmented control + axes
  paint instantly from cached layout; only the data path animates.
  No layout shift.

### 1.2 Withings Health Mate

- **URL structure**: native; "Health Data → tile → detail" three-level
  drill. Each detail screen has tabs at the top (per-metric measurements
  for the same body system).
- **Back**: bottom-tab returns to the previous level; no inline "back".
- **AI / coach**: Withings' insight chip lives on the home / dashboard
  tile, not on the detail page. The detail page is graph + table + add.
- **Comparison**: D/W/M/Y switcher. No "vs last year" overlay — they
  show the period in absolute terms and rely on the user mentally
  diffing.
- **Empty state**: "Take your first measurement" inline card.
- **Loading**: cached values surface immediately, fresh values fade in.

### 1.3 Oura

- **URL structure**: native; tabbed `Today | Trends | Activity | Sleep |
Readiness | …` with each tab a full screen. Within a metric tab the
  user can pull down to switch from "today" to "weekly trends".
- **Back**: no back chevron — every metric is a tab. The "overview" is
  also a tab (Today).
- **AI / coach (Oura Advisor)**: chat lives on a dedicated tab that
  speaks for the whole account. Each metric tab does have one or two
  AI-authored sentences inline ("Sleep was 12 % below your norm"). This
  is the model Marc's `<TrendAnnotation>` already follows.
- **Comparison**: 30-day / 90-day / 6-month / 1-year segmented control;
  always overlays a faint band of the user's personal mean ± SD.
- **Empty state**: zero-state illustration + "needs N more days of
  data".
- **Loading**: skeleton with the segmented control already lit.

### 1.4 Garmin Connect

- **URL structure**: native; web app uses true routes
  (`connect.garmin.com/modern/<metric>`). Each metric is its own URL
  and deep-linkable.
- **Back**: web has standard browser back; native has a chevron.
- **AI / coach**: minimal — no chatbot. Insight is a 1-line caption per
  card.
- **Comparison**: per-card "Compare to" picker (Previous period / Last
  year / Personal best). When there's no comparison data, the picker
  is greyed out, not hidden. This is a notable contrast with the
  Withings approach.
- **Empty state**: dashed-border card with "Connect a device" CTA.
- **Loading**: shimmer skeletons that exactly match the loaded layout.

### 1.5 Whoop

- **URL structure**: native; full-screen metric pages reached from the
  home dashboard. Each chart is editable (window, overlay).
- **AI / coach (Whoop Coach)**: a dedicated coach tab. Each metric page
  shows a "Coach tip" card at the bottom but it's a pull-in of the
  coach's latest answer about that metric — not an interactive
  composer.
- **Comparison**: 7-day, 30-day, 6-month windows. Comparison is
  rendered as faint dotted "your average" line — same idea as Oura.
- **Empty state**: "Wear your strap for 24 h to see this".
- **Loading**: layout paints first, data animates in.

### 1.6 Cronometer

- **URL structure**: true routes (`/charts`, `/biometrics/weight`,
  `/biometrics/blood-pressure`). The closest UX to what Marc is
  designing.
- **Back**: browser back + a "← Charts" inline link in the breadcrumb
  row.
- **AI / coach**: not present; product is data-first.
- **Comparison**: explicit "Compare ranges" overlay with a date-picker
  dialog — power-user surface, lives in the chart toolbar.
- **Empty state**: blank chart area + "Log a measurement" button.

### 1.7 Bearable

- **URL structure**: tabs + nested routes. Trends tab has a metric
  picker that drives an in-place chart change (does _not_ change the
  URL). Power users complain about this in app-store reviews because
  they can't bookmark or deep-link to "weight last month".
- **AI / coach**: none — Bearable is correlations-only.
- **Comparison**: side-by-side metric overlay (any two metrics on one
  chart).
- **Empty state**: dotted placeholder.

### 1.8 Distilled patterns

| Pattern               | Apple                | Withings        | Oura               | Garmin              | Whoop           | Cronometer    | Bearable       |
| --------------------- | -------------------- | --------------- | ------------------ | ------------------- | --------------- | ------------- | -------------- |
| Routed metric URLs    | native               | native          | native             | yes (web)           | native          | yes           | partial (no)   |
| AI on metric page     | no                   | no              | inline tip         | no                  | inline tip      | n/a           | n/a            |
| AI on overview        | yes (Summary)        | yes (Home tile) | yes (Today)        | n/a                 | yes (Coach tab) | n/a           | n/a            |
| Window picker         | D/W/M/6M/Y/All       | D/W/M/Y         | 30/90/6M/Y         | per-card            | 7/30/6M         | range picker  | tab-level      |
| Comparison overlay    | implicit (norm band) | none            | personal mean band | "compare to" picker | dotted mean     | range overlay | metric overlay |
| Empty state on metric | inline + CTA         | inline + CTA    | days-required      | inline + CTA        | inline + CTA    | inline + CTA  | dotted         |
| Loading skeleton      | true skeleton        | progressive     | true skeleton      | shimmer             | progressive     | basic         | basic          |

**Takeaways for HealthLog**:

1. **The Apple Health model fits Marc's stated rule the cleanest**:
   AI/coach lives on the overview, never on the metric page. Oura/Whoop
   keep a short _inline annotation_ on the metric page but no
   composer — this matches what HealthLog's `<TrendAnnotation>`
   already does and is worth keeping on the sub-pages (the AI sentence
   below the main chart, not a full advisor card).
2. **Routed URLs win over in-place tab switches** for bookmarking,
   share-this-link, and PWA back-button behaviour. Bearable's tab-
   without-route choice is the documented anti-pattern.
3. **The window picker is universal** — D / 7d / 30d / 90d / 1y. The
   existing HealthChart already exposes this (`TIME_RANGES_KEYS` in
   `health-chart.tsx`); the sub-pages just need to render the chart
   in non-mini mode so the picker shows.
4. **Comparison overlay handling diverges**: Garmin greys the picker
   when there's no historical data; Apple/Withings hide it. The
   existing HealthChart has a third state — "Comparison unavailable —
   no data from last month yet" caption — which is the best of both.
   Keep it (see §4).
5. **Loading states must not shift layout**. Every benchmark paints
   the axes / picker / title first and animates only the data path.
   The existing `<ChartSkeleton>` in `trends-row.tsx` (220px reserved
   block) is the right pattern; sub-pages should mirror it.

---

## 2. Navigation pattern — tabs vs routes vs both

### Current state

`<InsightsSectionNav>` in `src/app/insights/page.tsx` (1726–1815) is a
sticky pill-tab strip. Each pill calls `scrollIntoView` on a `<section
id="section-bp">` anchor. There is no URL change. The user cannot
deep-link to a metric. An IntersectionObserver flips the active pill
as the user scrolls.

### Constraint inventory

- **Bookmark / share**: today impossible. A directive that says
  "show me your weight insights" requires the user to scroll. This is
  exactly the Bearable failure mode.
- **PWA back stack**: the Insights page lives at one URL, so the
  browser back button doesn't take you back through metrics.
- **TanStack Query cache reuse**: most queries are keyed by metric
  (`["chart-data", "WEIGHT", …]`, `["insights", "weight-status", locale]`)
  so navigating between routes does **not** re-fetch — the cache key
  collision concern (see memory `feedback_react_query_key_collision.md`)
  applies here; convention is one queryKey per concept and the existing
  keys are already metric-scoped.
- **Bundle size**: Recharts is ~108 KiB Brotli and is already
  defer-loaded per metric via `next/dynamic`. Routing per metric does
  not increase bundle cost because each sub-page only mounts the
  metric's chart.
- **Coach drawer**: stays in the mother layout. If sub-pages are sibling
  routes (not nested under `/insights/layout.tsx`), the drawer is
  unmounted on navigation — correct per Marc's "drawer on mother page
  only" rule. If they were nested inside a shared `/insights/layout.tsx`
  that owns the drawer, the drawer would persist across navigation —
  _wrong_ for this product decision.

### Recommendation

**Adopt routed sub-pages with the existing pill strip as the
navigation control** ("tabs that link to routed sub-pages", option 3 in
Marc's question). Concretely:

- The pill strip becomes a `<nav>` that renders `<Link href="/insights">`,
  `<Link href="/insights/blutdruck">`, etc. — not a `scrollIntoView`
  caller.
- The active pill is derived from `usePathname()` (Next.js App Router),
  not from IntersectionObserver. The IO logic is deleted; the strip
  is pure presentation.
- Each sub-page is a sibling under `src/app/insights/blutdruck/page.tsx`,
  `src/app/insights/gewicht/page.tsx`, etc. The mother page stays at
  `src/app/insights/page.tsx`.
- **No shared `/insights/layout.tsx`** because that's where the
  CoachDrawer would persist. The pill strip lives inside each page
  (rendered as a stable component so the React tree it produces is
  identical across navigations — Next.js will warm-cache the
  components). Or, equivalently, the strip is rendered inside a
  `layout.tsx` _but_ the CoachDrawer stays inside `src/app/insights/page.tsx`
  body. Layout-mount-the-strip is fine; layout-mount-the-drawer is not.
- **URL slugs**: keep the German slugs Marc has named (`/blutdruck`,
  `/gewicht`, `/puls`, `/stimmung`, `/medikamente`, `/bmi`). They match
  the i18n posture of the product and are short.
- **Re-mount cost**: TanStack Query caches survive React unmounts, so
  switching tabs has no re-fetch cost. The HealthChart's heavy data
  transform (`useMemo` chains in `health-chart.tsx` 605–720) runs once
  per mount, but the data inputs are stable across mounts (same query
  key, same hydrated data), so the work is sub-millisecond.

### Files to create

```
src/app/insights/
  page.tsx                     # mother page (existing, slim down)
  layout.tsx                   # NEW: shared <InsightsTabStrip>
  blutdruck/page.tsx           # NEW
  gewicht/page.tsx             # NEW
  puls/page.tsx                # NEW
  stimmung/page.tsx            # NEW
  medikamente/page.tsx         # NEW
  bmi/page.tsx                 # NEW
  report/[week]/page.tsx       # existing
```

### Strip component

The current `<InsightsSectionNav>` can be extracted to
`src/components/insights/insights-tab-strip.tsx`. Replace its
`scrollTo` + IO with `usePathname` + `<Link>`. The strip's existing
`-30 % / -60 %` rootMargin + active styling token map can stay verbatim
once the routing wiring lands.

---

## 3. Chart settings parity — reusing the Dashboard per-card pattern

The pattern is already mature. There is no new infrastructure to
write; the sub-pages simply need to mount `<HealthChart>` /
`<MoodChart>` with a `chartKey` prop (not just `compareBaseline`).
Today's Insights page passes `compareBaseline={compareBaseline}` only
— that wires the row-level shared baseline (from
`useDashboardChartPrefs() → dashboardWidgetsJson.comparisonBaseline`)
but **does not enable the per-card cog**. Compare lines 1060–1069
(`/insights`) vs 989–1007 (`/`).

### How the per-card cog actually works

1. `<HealthChart chartKey="bp" compareBaseline={compareBaseline} />`
   passes a stable string key.
2. Inside the chart (line 387), `useChartOverlayPrefs(chartKey)` reads
   from `["dashboard-layout"]` TanStack cache and returns the four
   booleans/enum.
3. At line 391–393, the chart picks the per-chart
   `comparisonBaseline` when `chartKey` is truthy, falling back to the
   row-level prop otherwise. This is the dual-source pattern that
   makes the Settings global toggle and the per-card override coexist.
4. At line 1018–1023, the cog renders only when `chartKey` is truthy.
5. Toggle → `onChange(next)` → `mutation.mutate(next)` → optimistic
   cache update → `PUT /api/dashboard/chart-overlay-prefs`.

### What the sub-pages need to do

For every chart on a sub-page, pass a `chartKey` from the
`CHART_OVERLAY_KEYS` list in `src/lib/dashboard-layout.ts`. The map
is:

| Sub-page                | chartKey on main chart                         | Notes                                                        |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `/insights/blutdruck`   | `"bp"`                                         | already in CHART_OVERLAY_KEYS                                |
| `/insights/gewicht`     | `"weight"`                                     | already there                                                |
| `/insights/puls`        | `"pulse"`                                      | already there                                                |
| `/insights/stimmung`    | `"mood"`                                       | already there                                                |
| `/insights/bmi`         | `"bmi"`                                        | already there                                                |
| `/insights/medikamente` | n/a — MedicationComplianceChart per medication | already keyed per-med via `chartKey="medications"` row-level |

**No backend changes required.** The `chartOverlayPrefsMap` keyed on
these exact strings already round-trips through the existing
`PUT /api/dashboard/chart-overlay-prefs` endpoint, persisted in
`User.dashboardWidgetsJson.chartOverlayPrefs`. The Insights surface
just needs to pass `chartKey` it currently omits.

### Cross-surface coupling consideration

A user who toggles "Target range" on the dashboard `bp` chart will see
that toggle persist on `/insights/blutdruck` because both surfaces
share `chartKey="bp"`. **This is the intended behaviour** and matches
Marc's stated goal: charts on sub-pages should work LIKE the Dashboard
charts. Each chart card has one identity ("bp"), one set of prefs,
mirrored anywhere it renders. If Marc later wants surface-independent
prefs ("bp on dashboard quiet, bp on detail loud") the key namespace
would have to widen to e.g. `"bp:dashboard"` / `"bp:insights"` — _not_
recommended; it doubles the prefs surface for unclear product win.

### Sub-page chart component recommendation

Each sub-page is ~150 LOC and follows a consistent shape:

```
src/app/insights/<slug>/page.tsx
  "use client"
  - useAuth, useTranslations, useQuery for the metric-specific
    /api/insights/<metric>-status payload
  - <InsightsTabStrip />          (or via layout)
  - <h1>{t("insights.<metric>SectionTitle")}</h1> + status Badge
  - <HealthChart chartKey="<metric>" types={…} compareBaseline={compareBaseline}
      valueBands={…} targetZones={…} annotations={…} />
  - secondary cards (correlation scatter, value-table, related meds)
  - <InsightStatusCard …/>        (per-metric AI text from existing API)
```

The shared `compareBaseline` row-level read can be lifted into a
single `useInsightsLayoutPrefs()` helper to avoid the four-line
TanStack-Query duplication that the current page repeats for `layoutData`
(lines 564–575). Recommended path:
`src/hooks/use-insights-layout-prefs.ts`. Single source: re-read the
existing `["dashboard-layout"]` cache via `useQueryClient` rather than
re-fetching — same pattern as `use-chart-overlay-prefs.ts`.

---

## 4. Comparison-overlay correctness (no hallucinated data)

### Current behaviour audit

`<HealthChart>` already handles this correctly. Read
`src/components/charts/health-chart.tsx` 659–669:

```ts
const hasComparisonData = useMemo(() => {
  if (effectiveCompareBaseline === "none" || !chartDataWithCompare)
    return false;
  return chartDataWithCompare.some((point) =>
    types.some(
      (type) =>
        typeof point[`${type}_compare`] === "number" &&
        Number.isFinite(point[`${type}_compare`] as number),
    ),
  );
}, [chartDataWithCompare, effectiveCompareBaseline, types]);
```

Then lines 972–995 paint one of two captions:

- `hasComparisonData === true` → "Vergleich: letzter Monat" /
  "Vergleich: letztes Jahr" purple chip.
- `hasComparisonData === false` → "Vergleich: kein Vorjahres­zeitraum
  verfügbar" muted-grey chip.

The dimmed overlay line itself simply doesn't paint because the
`${type}_compare` field is undefined for every visible day. No
hallucinated points get drawn.

### Edge case — partial coverage

The current code (line 656 comment) accepts "some days have prior
data, some don't" as "available" and shows the affirmative caption.
This is the right call: the user sees a dimmed line that has gaps,
which is honest. The alternative (treat partial as "unavailable")
would hide a useful overlay just because not every visible day has a
prior counterpart — that's the over-pessimistic side of the hallucination
guard.

### Edge case — comparison window straddles the user's signup

If the user has 60 days of data and selects "vs last year", every
shifted point falls before the user's first measurement.
`hasComparisonData` is false → grey caption shows, no line drawn.
**Correct, no further work needed.**

### Recommendation

No change to the existing implementation. **Document this contract in
the JSDoc above `hasComparisonData`** so a future contributor doesn't
"helpfully" fill in the gaps with interpolation. One line addition,
no code logic change:

```ts
/**
 * v1.4.16 phase B8 — true when at least one visible day has a prior-
 * period value …
 *
 * CONTRACT (v1.4.25 sub-pages research): when this is false the
 * dimmed-comparison line MUST NOT paint. We never interpolate
 * gaps with synthetic data; the chart is a record of what the user
 * has, not a forecast. See .planning/research/insights-sub-pages-ux.md §4.
 */
```

### Optional UX polish (not required to ship)

Garmin greys the comparison picker when no data exists. The existing
cog (`chart-overlay-controls.tsx`) shows all three buttons (None /
LastMonth / LastYear) regardless. A small enhancement would be to
read `hasComparisonData` for each candidate and add a `disabled`

- "Not enough history" title on the buttons that would produce
  empty overlays. This is a tooltip-level touch and is _not_ required
  for the v1.4.25 ship; it can sit in v1.4.26 backlog.

---

## 5. Header / menu-bar restructure — moving "Analyse neu starten" to the top-right

### Where the button lives today

`src/components/insights/hero-strip.tsx` lines 294–315. The button is
rendered inside the hero `<Card>` body, in the same flex row as the
"Ask the coach" button. Translation key `insights.heroActionRerun`
("Analyse neu starten"). The handler is wired through `onRegenerate`
from the page, which calls `advisor.regenerate` from
`useInsightsAdvisorQuery` (line 967).

### Where Marc wants it

In the menu bar (the sticky tab strip) in the top-right, icon-only
(RefreshCw, no text), right-aligned, same colour as the tab text
(currently `text-muted-foreground` for inactive pills).

### Recommended placement in the React tree

Once §2 lands and the tab strip is extracted to
`src/components/insights/insights-tab-strip.tsx` and wired via a
`/insights/layout.tsx`, the strip exposes a right-aligned slot:

```tsx
<nav aria-label={…} className="sticky top-0 …">
  <div className="flex items-center gap-2">
    <div className="flex gap-2 overflow-x-auto">
      {SECTION_TABS.map(tab => <TabLink … />)}
    </div>
    <div className="ml-auto flex items-center gap-1">
      <RegenerateButton />   {/* icon-only, right-aligned */}
    </div>
  </div>
</nav>
```

The `<RegenerateButton>` is a thin client component that mounts
`useInsightsAdvisorQuery()` and renders one ghost icon button. It
appears on every Insights surface (mother + every sub-page) because
it sits in the layout — which is the intended behaviour: a user on
`/insights/blutdruck` can also retrigger the analysis without going
back to the mother page.

The `<HeroStrip>` props can drop `onRegenerate` and `regenerating` (or
they stay no-op when omitted; the existing component already gates the
button render on `onRegenerate` truthy, so passing undefined just hides
it from the hero — clean).

### Accessibility

- `aria-label={t("insights.heroActionRerun")}` so screen readers still
  hear "Analyse neu starten" even though the button is icon-only.
- `min-h-11 min-w-11` to keep the 44 × 44 px touch-target (parity with
  `chart-overlay-controls.tsx` line 103).
- Disabled state during `regenerating` flips the icon to `<Loader2
className="animate-spin">` (already wired in hero-strip 304–308 —
  copy that conditional).
- Colour: `text-muted-foreground hover:text-foreground` matches the
  inactive tab pill styling at line 1805.

### Risk

The regenerate button currently shows a `<Toast>`-less "regenerating"
text label. Once it's icon-only the user loses that affordance. Two
options:

1. Mount a `<Tooltip>` on the icon that says "Wird neu generiert…" when
   `regenerating` is true.
2. Surface a small toast on success ("Reports wurden neu generiert" —
   that translation key already exists at de.json:1403).

Option 2 is preferable because it confirms completion, not just intent.
Option 1 confirms intent only and disappears at the wrong moment.

---

## 6. Duplicate-card audit — "KI-Gesundheitsanalyse" vs "Allgemeiner Gesundheitszustand"

### Verification by grep

```
src/app/insights/page.tsx:1013–1019    <InsightAdvisorCard … />
                                       → renders insights.aiAnalysisTitle
                                         ("KI-Gesundheitsanalyse")
                                         via the loading + empty states
                                         at lines 341 + 373 of
                                         insight-advisor-card.tsx
src/app/insights/page.tsx:1023–1042    <section id="section-general">
                                       → renders insights.generalStatusTitle
                                         ("Allgemeiner Gesundheitszustand")
                                         via <InsightStatusCard>
```

### Content comparison

- **`<InsightAdvisorCard>`** (`src/components/insights/insight-advisor-card.tsx`):
  consumes the rich `InsightResult` payload — classification badge,
  severity-ordered recommendations grid, per-rec rationale + confidence,
  medical citation footnotes, thumbs feedback, data-quality collapsible.
  This is the full advisor surface.
- **`<InsightStatusCard>` with title=generalStatus**
  (`src/components/insights/insight-status-card.tsx`): renders a single
  `text` string from `/api/insights/general-status` — a 2–3 sentence
  AI-authored paragraph that summarises the user's overall status.
  No chart, no recommendations, no citations. Pure prose.

### Are they truly duplicates?

**Substantively yes**: both speak to the user's overall AI-driven
health summary. The advisor card already opens with a classification

- chart + recommendations that subsume the general-status paragraph;
  the general-status text is the v1.4.15-era summary that the v1.4.16 D
  reconcile (CRITICAL C1) intended to _replace_ with the richer advisor
  card. Per the comment on lines 577–583 of the page:

> v1.4.16 phase D reconcile (CRITICAL C1) — pull the rich advisor
> payload (severity-ordered recommendations + rationale + confidence
>
> - medical-citation footnotes + thumbs feedback) so this page
>   surfaces the polished `<InsightAdvisorCard>` from B5c/d/e/B1b
>   instead of the v1.4.15 text-only `<InsightStatusCard>` summary.

The replacement was intended. The page kept the old surface as
"supplemental detail" (line 1012 comment: "The per-section status
cards stay below as supplemental detail"). The general-status one
is the only such card that has no metric-specific context — the other
per-section status cards (BP/weight/pulse/etc.) are kept because they
deepen one metric. The general-status card has no specific metric;
it overlaps the advisor card's role 1:1.

### Recommendation

**Remove the entire `section-general` block** (lines 1021–1042),
including the general-status query (lines 597–607) and its
contribution to `freshestUpdatedAt` (line 885). Keep the per-metric
`<InsightStatusCard>` surfaces on the sub-pages.

The translation key `insights.generalStatusTitle` is also referenced by:

- The IntersectionObserver's pill-tab map (`SECTION_LABEL_KEYS`
  line 1717 → `insights.navGeneral`). Once the tabs become routes the
  "General" pill is the mother page itself (`/insights`), so the
  `navGeneral` key stays but the section block goes away.

The API endpoint `/api/insights/general-status` becomes orphaned and
can be deleted in a follow-up clean-up phase (out of scope for the
sub-page ship; mark TODO).

---

## 7. Trends-row unification — equal-height + grid parity

### Current state

`src/components/insights/trends-row.tsx`:

- Grid: `grid grid-cols-1 gap-4 md:grid-cols-3` — three equal columns
  on md+, single column on mobile.
- Each card: `flex min-h-[300px] flex-col gap-2` — minimum height set
  via Tailwind utility (added in v1.4.22 A4, comment lines 96–102).
- Three cards: BP (`<HealthChart mini>`), Weight (`<HealthChart mini>`),
  Mood (`<MoodChart mini>`).

### Why heights differ in practice

The `min-h-[300px]` does enforce a floor, but the individual chart
heights inside each card are:

- HealthChart mini: `h-[140px]` (`health-chart.tsx` line 931).
- MoodChart mini: `h-[140px]` (`mood-chart.tsx` line 618).

These match. The difference Marc is seeing comes from:

1. **TrendAnnotation prose length**: the AI sentence below each chart
   varies. The `min-h-[300px]` papers over that when prose is short
   but does _not_ equalise when prose is multi-line because the card
   grows; the _other_ two cards stay at the floor. Grid `items-stretch`
   would equalise heights but is fighting Tailwind's `min-h` floor.
2. **Card chrome**: HealthChart wraps in a `<Card>` (line 511 in
   health-chart.tsx); MoodChart also wraps in `<Card>` (similar
   structure). The mini-mode CardHeader pb-1 vs pb-2 differ by 4 px;
   minor.

### Gridlines — does the Mood card have CartesianGrid?

**Yes, it does.** I checked: `src/components/charts/mood-chart.tsx`
line 624 renders `<CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))"
opacity={0.5} />`. The health chart at line 1090 renders the same.

The difference Marc is observing is likely the **Y-axis tick density**:
mood y-axis is `[1, 5]` with `ticks={[1, 2, 3, 4, 5]}` — five horizontal
gridlines. Health chart has auto-ticks; for BP with values in the
110–140 range Recharts typically picks ~5 ticks. Visually similar
density. But the gridlines are _only drawn at tick positions_ in
Recharts — the user is seeing the _axis ticks_ on health and _fewer
tick lines_ on mood because the moodCard mini variant gives the
y-axis `width={65}` (line 690) which can pinch the chart's plot area.
Worth re-verifying visually after the v1.4.22 polish lands.

### Recommendation

**Convert the trends-row card to a strict equal-height grid**:

```diff
- <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
+ <div className="grid grid-cols-1 gap-4 md:auto-rows-fr md:grid-cols-3 md:items-stretch">

  <div
    data-slot="trends-row-card"
    data-metric="bp"
-   className="flex min-h-[300px] flex-col gap-2"
+   className="flex h-full flex-col gap-2"
  >
```

`md:auto-rows-fr` forces all rows on the grid to share a single height
track; `md:items-stretch` makes each cell fill its track; `h-full`
on the child makes the inner flex column reach the floor. This is
the standard Tailwind recipe for "every card same height regardless of
content".

For gridline parity, the fix is simpler than it looks. The mood chart's
mini variant should set `width={45}` (matching the health-chart's auto)
on its YAxis, or render the gridlines independently of axis ticks via
`syncWithTicks={false}` on `<CartesianGrid>`. The latter is the safer
change; one line:

```diff
- <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
+ <CartesianGrid
+   strokeDasharray="3 3"
+   stroke="hsl(var(--border))"
+   opacity={0.5}
+   horizontalCoordinatesGenerator={(props) => {
+     const ticks = 5;
+     const step = props.height / ticks;
+     return Array.from({ length: ticks + 1 }, (_, i) => i * step);
+   }}
+ />
```

This evens the horizontal gridlines to a fixed 5-band density
independent of axis ticks. Mirrors how Apple Health, Oura, and Whoop
draw their compact metric cards.

### Files to touch

- `src/components/insights/trends-row.tsx` — grid + child class change.
- `src/components/charts/mood-chart.tsx` — CartesianGrid coordinate
  generator (only when `mini` is true so the non-mini view keeps
  Recharts' default tick-anchored grid).
- Tests: existing snapshots in `src/components/insights/__tests__/trends-row.test.tsx`
  - `mood-chart-polish.test.tsx` need re-snapshot or assertion update.

---

## 8. Risk register + open questions

### Risks

1. **PWA-cached insights page bundle (`sw.js`)**: the existing route
   was a single page; splitting into seven routes will produce seven
   bundle entries. Next.js handles this transparently but the
   service-worker `precache` config in
   `src/lib/pwa/service-worker.ts` (if it lists routes explicitly)
   may need an update. Worth checking in the implementation phase.
2. **`useInsightsAdvisorQuery` runs in every Insights surface** once
   it's lifted into the layout for the regenerate button. The query
   is staleTime-gated (60 s in the page today) so re-mounting on
   every route change is a no-op cache read. Verify the stale time
   when the lift happens.
3. **Mobile bottom-nav `/insights` highlight**: today
   `src/components/layout/bottom-nav.tsx` line 47 matches `href ===
"/insights"`. After the split, `/insights/blutdruck` should also
   highlight the Insights tab. The bottom-nav helper likely does
   prefix-match already; verify.
4. **Existing test `src/app/__tests__/insights-polish.test.ts`** reads
   the raw page source to assert the InsightAdvisorCard JSX block
   shape. Removing the generalStatusTitle section is fine but the
   InsightAdvisorCard regex test (line 105) will continue to match;
   removing entire sections may need a test refresh.

### Open product questions for Marc

1. **Per-metric weekly report links**: should each sub-page surface
   its own "Weekly report" CTA (filtered to that metric) or only the
   mother page? The existing `/insights/report/[week]` is whole-account.
2. **`/insights/medikamente` chart**: there are 0..N medications,
   each with its own MedicationComplianceCalendar. The sub-page
   should probably show one larger compliance overview chart plus
   the per-med list. Confirm scope.
3. **`/insights/stimmung` empty-state threshold**: today the mood
   section is hidden entirely when `data?.moodSummary?.count === 0`
   (line 798). On a dedicated sub-page, hiding the entire page is
   bad. Suggest: show "Log your first mood to see insights" CTA
   matching the Apple Health "No data" pattern.

### Out of scope for v1.4.25 (parking lot for v1.4.26+)

- Surface-independent prefs namespace (`bp:dashboard` vs `bp:insights`).
- Greyed-out comparison picker when no historical data (Garmin pattern).
- Per-metric "compare to my goal" overlay distinct from "compare to
  last year".
- Native Apple Health-style "Show All Data" table view per metric.

---

## 9. Summary of recommendations

1. **Navigation**: routed sub-pages under `src/app/insights/<slug>/`,
   the tab strip extracted into `src/components/insights/insights-tab-strip.tsx`
   driven by `usePathname()`. Coach drawer stays in
   `src/app/insights/page.tsx`, not in `layout.tsx`.
2. **Chart settings parity**: pass `chartKey` (already-valid values
   from `CHART_OVERLAY_KEYS`) to every `<HealthChart>` / `<MoodChart>`
   on the sub-pages. No backend changes; no new hooks. Extract a
   small `useInsightsLayoutPrefs()` reader to de-duplicate the
   row-level `compareBaseline` read.
3. **Comparison overlay**: existing `hasComparisonData` logic is
   correct. Add a JSDoc contract line; optionally grey the picker
   buttons when their hypothetical overlay would be empty (deferrable
   polish).
4. **Header restructure**: move the regenerate button from
   `hero-strip.tsx` into `insights-tab-strip.tsx`'s right slot,
   icon-only RefreshCw + `aria-label`, hover-color matches inactive
   tab pill. Add a success toast (existing translation key).
5. **Duplicate removal**: delete the entire `section-general` block
   from `src/app/insights/page.tsx` plus its `generalStatus` query +
   `freshestUpdatedAt` reference. Mark `/api/insights/general-status`
   endpoint for follow-up clean-up.
6. **Trends-row equalisation**: switch grid to `md:auto-rows-fr
md:items-stretch` and child to `h-full`; add a fixed
   `horizontalCoordinatesGenerator` to the mood-chart mini CartesianGrid
   for parity.

Implementation estimate: ~6–8 phase-sized work units. Largest by
LOC is the page-split (one mother page slimming + six new
~150-line sub-pages). Smallest is the duplicate removal (one
section + one query). Recommended order: navigation extraction →
sub-page scaffolding → chart-key wiring → trends-row polish →
header restructure → duplicate removal. The header restructure
should come _after_ the navigation extraction so the strip already
owns the right-slot affordance.

---

## File path index (absolute)

Investigated:

- `/Users/marc/Projects/HealthLog/src/app/insights/page.tsx`
- `/Users/marc/Projects/HealthLog/src/app/insights/report/[week]/page.tsx`
- `/Users/marc/Projects/HealthLog/src/app/page.tsx`
- `/Users/marc/Projects/HealthLog/src/components/insights/hero-strip.tsx`
- `/Users/marc/Projects/HealthLog/src/components/insights/trends-row.tsx`
- `/Users/marc/Projects/HealthLog/src/components/insights/insight-advisor-card.tsx`
- `/Users/marc/Projects/HealthLog/src/components/insights/insight-status-card.tsx`
- `/Users/marc/Projects/HealthLog/src/components/charts/health-chart.tsx`
- `/Users/marc/Projects/HealthLog/src/components/charts/mood-chart.tsx`
- `/Users/marc/Projects/HealthLog/src/components/charts/chart-overlay-controls.tsx`
- `/Users/marc/Projects/HealthLog/src/hooks/use-chart-overlay-prefs.ts`
- `/Users/marc/Projects/HealthLog/src/lib/dashboard-layout.ts`
- `/Users/marc/Projects/HealthLog/src/components/layout/bottom-nav.tsx`
- `/Users/marc/Projects/HealthLog/src/components/layout/sidebar-nav.tsx`
- `/Users/marc/Projects/HealthLog/messages/de.json`, `/Users/marc/Projects/HealthLog/messages/en.json`

Proposed new files:

- `/Users/marc/Projects/HealthLog/src/app/insights/layout.tsx`
- `/Users/marc/Projects/HealthLog/src/app/insights/blutdruck/page.tsx`
- `/Users/marc/Projects/HealthLog/src/app/insights/gewicht/page.tsx`
- `/Users/marc/Projects/HealthLog/src/app/insights/puls/page.tsx`
- `/Users/marc/Projects/HealthLog/src/app/insights/stimmung/page.tsx`
- `/Users/marc/Projects/HealthLog/src/app/insights/medikamente/page.tsx`
- `/Users/marc/Projects/HealthLog/src/app/insights/bmi/page.tsx`
- `/Users/marc/Projects/HealthLog/src/components/insights/insights-tab-strip.tsx`
- `/Users/marc/Projects/HealthLog/src/components/insights/regenerate-button.tsx`
- `/Users/marc/Projects/HealthLog/src/hooks/use-insights-layout-prefs.ts`
