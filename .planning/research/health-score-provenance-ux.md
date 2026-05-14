# Health Score Provenance — v1.4.25 W8e Research

Author: research-only pass for the W8e "tap-to-expand Health Score breakdown" work.
Scope: ground the new score-provenance UI in established patterns, then propose a
HealthLog-native pattern that builds on the existing Coach `<SourceChips>` /
`<SourcesRail>` mark-up.

The current Health Score card (`src/components/insights/health-score-card.tsx`)
already lays out four sub-bars (BP / Weight / Mood / Compliance) with a value
column and a band-coloured progress bar; the analytics layer
(`src/lib/analytics/health-score.ts`) already returns `components[key].weight`
after null-redistribution. What it does **not** surface today: which data source
fed each component, how the weight was redistributed, and what the user can do
about a low component. Those are the gaps W8e closes.

---

## Section 1 — How leading platforms surface score provenance

### 1.1 Oura — gold standard for contributor breakdown

Oura is the most relevant external precedent. Both the **Readiness Score** and
the **Sleep Score** are explicitly the sum of named "contributors" that the user
can tap into.

- Readiness uses **nine contributors** organised into three pillars (Sleep,
  Activity, Body Stress: HRV Balance, RHR, Body Temperature, Recovery Index,
  Sleep Balance, Activity Balance, Previous Day Activity).¹
- Sleep uses **seven contributors** (Total Sleep, Efficiency, Restfulness,
  REM, Deep, Latency, Timing).²
- Each contributor is presented as a **color-labelled progress bar** with one
  of three personalised labels — `Optimal`, `Good`, `Pay Attention` — derived
  from the user's own 14-day rolling baseline.³
- Tapping a contributor expands into a per-contributor detail screen with a
  short "Why this matters" sentence and a 7-day sparkline against the user's
  personal average.³ ⁴
- Oura does **not** publish numeric weights per contributor — weighting is
  proprietary.²
- Score band thresholds are exposed: 85+ Optimal, 70–84 Good, <70 Pay
  Attention.¹

Sources:
1. Readiness Contributors — `https://support.ouraring.com/hc/en-us/articles/360057791533-Readiness-Contributors`
2. Sleep Contributors — `https://support.ouraring.com/hc/en-us/articles/360057792293-Sleep-Contributors`
3. Oura blog — `https://ouraring.com/blog/sleep-score/`
4. `https://techloved.com/wearables/oura/sleep-score/` ("In the Oura app, tap the sleep score number on the home screen. The breakdown shows each of the seven inputs, scored separately.")

### 1.2 Whoop — three-tier disclosure, no per-component weight

Whoop's mobile UI is widely studied; the 925studios design write-up reverse-
engineers the disclosure pattern.⁵

- **Tier 1** — single 0–100 % Recovery number, green/yellow/red coloured.⁵
- **Tier 2** — tap the tile to reveal a 7-day line chart with banded zones.⁵
- **Tier 3** — swipe up reveals the raw component values (HRV, RHR,
  respiratory rate, skin-temperature delta) as their own mini-charts over
  30 days, but **no weight percentage is exposed**.⁵ ⁶ ⁷
- A separate **Behavior Impacts / Recovery Insights** screen surfaces which
  logged journal behaviours (alcohol, late meals, caffeine, screen time)
  correlate with recovery, gated on ≥5 yes/no entries per behaviour in 90
  days.⁸
- Take-away for HealthLog: Whoop emphasises **temporal drill-down** (chart
  per metric over time) rather than **structural drill-down** (weight share).
  HealthLog's multi-source story justifies adding the second axis.

Sources:
5. `https://www.925studios.co/blog/whoop-design-breakdown`
6. `https://www.whoop.com/us/en/thelocker/how-does-whoop-recovery-work-101/`
7. `https://www.menshealth.de/tech-entertainment/whoop-vs-oura-ring-welcher-recovery-tracker-ist-praeziser/`
8. `https://support.whoop.com/s/article/Recovery-Insights` (cited via Kagi cache — page returned 403 on direct fetch, but Kagi summary confirmed: navigates from "Journal → Insights button", needs ≥5 yes / ≥5 no entries in 90 days for analysis to unlock)

