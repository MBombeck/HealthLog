# W10 Design / UX Review Findings — v1.4.25

**Scope:** `git log v1.4.24..develop` — focus on `src/components/**/*.tsx` and `src/app/**/page.tsx` changes (W3–W9 work, with W8c source-priority, W8d VO2 max tile, W8e Health Score provenance accordion, W9e maintainership banner, W4 insights sub-page scaffold).
**Method:** Static-only — no live preview was available, so this is a code/skill-based read against the 7-phase WCAG 2.1 AA rubric and against the W8 cross-page conventions Marc pinned.
**Cross-refs:** `.planning/phase-W8-v1425-cross-page-consistency-report.md`, `.planning/phase-W8e-v1425-health-score-provenance-report.md`, `.planning/research/health-score-provenance-ux.md`.
**Baseline that works well:** the W8e Provenance accordion is genuinely solid — `aria-expanded`/`aria-controls`/`aria-labelledby` all paired, focus-visible ring matches the Coach vocabulary, decorative bars hidden, source pills carry text + colour, drift-guard test pins every locale key. The W8.4 padding-unification is a clean win; AuthShell pads once. The VO2 max tile reuses `<TrendCard>` and inherits sibling-tile conventions for free.

---

## Critical (WCAG 2.1 AA blocker / broken on mobile / unrenderable in a locale)

### C1 — Sleep-stage chart renders un-themed grid lines + axes
`src/components/insights/sleep-stage-stacked-bar.tsx:247,253,259`
The new chart sets `stroke="hsl(var(--border))"` and `stroke="hsl(var(--muted-foreground))"` on `<CartesianGrid>` and both axes. But `--border` is defined as a hex (`#44475a` in `globals.css:140`), not an HSL triplet. The `hsl(<hex>)` form is invalid CSS, so SVG falls back to `currentColor` / nothing — grid lines and axis labels paint in the inherited foreground (often white-on-dark) instead of the muted token. The same anti-pattern already exists in `mood-chart.tsx:649` and `scatter-correlation-chart.tsx:89,128,129` (pre-existing tech debt), but the new W4c chart locks the regression in. Use the bare token, e.g. `stroke="var(--border)"` or the Recharts `theme` slot.

### C2 — Sleep-overview suffix string hard-coded EN/DE only
`src/components/insights/sleep-overview.tsx:53–69`
`formatHoursMinutes()` returns `"pro Nacht"` for `locale === "de"` and falls through to `"per night"` for everything else. FR/IT/ES/PL all see the English string under the headline number. This breaks the "Umlaute required everywhere" / full-locale-parity rule for the four AI-initial locales the v1.4.25 W9e banner explicitly tells users are supported. Move the suffix into `i18n.sleep.headlineCaptionSuffix` and use `t()`.

---

## High (clearly wrong UX, but page still functions)

### H1 — Insights tab strip pills miss the 44 px touch-target floor
`src/components/insights/insights-tab-strip.tsx:133`
Each pill is `px-3 py-1 text-xs` — total height ~26–28 px. W8.3 explicitly pinned `min-h-11` across the top-bar + section strips because this is a *primary* navigation surface; the eight Insights tabs are exactly that. Only the regenerate icon button gained the 44 × 44 floor. On Pixel-5 a thumb tap on "Stimmung" risks hitting "Schlaf" two pixels below. Add `min-h-11` to the pill class (the regenerate button comment on line 154 already documents the precedent).

