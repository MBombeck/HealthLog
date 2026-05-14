# Phase W8e — Health Score Provenance UI (v1.4.25)

Branch: `develop`
Baseline (W8d): 2606 unit tests
After W8e:       2627 unit tests (+21)
All quality gates green: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Scope (5 sub-tasks delivered, 1 visual polish commit on top)

### 8e.1 — Server: extend `HealthScoreComponentDetail` with `source` + `asOf`
Commit `86737fd` — `feat(health-score): expose per-component source + asOf in provenance detail`

- `HealthScoreComponentDetail` now ships `source: "manual" | "withings" | "appleHealth" | "mixed" | "none"` and `asOf: string` (ISO).
- `HealthScoreInput` learns an optional `attribution` slot (per-component contributing-source list + asOf timestamp + window-end anchor).
- `redistribute()` folds the attribution into each detail; the new `resolveSourceLabel()` collapses N tokens into the single UI label.
- Route reads `Measurement.source` on weight + BP rows and computes mood / compliance as manual until those ingest paths land. `mapMeasurementSourceToLabel()` collapses `IMPORT` onto `manual` (it is still user-supplied data).
- Backward compat preserved: callers that don't pass `attribution` get the same payload shape they had pre-W8e with sensible defaults (`manual` for present, `none` for absent, `asOf` defaulted to now).
- 5 new aggregator unit tests cover single-source, mixed-source, no-data, omitted-attribution backward compat, and missing-asOf fallback.

### 8e.2 — Client: inline tap-to-expand accordion inside `<HealthScoreCard>`
Commit `b48d05a` — `feat(health-score): inline provenance accordion with source attribution`

- `<HealthScoreCard>` learns `initiallyExpanded?: boolean` (test-only).
- New "Driven by" chevron toggle below the four component sub-bars; `aria-expanded` + `aria-controls` on the toggle, panel mounts only when expanded.
- Each row: `[label] [value-bar] [value] [weight-bar tinted dracula-cyan/60] [source pill]`.
- Sort by effective weight descending; ties break alphabetically by component key; null components sink to bottom.
- Source pill carries colour-coded border + localised text + `aria-label="Source: <name>"` + `title="as of <date>"` tooltip via `Intl.DateTimeFormat(locale)`.
- "Mixed sources" `role="status"` banner above rows when any row is `mixed`.
- "Provisional" header badge when fewer than 50 % of inputs carry data.
- i18n keys added to all six locales (en / de / fr / es / it / pl with Polish formal "Ręcznie / Wstępny" register).
- 14 new RTL-style SSR tests pin: toggle state, aria-controls/id pairing, sort order, source-pill localisation, mixed banner gating, empty-state dimming, provisional threshold (both fires and no-fires), source aria-label localisation, value-bar 0 % width for empty rows, asOf tooltip + `data-as-of` attribute, footnote rendering.

### 8e.3 — Accessibility verification + `aria-labelledby` polish
Commit `ae700ed` — `a11y(health-score): aria-labelledby pairing on provenance panel`

- Verified `aria-expanded` reflects state, `aria-controls` points at the panel id.
- Added `aria-labelledby={`${panelId}-toggle`}` on the panel `<section>` so screen readers announce "Driven by" as the panel name.
- `focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none` on the toggle button matches the rest of the coach-panel focus-ring vocabulary.
- Source pills convey source via text + colour (non-color information present); icons skipped — the localised strings ("Manual", "Withings", "Apple Health", "Mixed", "No data") already carry the meaning.
- Dracula-cyan/60 on muted/40 weight-bar track and dracula-yellow/30 on the mixed banner mirror existing W3 + W6 token pairings whose contrast was already audited.
- Decorative bars carry `aria-hidden="true"`; informative pills carry `aria-label`.
- Drift-guard regex updated to tolerate the new `aria-labelledby` attribute between `id` and `data-slot`.

### 8e.4 — Provisional badge
Delivered within 8e.2 (no separate commit needed). Badge renders when `presentCount < totalCount / 2` (i.e. fewer than half the configured inputs have data). Localised "Provisional" / "Vorläufig" / "Provisoire" / "Provisional" / "Provvisorio" / "Wstępny". Tooltip carries the full "{count} of {total}" copy.

