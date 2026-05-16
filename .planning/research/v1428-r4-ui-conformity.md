---
file: .planning/research/v1428-r4-ui-conformity.md
purpose: R4 UI-conformity audit — same-class surface alignment after v1.4.28
created: 2026-05-16
contributor: R4 UI-conformity
---

# v1.4.28 R4 UI-conformity audit

Read-only walk of every same-class surface touched by the v1.4.28
diff. Same-class = anywhere the same UI concept appears in more than
one file. Carry-overs deferred per the fix-plan §6 are verified
intact.

Baseline: v1.4.27 R4 UI-conformity report. Diff scope: 30 commits
since v1.4.27 on `develop`.

---

## Severity legend

- **High** — same-class instances diverge enough that surfaces no
  longer read as one app; ship-blocking for v1.4.28.
- **Medium** — token / spacing / icon-vocabulary drift the user
  notices switching between two routes of the same family.
- **Low** — minor inconsistency, informational note, or carry-over
  with a documented deferral.

---

## High-severity findings

### H1 — DrugLevelChart standalone chrome diverges from MedicationDetailSection siblings

- **Surface class**: medication-detail section panel (FB-F3 / F4).
- **Drift sites**:
  - `src/components/medications/DrugLevelChart.tsx:237-239` —
    standalone wrapper class
    `bg-card border-border rounded-xl border p-4`.
  - `src/components/medications/medication-detail-section.tsx:60-79`
    — three sibling sections (SideEffectsSection, SchedulingSection,
    TitrationSection) wrap `border-border/60 rounded-md border` with
    a `px-3 py-2.5` header band and a `border-t px-3 py-3 text-xs`
    body band.
- **Symptom**: on `/medications/[id]/history` the page stacks four
  sections. DrugLevelChart carries a heavier `rounded-xl` shell
  with full-opacity border + `p-4`; the three siblings below ride
  the lighter `rounded-md` `border/60` shell with a header-rule
  divider. Commit `5109e930` aligned the heading classes but the
  wrapper chrome drifted. One heading scale, two card recipes.
- **Recommended unification**: lift DrugLevelChart's non-compact
  body inside `<MedicationDetailSection>` with the Activity glyph
  in `headerExtras`. Drop the hand-rolled `<header className="mb-3
  …">` block. The compact branch (consumed only by the retired
  GLP-1 dashboard tile, now dead per FB-A2) keeps the unwrapped
  path.
- **Scope**: in-scope for v1.4.28; ships FB-F3 / F4 to completion.

### H2 — Coach launch affordance count is four, not three

- **Surface class**: Coach launch CTA (FB-L1 + Theme M).
- **Drift sites**:
  - `src/components/insights/hero-strip.tsx:217-228` — hero band
    button: `<Button variant="outline">` (no explicit `size`, so
    default `h-10`) + `Sparkles h-3.5 w-3.5` + label
    `insights.heroActionAskCoach`.
  - `src/components/insights/coach-launch-button.tsx:56-71` —
    inline `lg+` pill: `<Button variant="outline" size="sm">`
    (`h-8`) + `Sparkles size-4` + label.
  - `src/components/insights/layout-coach-fab.tsx:32-50` — mobile
    FAB: `<Button size="lg" h-12>` with
    `from-dracula-purple to-dracula-pink bg-gradient-to-br`
    gradient + `Sparkles size-4` + label.
  - `src/components/targets/target-coach-button.tsx:64-85` —
    per-target icon: `<Button variant="ghost" size="icon">` +
    `MessageCircle size-4` + `aria-label` only (icon-only).
- **Drift**: four shapes; hero + inline both ride `variant=
  "outline"` + `Sparkles` + same label but differ on height
  (`h-10` vs `h-8`). The target-card surface uses
  `MessageCircle` instead of `Sparkles`, breaking icon
  vocabulary. Fix-plan target was three shapes; live count is
  four.
- **Recommended unification**: (1) collapse the hero-strip
  button to mount `<CoachLaunchButton>` so hero + inline share
  one size+variant+glyph recipe; (2) swap `MessageCircle` →
  `Sparkles` on the target-card icon button so Coach-launch
  glyph is one across the app. Keep `size="icon"` per FB-L1.
- **Scope**: in-scope for v1.4.28; icon swap + 10-line edit.

### H3 — Insights/medikamente per-medication card is the medication-list row outlier

- **Surface class**: medication-list row (FB-G1).
- **Drift sites**:
  - `src/components/medications/MedicationCardHeader.tsx:37-64` —
    canonical row: `<CardTitle text-lg>` with
    `{name} {dose}` on line 1 + outline badge for `categoryLabel`
    on line 2 + optional state badges + `actions` slot. Used by
    both `<MedicationCard>` and `<Glp1MedicationCard>` on
    `/medications` (commit `6f6992c6`).
  - `src/app/insights/medikamente/page.tsx:159-181` — per-medication
    card on `/insights/medikamente`: `<CardHeader pb-2>` carrying
    `<Pill text-dracula-orange h-4 w-4>` + `<CardTitle truncate
    text-sm font-medium>` (line 1) + streak badge (right) + dose
    on line 2 via a separate `<p text-muted-foreground text-xs>`.