### H2 — Injection-site SVG hit-targets are 22 px, not 44 px
`src/components/medications/injection-site-picker.tsx:165–184`
The inline comment says "Invisible 22px hit-target for touch — meets WCAG 2.5.5", but `r="11"` is a 22 px *diameter* circle. WCAG 2.5.5 Level AAA wants 44 × 44 (Level AA accepts 24 × 24 minimum with adequate spacing — `<circle>` neighbours are < 24 px apart in the SVG coords, so even the AA floor isn't met cleanly). Bump to `r="22"` and verify neighbouring hit-zones don't overlap, or wrap each anchor in a 44 px-tall `<button>` outside the SVG.

### H3 — Source-priority reorder arrows are 28 × 28
`src/components/settings/sources-section.tsx:339,350,494,505`
Up/Down icon buttons use `className="h-7 w-7"` — below the 44 px floor on the most-touched Settings surface (the page is keyboard-friendly via `aria-label`, but mouse + touch users get a tiny target). Adjacent W8.3 fixes (top-bar, section strips, medication form interval picker) explicitly hit this; this section was missed. Marc directive applies.

### H4 — Sub-page heading focus indicator is hidden
`src/components/insights/sub-page-shell.tsx:65–73`
The H1 receives programmatic `focus({ preventScroll: true })` on mount so screen-reader users hear the page name, but `className` adds `focus-visible:outline-none` with no replacement ring. A sighted keyboard user who hits the page (e.g. via `Skip to content`) sees no focus indication on the page title. Either drop `focus-visible:outline-none` or pair it with a visible ring/underline. WCAG 2.4.7 (Focus Visible) AA.

### H5 — Per-metric / device-type accordions skip `aria-controls`
`src/components/settings/sources-section.tsx:374–388,436` and similar
Both expanders set `aria-expanded` but no `aria-controls` / `id` pairing. The W8e Provenance accordion documented this contract two waves ago and added the pairing; the W8c source-priority surface ships without it. AT users hear "expanded" but no panel relationship. Mirror the W8e pattern.

### H6 — Maintainership banner dismiss button is 22 × 22
`src/components/i18n/maintainership-banner.tsx:108–115`
`p-1` around a 14 × 14 X icon = ~22 × 22 hit zone. The banner is global (renders on every authenticated page on FR/ES/IT/PL) and the dismiss button is the one interactive element on it. Same Marc directive that fixed top-bar / section strips applies.

### H7 — "Body outline" SVG `aria-label` not translated
`src/components/medications/injection-site-picker.tsx:60`
Hardcoded English string. FR/IT/ES/PL screen-reader users hear "Body outline" inside an otherwise localised flow. Move to `t("medications.injectionSiteBodyOutlineAriaLabel")` (or similar) and add the key to all six locale files; the W9e drift-guard catches misses.

---

## Medium (inconsistency vs project conventions, minor drift)

### M1 — Hard-coded Tailwind palette colours instead of Dracula tokens
- `src/components/medications/glp1-medication-card.tsx:429` → `text-orange-400` on the streak flame.
- `src/app/insights/medikamente/page.tsx:185,189,193` → `text-green-500` / `text-orange-500` / `text-red-500` on the taken / skipped / missed counters.
Project convention is `text-dracula-green` / `text-dracula-orange` / `text-dracula-red` (with `/15` band for chips). The hard-coded Tailwind colours will skew off-palette in both Dracula light + dark themes and don't pick up future palette changes.

### M2 — Wrong `aria-label` on injection-site picker group
`src/components/medications/injection-site-picker.tsx:54`
The `role="group"` wrapper labels itself with `t("medications.glp1WeeklyPresetTitle")`, which is the *cadence* preset string ("Once weekly"), not the picker name. Use a dedicated `medications.injectionSitePickerAriaLabel` key.

### M3 — `Smile` icon for "log side effect" reads as a positive affordance
`src/components/medications/glp1-medication-card.tsx:474`
A smile-face is semantically odd as the icon for *negative* side-effect logging. `Stethoscope`, `Frown`, or `ClipboardList` would be clearer; same icon should appear on the Coach drawer side-effect chip when that lands.

### M4 — Inconsistent BP label across locales
Five locales (en, fr, it, es, pl) ship `"BP"` for `insights.healthScore.componentBp`; DE ships `"Blutdruck"`. The Romance locales have native compact forms (FR: `"TA"`, IT: `"PA"`, ES: `"PA"`) and Polish has `"RR"`. The AI-initial pass left them all in English. Doesn't break layout (the W3 `w-24` column accommodates the longer DE string) but reads as a translation gap to non-EN users.

### M5 — Timeline list key uses array index
`src/components/insights/therapy-timeline.tsx:101`
`key={idx}` on `<li>` is a React anti-pattern that causes subtle DOM-reuse bugs when entries reorder (e.g. after a new dose change is logged in the middle of the window). Prefer `${entry.kind}-${entry.date}-${entry.medicationName ?? ""}`.

### M6 — `<Pill>` icon decorative but unannotated
`src/components/insights/therapy-timeline.tsx:170`
Inline icon inside the timeline line for injections has no `aria-hidden="true"`; screen readers will say "image" mid-sentence. Same pattern as the `<Syringe>` icons used elsewhere — easy wash.

### M7 — Dialog-internal `h-8` controls deferred indefinitely
`src/components/medications/medication-form.tsx:706–838`
W8 phase report says "deferred — inline controls inside a modal dialog where the user has already committed their tap intent". This is technically defensible against Marc's *primary-navigation* directive, but on a Pixel-5 the medication-form Dialog is full-bleed and these inputs are the *only* interaction. Worth scheduling a v1.4.26 sweep.

---

## Low (nice-to-have polish)

### L1 — `motion-reduce:animate-none` is set on Loader2 in some places but not others
Inconsistent — e.g. `insights-tab-strip.tsx:168` has it, `notification-status-card.tsx:115` does not. Settle on always-on for spinners that linger.

### L2 — Health Score card disclaimer is 10 px text
`src/components/insights/health-score-card.tsx:531` → `text-[10px]`. Borderline against the 12 px mobile floor; readable but tight. Same for the `provenance.footnote` row.

### L3 — `<details>` toggle on the GLP-1 medication-card lacks `aria-controls`
`src/components/medications/glp1-medication-card.tsx:363–377`
Native `<details>`/`<summary>` already conveys state, so this is purely cosmetic for parity with other accordions in the app.

### L4 — Therapy-timeline `<strong>` mid-sentence reads as bold visually but no semantic header
For screen-reader scanning by drug name, an `<h4 class="sr-only">` on each entry would help users jump.

---

## Cross-cutting observations

- **W8e Provenance accordion is the high-water mark for a11y in this release.** Other new surfaces (W4c sleep chart, W4d injection picker, W8c source priority) should mirror its `aria-expanded` + `aria-controls` + `aria-labelledby` rigour.
- **Mobile 44 px floor was applied to top-bar + section strips (W8.3) but not extended to subsequent waves.** The recurring 22 / 28 / 32 px shortfalls in W4 (tab strip), W4d (SVG), W8c (sources reorder), W9e (banner dismiss) all share one root cause: the directive lives in a phase report rather than a lint rule. Consider a CI grep for `h-7|h-8|min-h-[0-9]` on touchable elements.
- **Token discipline drift in newer code** — three separate new files use raw Tailwind colour utilities (`text-orange-400`, `text-green-500`, etc.) instead of the Dracula tokens. Worth surfacing in code-review checklist.
- **i18n parity is honoured at the *key* level** (W9e drift-guard catches missing keys in every locale) but not at the *quality* level — Romance locales still carry English abbreviations (`"BP"`, `"Meds"`) and one runtime string (`"per night"`) skips the i18n layer entirely. A second drift-guard that flags identical English strings across non-EN locales would catch this class.

---

## Summary counts

- **Critical:** 2 (C1 chart strokes, C2 sleep suffix)
- **High:** 7 (H1–H7 — three touch-target + two ARIA + one focus + one hardcoded label)
- **Medium:** 7 (M1–M7)
- **Low:** 4 (L1–L4)