### 8e.5 — Tests + drift-guard
Commit `380c6ce` — `test(health-score): drift-guard for provenance i18n key coverage`

- Pinned every key the accordion calls (`toggle`, `weightLabel`, `mixedBanner`, `footnote`, `asOfLabel`, `provisional`, `provisionalBadge`, `sourceAria`, all five `sources.*`) to a drift-guard test that iterates every shipped locale (`ALL_LOCALES`).
- A missing or empty value in any locale fails the test with a precise "<locale> locale missing or empty: <key>" message.

### Visual polish
Commit `2fd31f2` — `style(health-score): drop double divider above provenance accordion`

- The components list above the accordion already paints `border-t pt-3`; the accordion wrapper's own `border-t pt-2` produced a visually heavy double divider. Removed.

## Files changed (13 files, +1293 / -72)

```
messages/de.json
messages/en.json
messages/es.json
messages/fr.json
messages/it.json
messages/pl.json
src/app/api/analytics/route.ts                            (route attribution wiring + helpers)
src/app/insights/page.tsx                                 (AnalyticsData type expansion)
src/components/insights/__tests__/health-score-card-provenance.test.tsx  (NEW — 14 tests)
src/components/insights/health-score-card.tsx             (accordion + provisional badge)
src/lib/__tests__/i18n-locale-integrity.test.ts           (drift-guard, +1 test)
src/lib/analytics/__tests__/health-score.test.ts          (+5 attribution tests)
src/lib/analytics/health-score.ts                         (HealthScoreComponentDetail extension)
```

## Tests delta

| Category | Before | After | New |
|---|---|---|---|
| Aggregator (`health-score.test.ts`)         | 19 | 24 | +5 |
| Provenance accordion (new file)             | 0  | 14 | +14 |
| Locale-integrity drift-guard                | 13 | 14 | +1 |
| **Unit tests total**                        | **2606** | **2627** | **+21** |

## Self code-review findings (no superpowers:code-reviewer agent invocation — manual pass)

- ✅ Backward-compat: `attribution` optional everywhere; pre-v1.4.25 callers see no breaking shape change. New `source` field defaults sensibly.
- ✅ Determinism: `computeHealthScore` still pure for a given input; the only wall-clock dependency is the `windowEndAt` default which is always supplied by the route in production.
- ✅ Locale parity: drift-guard auto-discovers all six locale files; the explicit per-locale pinning catches regressions on every shipped locale.
- ✅ A11y: WCAG 2.1 AA — `aria-expanded` toggle, `aria-controls` + matching id, `aria-labelledby` on the panel, focus-visible ring, decorative bars hidden, source pills carry text not color.
- ✅ No PII: copy is generic ("Provisional", "Driven by", "Mixed"); no user-name, no health-figure, no BD-Zielbereich values leak into i18n strings.
- ⚠️ Minor: the route does an extra small `findMany` for BP-systolic source rows (max ~60 rows for 30-day window). Could be merged with the existing chunked BP read later, but the simpler shape keeps the new code self-contained. Filed as a follow-up.
- ⚠️ Minor: when `computeHealthScore` recurses on `previous` (delta calculation), the recursive call runs without attribution and produces a fresh `Date()` for `windowEndAt`. The previous-snapshot's `source`/`asOf` are never read (only `prev.score`), so this is benign — but worth pinning with a comment if it surprises a future reader.

## Deferred (out of scope per phase ticket)

- Per-component "Why?" sentence (research §8 question 2) — defer to the per-metric `/insights/<metric>` sub-pages (W8 main scope).
- Per-row sparkline / mini-delta — defer to W8 sub-pages.
- Coach prefill on row tap — research §8 question 7. Cheap wire-up, but adds another callback to plumb through the hero strip; left for a v1.4.26 backlog item.
- Telemetry on first accordion expansion — no client-side analytics in HealthLog today; revisit if Marc adds it.
- BP-source query merge with the existing chunked read in the route — micro-optimisation worth a separate cleanup phase.

## Commit log

```
2fd31f2 style(health-score): drop double divider above provenance accordion
380c6ce test(health-score): drift-guard for provenance i18n key coverage
ae700ed a11y(health-score): aria-labelledby pairing on provenance panel
b48d05a feat(health-score): inline provenance accordion with source attribution
86737fd feat(health-score): expose per-component source + asOf in provenance detail
```