- **Symptom**: `/medications` row reads bold `text-lg` name+dose
  + class outline badge, no glyph (FB-G1 canonical). Same med on
  `/insights/medikamente` reads `text-sm font-medium` title +
  Pill glyph + streak badge + dose on a separate muted line.
- **Recommended unification**: route insights/medikamente cards
  through `<MedicationCardHeader>` with streak passed via
  `stateBadges`. Drop the Pill glyph per FB-G1 icon-free
  convention.
- **Scope**: in-scope for v1.4.28; closes FB-G1 across all
  same-class surfaces.

---

## Medium-severity findings

### M1 — TrendCard / HealthChart mini / MoodChart mini paint three trend-tile shells

- **Surface class**: trend tile chrome (FB-K).
- **Drift sites**:
  - `src/components/charts/trend-card.tsx:199` — dashboard tile:
    `bg-card border-border rounded-xl border p-4 md:p-6`.
  - `src/components/charts/health-chart.tsx:1078-1080` — `mini`
    branch (BP + weight tiles on `/insights` trends row):
    `bg-card border-border rounded-md border p-2`.
  - `src/components/charts/mood-chart.tsx:530-544` — `mini`
    branch (mood tile on `/insights` trends row): shadcn
    `<Card className="gap-1 py-2 shadow-none">` with
    `CardHeader className="px-2 pb-1 [&]:gap-0.5"`. Card base
    is `rounded-xl`; mini override does not flatten the radius
    to `rounded-md`.
- **Drift**: equal-height contract landed in `trends-row.tsx`
  so the chart body anchors line up. But the inner shells
  diverge — BP and weight ride `rounded-md`; mood rides
  `rounded-xl` (Card default). Two shapes inside one row.
- **Recommended unification**: align radius + chrome to one
  recipe. Either bring MoodChart mini onto the `<div bg-card
  rounded-md border p-2>` shell HealthChart uses, or migrate
  HealthChart's mini onto MoodChart's `<Card gap-1 py-2 shadow-
  none>` recipe.
- **Scope**: in-scope for v1.4.28; FB-K1/K2 alignment.

### M2 — Hero-strip h1 still on `font-bold` while everything else collapsed to `font-semibold`

- **Surface class**: medications-detail page hero heading
  (FB-F3 / F4 — "one heading scale").
- **Drift site**:
  - `src/app/medications/[id]/history/page.tsx:74` — page hero
    `<h1 className="text-2xl font-bold tracking-tight">`.
  - Every other heading on the page (the four section `<h2>`s)
    paint `text-base font-semibold leading-6 tracking-tight`.
- **Drift**: the `font-bold` → `font-semibold` collapse (commit
  `bfb13351`) cleared the dashboard tile. The medications-detail
  hero is the only `font-bold` heading still shipping on a
  FB-F surface. Two different weights on one page.
- **Recommended unification**: drop `font-bold` →
  `font-semibold` on the hero `<h1>`. Single-line edit.
- **Scope**: in-scope for v1.4.28; closes FB-F4 "one scale".

### M3 — Sleep sub-page still omits `<InsightStatusCard>`

- **Surface class**: insights sub-page status slot.
- **Drift site**:
  - `src/app/insights/schlaf/page.tsx:65-75` — comment block
    documents the omission (no `/api/insights/sleep-status` route
    yet; assessment-generation deferred to v1.5 iOS sprint).
  - Every other sub-page (blutdruck, bmi, gewicht, medikamente,
    puls, stimmung) mounts `<InsightStatusCard>` under the
    chart.
- **Drift**: same call-out as v1.4.27 R4. Commit `8f7cbd49`
  documented the omission; the slot itself did not ship. Six
  sub-pages render the assessment band; one does not.
- **Recommended unification**: render a structural empty
  `<InsightStatusCard>` with `text={null}` + `hasProvider=false`.
  Body text comes online with the v1.5 route; the slot anchor
  ships now.
- **Scope**: in-scope for v1.4.28 if row anchor matters; defer
  to v1.5 if the maintainer accepts the documented exception.

### M4 — Hero-strip "Coach fragen" + sub-page inline button differ on `size`

- **Surface class**: Coach-launch inline pill (component of H2,
  separated because the fix is a one-line size swap).
- **Drift sites**:
  - `src/components/insights/hero-strip.tsx:217-228` — no
    `size` prop → defaults to `h-10`.
  - `src/components/insights/coach-launch-button.tsx:60` —
    explicit `size="sm"` → `h-8`.