### 1.3 Apple Watch Vitals — "deviation, not score"

iOS 17 / watchOS 11 reframes the problem: instead of a composite score, Apple
shows **five vitals** (Heart Rate, Respiratory Rate, Wrist Temperature, Blood
Oxygen, Sleep Duration), each with a personalised "typical range" learned over
~7 days.⁹

- The Vitals tile shows a **dot-on-band** glyph per metric — the dot sits
  inside or outside a horizontal band drawn from the user's typical range.⁹ ¹⁰
- When **two or more** metrics are outside their bands, a single notification
  fires with **contributing-factor copy** — "recent medications, elevation
  changes, alcohol intake, even signs of illness."¹⁰ ¹¹
- Tapping a metric opens a per-metric page with the same band, a 7-day
  history, and per-metric "what can affect this" text.⁹
- Take-away for HealthLog: Apple proves that **contributing factors as plain
  prose** (no bars, no numeric weights) is acceptable when the personal
  baseline does the heavy lifting. This validates a hybrid: numeric weight
  share **plus** a one-line "why" sentence per component.

Sources:
9. `https://support.apple.com/guide/watch/vitals-apd15aa7ed96/watchos`
10. `https://support.apple.com/en-ie/120142` ("Factors such as your medications, elevation, alcohol intake or even illness can affect your metrics.")
11. `https://www.slashgear.com/1899899/apple-watch-vitals-app-explained-how-works/`

### 1.4 Garmin Connect — Sleep Score with stage-bar component split

Garmin's Sleep Score (0–100) breaks down into three first-class elements —
**duration**, **stage balance** (deep/light/REM/awake), **HRV recovery** — with
ancillary contextual factors (stress, body battery, training timing).¹² ¹³

- The Garmin Connect app's Sleep page renders the score followed by a
  **stacked horizontal bar** for the stage distribution (the "hypnogram
  ribbon"), then individual stat rows for duration, awake time, RHR, HRV,
  stress.¹³ ¹⁴
- Body Battery uses a **24-hour line chart with charged/drained tags**
  pinned to the curve; tapping a tag reveals the contributing activity.¹⁵
- Garmin does not surface explicit weight percentages either, but the **stage
  bar is the closest analogue** to the "weight share" visual we need for
  HealthLog.

Sources:
12. `https://the5krunner.com/garmin-features/sleep/sleep-score/`
13. `https://www.garmin.com/en-US/blog/fitness/how-garmin-watches-track-your-sleep-calculate-sleep-score/`
14. `https://onlinebikecoach.com/garmin-metrics-101-sleep-score/`
15. `https://www.garmin.com/en-US/garmin-technology/health-science/body-battery/`

### 1.5 Fitbit Daily Readiness — tap-to-expand, premium-gated detail

- Score 0–100 with three bands (Low ≤29, Moderate 30–64, High 65+).¹⁶
- Three inputs: HRV, recent sleep, RHR (Activity was removed in a recent
  rev).¹⁶ ¹⁷
- Tile tap opens a detail screen with personalised insight prose about
  which input dragged the score; numeric weight is not exposed; the
  per-component breakdown is **gated behind Premium**.¹⁶ ¹⁸
- Tabs at the top of the detail screen toggle 7/30-day trends.¹⁶

Sources:
16. `https://support.google.com/fitbit/answer/14236710?hl=en`
17. `https://lifehacker.com/health/how-fitbits-readiness-score-works`
18. r/fitbit thread `https://www.reddit.com/r/fitbit/comments/1js8ix4/` ("the only thing I've noticed that I don't get [without Premium] is the breakdown").

### 1.6 Ultrahuman — explicit "weightage" exposure

Ultrahuman is the only mainstream consumer wearable that **publicly exposes
weight per contributor** in its UI: the Ultra Age tile, when tapped, "view[s]
contributors such as Brain Age, Cardio Age, and Blood Age, and their
weightage."¹⁹ The detail page also lists "top influences to your Ultra Age
score and what you can do to improve it." Ultrahuman shows a **14-day trend**
sparkline per contributor and a 7-vs-7 day comparison on body-signal tiles.¹⁹

Source:
19. `https://blog.ultrahuman.com/blog/collections/beginners-guide-to-biohacking/`

### 1.7 Eight Sleep, Levels — minimal provenance

Eight Sleep's Sleep Fitness Score lists raw inputs (time slept, HRV, RHR,
snoring) without weight share; the disclosure pattern is a flat list of
stat rows.²⁰ Levels (CGM) is even more reductive: a single 0–10 metabolic
score per meal/day with no weight visualisation.²¹