- **Drift**: same variant (`outline`), same glyph (`Sparkles`),
  same label, two heights. The pill on `/insights` mother page
  reads taller than the pill on `/insights/blutdruck`.
- **Recommended unification**: pick one size (recommend `size=
  "sm"` so both pills match the existing inline-button density).
- **Scope**: in-scope for v1.4.28, captured under H2.

### M5 — HealthScore card "meta-label" typography stays a one-off

- **Surface class**: dashboard / hero meta-label uppercase
  recipe.
- **Drift sites**:
  - `src/components/insights/health-score-card.tsx:259` — label
    `text-muted-foreground text-[10px] font-semibold tracking-
    [0.18em] uppercase`.
  - `src/components/charts/trend-card.tsx:208` — label
    `text-muted-foreground text-xs leading-5 font-medium
    tracking-wide whitespace-nowrap uppercase`.
- **Drift**: two recipes for the same role. v1.4.27 flagged
  three; v1.4.28 retired Daily Briefing's recipe by retiring
  the surface. Two recipes left.
- **Recommended unification**: follow-up `<TileLabel>`
  primitive next release. Visual gap is small.
- **Scope**: defer to v1.4.29.

---

## Low-severity findings (carry-overs verified intact)

### L1 — Admin section chrome divergence (11 surfaces) — deferred

- 11 admin sections still render the card title as
  `<div className="text-lg font-semibold">` (no heading
  element): `general-settings:31`, `backups:348`,
  `ai-quality:104`, `ai-quality:120`, `login-overview:204`,
  `coach-feedback:84`, `system-status:76`, `services:16`,
  `reminders:115`, `user-management:246`,
  `api-token-overview:162` (all in
  `src/components/admin/*-section.tsx`).
- No regression vs. v1.4.27; deferred per fix-plan §6.

### L2 — `<SectionCard>` carve-out (29 hand-rolls) — deferred

- 29 hand-rolled `<div className="bg-card border-border
  rounded-xl border p-6">` across settings (16) + admin (13).
  v1.4.27 baseline counted 21; +8 from feature additions in
  `account-section.tsx` and `notification-status-card.tsx`.
- Shape is stable; only count grew. Carve-out deferred per
  fix-plan §6.

### L3 — Loader2 spinner vocabulary (26 signatures) — deferred

- 26 distinct `Loader2` className signatures across the
  codebase (v1.4.27 baseline 18). `motion-reduce:animate-none`
  in 18 of 26; missing in 8. New mounts in `daily-briefing`,
  notifications card, Coach drawer — same shapes, more sites.
- `<Spinner>` primitive carve-out deferred per fix-plan §6.

### L4 — Two tab-strip implementations — deferred

- `src/components/insights/insights-tab-strip.tsx:136-238` —
  custom `<nav>` rounded-full pills + sticky + fade + `h-11
  w-11` regen button.
- `src/components/admin/feedback-inbox-section.tsx:89-91` —
  shadcn `<Tabs>` + `<TabsList>` (`h-9`).
- Per fix-plan §2.4 only InsightsTabStrip stays untouched.
  No regression. Convergence defers to v1.4.29.

### L5 — EmptyState `ctaSize="lg"` adoption landed

- v1.4.27 had zero consumers. v1.4.28 adopts via
  `src/components/insights/metric-empty-state.tsx:67` —
  consumed by all seven insights sub-pages. Inner button
  `size="sm"` is lifted by the wrapper's
  `[&>button]:min-h-11` selector on `<sm`. Admin / settings
  empty states stay on default (acceptable; insights is the
  primary onboarding surface). No action required.

### L6 — Coach drawer mobile height converged

- `src/components/insights/coach-panel/coach-drawer.tsx:299`
  now paints `h-[90dvh] max-h-[90dvh]` matching
  `src/components/ui/responsive-sheet.tsx:109`. Drift retired
  (commit `ca381957`).

### L7 — TrendCard headline weight aligned

- `src/components/charts/trend-card.tsx:229` now paints
  `font-semibold tracking-tight`. Drift retired (commit
  `bfb13351`).

---

## Per-surface drift table