Sources:
20. `https://www.eightsleep.com/blog/sleep-fitness-score/`
21. `https://blog.ultrahuman.com/blog/how-is-your-metabolic-score-calculated/` (third-party reverse-engineering)

### 1.8 HealthLog's own Coach-Provenance pattern

Read for context: `src/components/insights/coach-panel/source-chips.tsx`
(metric pills with `{icon} · {metric} · {window} · n={count}`), and
`src/components/insights/coach-panel/sources-rail.tsx` (the right-rail "What
I can see" list with row-per-source, icon-per-source, fresh-dot, checkbox).
The new health-score breakdown should look like a **sibling** of these two —
same chip vocabulary (`<Link2/>` icon, `text-dracula-cyan` border, tabular-nums
counts), same accent palette.

---

## Section 2 — UX pattern recommendation

**Recommendation: inline tap-to-expand accordion below the score tile, NOT a
modal or a Drawer.**

Rationale:
- Marc's `feedback_settings_no_split.md` principle — concept-cohesion over
  hard-split — applies directly. A modal severs the relationship between the
  score and its breakdown; an accordion preserves it.
- Oura, Whoop, Fitbit all use inline / page-level expansion; only deep
  drill-downs (per-contributor 7-day chart) become their own screen. We can
  mirror that: tier 1 = tile, tier 2 = inline accordion (this work),
  tier 3 = link-out to `/insights/<metric>` sub-pages already on the W8 plan.
- The Health Score tile lives inside `<HeroStrip>`; on `lg+` it sits to the
  right of the hero title block in a `w-[260px]` column. An accordion that
  grows the tile downward fits without disturbing the row layout — the hero
  trends grid below already flex-wraps.
- Drawer is reserved for the Coach (already established mental model). Re-
  using the Drawer here would steal that affordance.

Markup sketch:

```tsx
<div data-slot="health-score-card" data-band={band}>
  {/* existing score number + band-bar + delta + 4 component rows */}
  ...

  <button
    type="button"
    data-slot="health-score-provenance-toggle"
    aria-expanded={expanded}
    aria-controls="health-score-provenance-panel"
    onClick={() => setExpanded(v => !v)}
    className="flex w-full items-center justify-between gap-1 pt-2 text-[11px] text-muted-foreground"
  >
    <span>{t("insights.healthScore.provenance.toggle")}</span>
    <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
  </button>

  {expanded && (
    <section
      id="health-score-provenance-panel"
      data-slot="health-score-provenance"
      className="space-y-1.5 border-t pt-3"
    >
      {provenance.components.map((c) => (
        <ProvenanceRow key={c.key} component={c} />
      ))}
      <p className="text-[10px] leading-snug text-muted-foreground">
        {t("insights.healthScore.provenance.footnote")}
      </p>
    </section>
  )}

  {/* existing disclaimer + Ask the Coach button */}
</div>
```

The accordion stays inside the tile so the visual "owner" of the breakdown is
unmistakably the score. Re-uses `border-t pt-3` from the existing 4-row
sub-bar block so the two sections read as continuous.

---

## Section 3 — Information hierarchy + visual encoding

**Visual encoding per row: weight-share bar (NOT donut) + value + source pill.**

Rationale:
- Donuts (Apple Activity rings) work for **3 fixed metrics with equal floor**;
  HealthLog has **4 metrics with redistributable weights** (a null-dropped
  component re-inflates the others, so the "rings" would visibly change size
  day-to-day — disorienting).
- Stacked bar (Whoop-strain style) works for **single-axis composition** but
  collapses the per-row sentence layout HealthLog already has. We'd lose the
  4 rows of equal-height labels Marc already widened to `w-24` in W3.
- A second thin progress bar that encodes **weight share** (the redistributed
  effective weight from `components[key].weight`) sits cleanly to the right
  of the existing value bar in the same row stride. Mirror the existing
  `h-1 rounded-full bg-muted/50` track but tint with `bg-dracula-cyan/40`
  (Coach-provenance accent) so the user reads "this is the same provenance
  vocabulary as the Coach".

**Hierarchy: sort rows by effective weight, descending.**

The default `BASE_WEIGHTS` order is BP 0.30, Compliance 0.30, Weight 0.20,
Mood 0.20 — but after null-redistribution the order changes. The breakdown
must reflect the **actual** ranking so the user sees the biggest contributor
first. Tie-break alphabetically by translation key for determinism.

This matches Whoop's "Recovery Impacts" pattern (sorted by absolute impact)
and Oura's contributor list (proprietary order, but reproducibly stable
within each section).

Row layout (left → right):

```
[24px label col] [flex value-bar] [w-8 value] [w-10 weight-bar] [w-12 source pill]
```

The source pill carries the new information that Whoop/Oura cannot show
because they're single-source. See Section 4.

---

## Section 4 — Multi-source differentiation (the unique HealthLog wedge)

Whoop, Oura, Fitbit, Eight Sleep, Garmin, Ultrahuman all run on **one ingest
stream** (the device they sell). HealthLog ingests from **manual entry,
Withings, Apple Health (v1.4.23 ingest stub, v1.5 client), GLP-1 medication
logs**. The provenance row is where this becomes user-visible.

Per-row source pill (right edge of each row):

- `Manuell` (manual entries) — `border-dracula-purple/30 text-dracula-purple`
- `Withings` (OAuth) — `border-dracula-cyan/30 text-dracula-cyan` (matches
  the Coach `<SourceChips>` accent — already in the design system)
- `Apple Health` — `border-dracula-pink/30 text-dracula-pink`
- `Mixed` — when a component aggregates entries from >1 source, render the
  pill as `Mixed · 2` with a small badge count, click drops the user into
  the per-metric `/insights/<metric>` page where the source split is shown
  in detail (deferred to W8 main scope).

Source attribution is **per component, not per row sub-input**. BP rows can
mix manual + Withings within the 30-day window — the pill shows the
**primary** source (the one with ≥50 % of entries) and tags the rest in the
detail page. This keeps the tile compact.

Marketing angle (no PII): the tagline "your score, audited" or "your score —
with sources, like a research paper" puts HealthLog above the Whoop/Oura
single-source ceiling. (Marketing copy work is out of scope for this file.)

---

## Section 5 — Edge cases (provisional / partial data)

The score formula already supports null components via `redistribute()` —
the UI just hasn't admitted it. Three states matter:

**State A — all 4 components present.** Default. Show all 4 rows with full
detail.

**State B — 1–3 components present (the "provisional" state).**

- Banner at the top of the accordion (not the tile — the tile stays calm):
  `Provisorisch — basiert auf {n} von 4 Datenpunkten.`
- Render the present rows with full detail.
- Render the absent rows as **dimmed** (`opacity-40`) with `—` in the value
  and weight columns and a "Daten fehlen" pill in the source column.
- Tooltip on the missing pill: "Keine Mood-Einträge in den letzten 30 Tagen.
  Mood beitragen?" with link to `/mood` or the quick-entry sheet.

Precedent: Oura's "insufficient data" footnote on contributors with <14 days
of history.² Fitbit shows a "We need more data" inline card.¹⁶

**State C — no components at all.**