| Surface class | v1.4.27 drifts | v1.4.28 drifts | Net |
|---|---|---|---|
| Medication-list row (FB-G1) | 1 (Mounjaro vs Ramipril) | 1 (insights/medikamente outlier — H3) | step forward then a new outlier surface surfaced |
| Medication-detail section header (FB-F3/F4) | several heading-scale drifts | 1 (DrugLevelChart chrome — H1) | heading scale unified; wrapper chrome drift remains |
| Trend tile chrome (FB-K) | row baseline mismatch (mood taller) | 1 (mood `rounded-xl` vs BP/weight `rounded-md` — M1) | row anchors aligned; inner shell radius drifts |
| HealthScore card column (FB-H) | card shorter than action column | 0 | drift retired via `h-full flex flex-col` |
| Coach-launch affordance (FB-L1 + Theme M) | 5 shapes | 4 shapes (H2 + M4) | one shape retired, one new (target icon), still above target of 3 |
| Admin section chrome (deferred) | 11 surfaces | 11 surfaces | deferral intact |
| `<SectionCard>` carve-out (deferred) | 21 hand-rolls | 29 hand-rolls | deferral intact; volume grew |
| Loader2 spinner vocabulary (deferred) | 18 signatures | 26 signatures | deferral intact; volume grew |
| Tab-strip implementations (deferred) | 2 strips | 2 strips | deferral intact |
| EmptyState `ctaSize="lg"` (deferred) | 0 consumers | 7 consumers (via primitive) | adoption landed via `<MetricEmptyState>` |
| Coach drawer mobile height (drift) | `95dvh` outlier | aligned to `90dvh` | retired |
| TrendCard headline weight (drift) | `font-bold` outlier | aligned to `font-semibold` | retired |
| Insights sub-page status slot (drift) | sleep omits | sleep still omits (documented) | carry-over, documented |
| Medications hero `<h1>` weight | n/a | 1 (`font-bold` outlier — M2) | new finding |

---

## Summary

v1.4.28 lands the targeted same-class fixes: BD-Zielbereich tile now
rides `<TrendCard>` against the sibling-prop contract, the
medication-list row collapsed to one shape via
`<MedicationCardHeader>`, the medications-detail page collapsed to
one heading scale via `<MedicationDetailSection>`, the HealthScore
card stretches to the hero column height (`h-full flex flex-col`),
the trends row paints all three slots on the same vertical anchor,
the Coach drawer mobile height converged to the `<ResponsiveSheet>`
`90dvh` cap, the TrendCard `font-bold` outlier retired, and the
EmptyState `ctaSize="lg"` prop finally has consumers (via the new
`<MetricEmptyState>` primitive shared across the seven insights
sub-pages).

Three High findings remain on touched surfaces:

1. **H1** — DrugLevelChart paints a different chrome from the
   three sibling sections on `/medications/[id]/history`. Heading
   scale is unified; wrapper chrome (`rounded-xl + p-4` vs
   `border/60 rounded-md + py-2.5/py-3`) is not.
2. **H2** — Coach-launch affordance count is four, not three:
   hero-strip button, inline sub-page pill, mobile FAB, and the
   target-card icon. Two of the four (hero + inline) ride the
   same variant + glyph + label but differ on size; the target
   icon uses a different glyph (`MessageCircle` vs `Sparkles`).
3. **H3** — `/insights/medikamente` paints a per-medication card
   with `<CardTitle text-sm>` + Pill glyph + dose-on-line-2 +
   streak badge, divergent from the canonical
   `<MedicationCardHeader>` two-line `text-lg name+dose` shape
   that v1.4.28 established on `/medications`.

Three Medium findings round out the scope: trend-tile inner shell
radius (M1), medications hero `<h1>` weight (M2), sleep sub-page
status slot (M3); a fourth (M4) is captured under H2.

Deferred carry-overs (admin chrome 11 sites, `<SectionCard>` 29
hand-rolls, Loader2 vocabulary 26 signatures, tab-strip duality 2
shapes) verified intact — no regression.

**Go / no-go for v1.4.28**: GO with the three High findings
applied as small follow-up commits inside the release window. H1
(DrugLevelChart chrome) is a 30-line refactor against the existing
`<MedicationDetailSection>` primitive. H2 (Coach icon + size
unification) is a glyph swap plus a single `size` prop edit. H3
(insights/medikamente row) is a 20-line edit threading
`<MedicationCardHeader>` through the existing CardHeader band. All
three close v1.4.28 promises and stay inside the maintainer's
"less scope, more depth" directive. Medium findings are
in-release-window candidates; Low findings hold for v1.4.29.

Drift-class counts (touched surfaces only):
- High: 3 (DrugLevelChart chrome / Coach affordance count /
  insights medikamente row).
- Medium: 4 (trends-row mood radius / medications hero h1 weight /
  sleep status slot / Coach pill size split — last is sub-finding
  of H2).
- Low / carry-over: 7 (four deferred classes intact + three
  v1.4.27 drifts retired).

Worst-aligned surface: **Coach-launch affordance**. Four shapes
across four files for the same user-facing concept (open Coach
with optional prefill). The fix-plan called for three; the
underlying split-glyph-vocabulary (Sparkles vs MessageCircle)
makes the surface read as two different features rather than one
affordance with placement variants.

**Release recommendation**: GO once H1 + H2 + H3 are applied;
defer Medium M3 (sleep status slot structural mount) only if the
maintainer accepts the documented exception.