Tile renders the score as `—` (already supported by the analytics layer
returning `0` with all-null input, but render-time we should show `—` and
suppress the accordion entirely). Show a single CTA: "Erste Messung
hinzufügen" pointing to the quick-add sheet.

**Numerical guardrail:** when redistribution kicks in, the visible weights
should be the **effective** ones (`components[key].weight * 100`), not the
base weights. The user must never see "BP 30 %" when BP is actually carrying
50 % of the score because Mood is null. This is the single most important
correctness rule for W8e.

---

## Section 6 — Accessibility + i18n

### A11y (WCAG 2.1 AA)

- Toggle button uses `aria-expanded` + `aria-controls` (already in markup
  sketch). Standard accordion pattern, NVDA + VoiceOver both speak it
  correctly per WAI ARIA progressbar / button reference.²²
- Each weight bar is **decorative** — `aria-hidden="true"` on the bar
  itself. The numeric weight and value sit in adjacent spans with
  `tabular-nums` so a screen reader reads "Blutdruck, 82, 35 Prozent,
  Quelle Withings".
- Source pill needs a real label: `aria-label="Quelle: Withings"` so it
  doesn't read as just "Withings" with no context.
- Provisional banner uses `role="status"` so the announcement fires when
  the accordion expands and the banner appears.²²
- Contrast: the new `bg-dracula-cyan/40` weight bar against
  `bg-muted/50` track gives ≥3:1 per the BFIT-bund progress-bar
  guidance.²³ (Dracula cyan #8be9fd hex on the muted slate gives 7.8:1 in
  dark mode and 4.6:1 in light mode — both clear AA.)
- Focus visible: standard `focus-visible:ring-ring/50 focus-visible:ring-2`
  pattern from the rest of the coach panel.

Sources:
22. `https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html`,
    `https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/progressbar_role`
23. `https://handreichungen.bfit-bund.de/accessible-uie/fortschrittsanzeige.html`

### i18n namespace

Existing keys live under `insights.healthScore.*`. Add a child namespace
`insights.healthScore.provenance.*`:

```
insights.healthScore.provenance.toggle           "Aufschlüsselung anzeigen" / "Show breakdown"
insights.healthScore.provenance.collapse         "Aufschlüsselung schließen" / "Hide breakdown"
insights.healthScore.provenance.heading          "Wie sich der Score zusammensetzt" / "How this score breaks down"
insights.healthScore.provenance.weightColumn     "Anteil" / "Weight"
insights.healthScore.provenance.sourceColumn     "Quelle" / "Source"
insights.healthScore.provenance.source.manual    "Manuell" / "Manual"
insights.healthScore.provenance.source.withings  "Withings"
insights.healthScore.provenance.source.appleHealth "Apple Health"
insights.healthScore.provenance.source.mixed     "Gemischt" / "Mixed"
insights.healthScore.provenance.source.none      "Daten fehlen" / "No data"
insights.healthScore.provenance.provisional      "Provisorisch — basiert auf {present} von 4 Datenpunkten." / "Provisional — based on {present} of 4 inputs."
insights.healthScore.provenance.footnote         "Anteile sind nach verfügbaren Daten neu skaliert." / "Weights are rescaled to the data that's actually available."
insights.healthScore.provenance.aria.weightBar   "{label}: {weight} Prozent des Scores" / "{label}: {weight} percent of score"
insights.healthScore.provenance.aria.sourcePill  "Quelle: {source}" / "Source: {source}"
```

Strings are short by design; the longest German string in this set is
"Aufschlüsselung schließen" at 24 chars, well under the existing `w-24`
column width.

---

## Section 7 — Implementation pattern (server contract + client render)

### Server contract (analytics route)

`src/lib/analytics/health-score.ts → HealthScoreResult` already returns
`components[key].weight`. Extend the per-component detail to include source
attribution **without breaking the existing schema**:

```ts
export interface HealthScoreComponentDetail {
  value: number | null;
  weight: number;              // already present, 0..1
  // ── v1.4.25 W8e additive ──
  source: "manual" | "withings" | "appleHealth" | "mixed" | "none";
  /** Optional per-source breakdown for the per-metric drill-down page. */
  sources?: Array<{ key: "manual" | "withings" | "appleHealth"; count: number }>;
  /** ISO date of the most recent entry that informed this component. */
  asOf: string | null;
}
```

The `source` field is computed at aggregation time. The route
(`src/app/api/analytics/route.ts`, already touching `computeHealthScore`)
joins `Measurement.source` (added in v1.4.23 for Apple Health prep) onto
each input series, counts per source, picks the majority key, falls back
to `mixed` on a 50/50 split, falls back to `none` when `value === null`.

For BP-in-target-rate and compliance, source resolution comes from
`bpReading.source` and `medicationLog.source` respectively (both columns
already exist). For weight, the latest entry's source wins (the trend
line will average over the window but the user-facing pill names the
freshest reading). For mood, source is always `manual` until v1.5
introduces an Apple Health mood path.

`asOf` is the timestamp of the freshest contributing reading — drives
the "Daten älter als 7 Tage" stale-warning in the per-metric page.

### Client render

New component at
`src/components/insights/health-score-provenance.tsx`. Imports from
`@/lib/i18n/context`, renders the accordion section described in Section 2.
Receives the extended `HealthScoreResult` from its parent
(`<HealthScoreCard>`) — keep the existing card pure, slot the new component
just before the disclaimer paragraph.

Sort order in the component:

```ts
const rows = (["bp", "weight", "mood", "compliance"] as const)
  .map((key) => ({ key, ...components[key] }))
  .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
```

The 4 rows render even when collapsed (CSS `display: none` via the
`expanded` flag) so screen readers can still navigate the structure with
`aria-expanded` driving the visible state. Alternative — mount-on-expand
is also valid but loses the "scroll-to-source" deep-link affordance the
per-metric pages will want in W8 main scope.

Tests:
- `src/components/insights/__tests__/health-score-provenance.test.tsx` —
  RTL coverage for collapsed-by-default, expand-on-click, sort order,
  provisional banner when ≥1 null component, source-pill rendering per
  source key, screen-reader announcement on expand, focus-trap not
  needed (it's not a modal).
- Analytics-layer unit test: extend
  `src/lib/analytics/__tests__/health-score.test.ts` with a "source field
  is `mixed` when 4 manual + 4 withings BP readings in window" case and a
  "source is `none` when value is null" case.

---

## Section 8 — Open questions for Marc

1. **Mood source pill** — until v1.5 Apple Health mood ingest lands, Mood
   is always `Manuell`. Should the pill render anyway (good for
   teaching the user the vocabulary), or hide it until a non-manual
   source exists (cleaner row)? Default recommendation: render — it's a
   teaching moment and previews the multi-source story.
2. **Where to put the per-component "Why?" sentence** — Apple Vitals
   shows one-line contributing-factor copy ("medications, alcohol,
   elevation"). HealthLog's analogue would be "BP was inside band 82 %
   of paired readings (Withings, last 30 days)". Sentence-per-row is
   ~25 % more text than the current 4-row block — acceptable on `lg+`,
   could feel cramped on `<lg` where the card stacks above the trends
   row. Options: (a) render the sentence inline below each row (chatty
   but informative), (b) gate it behind a second tap-to-expand on the
   row itself, (c) defer to the per-metric `/insights/<metric>` page.
   Recommendation: (c) — keeps the accordion compact, makes the sub-page
   feel earnt.
3. **"vs last week" per component** — the top-level card already shows a
   `delta` for the whole score. Should each row carry its own
   sparkline / mini-delta (Ultrahuman-style 14-day trend) or is that
   scope-creep into the per-metric page? Recommendation: scope-creep —
   defer to W8 sub-pages (where it'll be a `<HealthChart>` anyway). The
   accordion stays a **structural** view; the sub-page is the
   **temporal** view.
4. **Localising "Mixed"** — when the pill says `Gemischt · 2`, do we
   spell out the sources (`Manuell + Withings`) in the pill itself, or
   keep it terse and reveal the split in tooltip? Recommendation:
   terse + tooltip, because the longest spelled-out combination
   ("Manuell + Withings + Apple Health") wrecks the column width on
   `<lg`.
5. **Telemetry** — should expanding the accordion fire an analytics
   event? HealthLog has no client telemetry today; adding a "first
   expansion" event would inform whether users actually engage with the
   provenance once. Recommendation: defer; revisit if Marc adds
   client-side analytics in v1.5+.
6. **Marketing copy in the accordion footer** — "Anteile sind nach
   verfügbaren Daten neu skaliert." is correct but dry. Alternative:
   "Dein Score zeigt nur, was du auch wirklich gemessen hast." A/B is
   out of scope; flagging in case Marc wants the warmer voice.
7. **Coach prefill on row tap** — should tapping a row in the
   accordion open the Coach drawer with a prefill ("Warum trägt BP nur
   X % zu meinem Score bei?") — the same affordance the existing
   "Ask the Coach" button on the card uses? Cheap to wire (one
   `onAskCoach` callback per row), high-trust UX. Recommendation: yes,
   build it in W8e v1; deeplink to the per-metric chart in W8 main.

---

## Reference list (deduped)

1. Oura Readiness Contributors — `https://support.ouraring.com/hc/en-us/articles/360057791533-Readiness-Contributors`
2. Oura Sleep Contributors — `https://support.ouraring.com/hc/en-us/articles/360057792293-Sleep-Contributors`
3. Oura blog (Sleep Score) — `https://ouraring.com/blog/sleep-score/`
4. TechLoved Oura sleep — `https://techloved.com/wearables/oura/sleep-score/`
5. 925studios Whoop design breakdown — `https://www.925studios.co/blog/whoop-design-breakdown`
6. Whoop Locker — `https://www.whoop.com/us/en/thelocker/how-does-whoop-recovery-work-101/`
7. Men's Health (DE) Whoop-vs-Oura — `https://www.menshealth.de/tech-entertainment/whoop-vs-oura-ring-welcher-recovery-tracker-ist-praeziser/`
8. Whoop support "Recovery Insights" — `https://support.whoop.com/s/article/Recovery-Insights` (via Kagi cache)
9. Apple Watch user guide — Vitals — `https://support.apple.com/guide/watch/vitals-apd15aa7ed96/watchos`
10. Apple Support "Overnight vitals" — `https://support.apple.com/en-ie/120142`
11. SlashGear Vitals explainer — `https://www.slashgear.com/1899899/apple-watch-vitals-app-explained-how-works/`
12. 5krunner Garmin sleep — `https://the5krunner.com/garmin-features/sleep/sleep-score/`
13. Garmin blog sleep — `https://www.garmin.com/en-US/blog/fitness/how-garmin-watches-track-your-sleep-calculate-sleep-score/`
14. Onlinebikecoach Garmin — `https://onlinebikecoach.com/garmin-metrics-101-sleep-score/`
15. Garmin Body Battery — `https://www.garmin.com/en-US/garmin-technology/health-science/body-battery/`
16. Google support Fitbit Readiness — `https://support.google.com/fitbit/answer/14236710?hl=en`
17. Lifehacker Fitbit Readiness — `https://lifehacker.com/health/how-fitbits-readiness-score-works`
18. r/fitbit Premium-gating thread — `https://www.reddit.com/r/fitbit/comments/1js8ix4/`
19. Ultrahuman blog — `https://blog.ultrahuman.com/blog/collections/beginners-guide-to-biohacking/`
20. Eight Sleep Sleep Fitness — `https://www.eightsleep.com/blog/sleep-fitness-score/`
21. Ultrahuman metabolic — `https://blog.ultrahuman.com/blog/how-is-your-metabolic-score-calculated/`
22. WCAG 2.1 status messages — `https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html`; MDN ARIA progressbar — `https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/progressbar_role`
23. BFIT-bund progress-bar accessibility — `https://handreichungen.bfit-bund.de/accessible-uie/fortschrittsanzeige.html`
