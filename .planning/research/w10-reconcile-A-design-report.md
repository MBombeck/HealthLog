# W10 Reconcile A — Design fixes report

**Branch:** `develop`
**Scope:** All Critical + High + Medium findings from `.planning/research/w10-design-review-findings.md`.
**Outcome:** All 16 findings (C1, C2, H1–H7, M1–M7) applied. Zero deferrals.

---

## Fixes applied

### C1 — Sleep-stage chart strokes resolve through Dracula tokens
- File: `src/components/insights/sleep-stage-stacked-bar.tsx:247,253,259`
- Change: `stroke="hsl(var(--border))"` → `stroke="var(--border)"`; same for `--muted-foreground`. The Dracula tokens are hex, so the bare `var()` form is the correct contract.
- Commit: `bd1cb2c`

### C2 — Sleep headline suffix translates across all six locales
- Files: `src/components/insights/sleep-overview.tsx:53–69,108–112`; `messages/{de,en,fr,es,it,pl}.json` — added `insights.sleep.headlineCaptionSuffix`.
- Change: the JS `if (locale === "de")` branch dropped the "per night" string into the English path for FR/IT/ES/PL. Moved suffix into `t("insights.sleep.headlineCaptionSuffix")` with native translations (de: "pro Nacht", fr: "par nuit", it: "per notte", es: "por noche", pl: "na noc").
- Commit: `e14466e`

### H1 — Insights tab-strip pills meet 44px touch-target floor
- File: `src/components/insights/insights-tab-strip.tsx:132–138`
- Change: pills get `inline-flex min-h-11 items-center`. Updated the regenerate-button comment that incorrectly claimed the pills were 28px tall.
- Commit: `72fcdc6`

### H2 — Injection-site SVG hit-targets clear WCAG 2.5.8 AA floor
- File: `src/components/medications/injection-site-picker.tsx:167–171`
- Change: `r="11"` (≈23.5 CSS px) → `r="12"` (≈25.6 CSS px). The abdomen-left/right pair at Δx=24 SVG units caps the upper bound — larger circles would overlap, so the picker hits the 24×24 AA floor without spacing collisions.
- Commit: `72fcdc6`

### H3 — Source-priority reorder arrows promoted to 44×44
- File: `src/components/settings/sources-section.tsx:339,350,494,505` (four buttons)
- Change: `className="h-7 w-7"` → `className="h-11 w-11"` on every Up/Down arrow on both the per-metric and device-type axes.
- Commit: `72fcdc6`

### H4 — Sub-page H1 gets visible focus ring
- File: `src/components/insights/sub-page-shell.tsx:65–73`
- Change: replaced bare `focus-visible:outline-none` with the focus-ring vocabulary used by insights pills + Coach drawer (`focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2`) + `rounded-sm`. Sighted-keyboard users now see the ring when the programmatic mount-focus fires.
- Commit: `72fcdc6`

### H5 — Per-metric + device-type accordions pair `aria-controls`
- File: `src/components/settings/sources-section.tsx:373–390,436–453`
- Change: added `aria-controls="sources-per-metric-panel"` / `"sources-device-type-panel"` on the expander buttons and matching `id` + `role="region"` on the panels. Mirrors the W8e Provenance contract.
- Commit: `72fcdc6`

### H6 — Maintainership banner dismiss button promoted to 44×44
- File: `src/components/i18n/maintainership-banner.tsx:108–115`
- Change: `p-1` (≈22×22) → `inline-flex h-11 w-11 items-center justify-center`, plus focus-ring parity. Icon stays at 3.5/3.5; only the hit area grows.
- Commit: `72fcdc6`

### H7 — Body-outline SVG aria-label translates
- File: `src/components/medications/injection-site-picker.tsx:60`
- Change: hardcoded `aria-label="Body outline"` → `aria-label={t("medications.injectionSiteBodyOutlineAriaLabel")}` with native translations added to all six locales (de: "Körperumriss", fr: "Silhouette du corps", it: "Sagoma del corpo", es: "Silueta del cuerpo", pl: "Sylwetka ciała").
- Commit: `72fcdc6`

### M1 — Hardcoded Tailwind palette → Dracula tokens
- Files:
  - `src/components/medications/glp1-medication-card.tsx:429` — streak flame `text-orange-400` → `text-dracula-orange`
  - `src/app/insights/medikamente/page.tsx:185,189,193` — `text-green-500` / `text-orange-500` / `text-red-500` → `text-dracula-green` / `-orange` / `-red`
- Commit: `8f3a954`

### M2 — Injection-site picker group `aria-label` corrected
- File: `src/components/medications/injection-site-picker.tsx:54`
- Change: `aria-label={t("medications.glp1WeeklyPresetTitle")}` (cadence preset string — wrong) → `aria-label={t("medications.injectionSitePickerAriaLabel")}`. New key added to all six locales.
- Commit: `72fcdc6`

### M3 — Side-effect icon: Smile → Stethoscope
- File: `src/components/medications/glp1-medication-card.tsx:14,474`
- Change: `Smile` lucide icon (positive affordance) replaced by `Stethoscope` so the icon matches the clinical context of side-effect logging. Import updated too.
- Commit: `8f3a954`

### M4 — BP component label native compact forms
- Files: `messages/{fr,it,es,pl}.json` — `insights.healthScore.componentBp`
- Change: FR `BP` → `TA` (Tension artérielle), IT `BP` → `PA` (Pressione arteriosa), ES `BP` → `PA` (Presión arterial), PL `BP` → `RR` (clinical convention). DE "Blutdruck" + EN "BP" unchanged.
- Commit: `8f3a954`

### M5 — Therapy-timeline `<li>` key
- File: `src/components/insights/therapy-timeline.tsx:100–101`
- Change: `key={idx}` → `key={`${entry.kind}-${entry.date}-${entry.medicationName ?? ""}`}`. Prevents DOM-reuse bugs when a new dose change is logged mid-window.
- Commit: `8f3a954`

### M6 — Therapy-timeline inline icons `aria-hidden`
- File: `src/components/insights/therapy-timeline.tsx:153,155,170`
- Change: `<Pill>`, `<ArrowUp>`, `<ArrowDown>` inline glyphs all get `aria-hidden="true"`. Screen readers stop announcing "image" mid-sentence.
- Commit: `8f3a954`

### M7 — Medication-form Dialog tap targets promoted
- File: `src/components/medications/medication-form.tsx:706–838`
- Change: schedule-row dropdown trigger `h-7 w-7` → `h-11 w-11`; New-schedule button `h-8` → `min-h-11`; four schedule inputs (windowStart/windowEnd/label/dose) `h-8` → `h-11`. Honours the 44px floor inside the Dialog without restructuring the dense grid.
- Commit: `8f3a954`

---

## Quality gates

- `pnpm typecheck` — clean after every commit
- `pnpm lint` — clean after every commit
- `pnpm test` (full suite) — 2647 passed, 1 skipped, 0 failed at the final commit

## Commit summary

| SHA | Title |
|-----|-------|
| `bd1cb2c` | fix(insights): sleep-stage chart strokes resolve through Dracula tokens |
| `e14466e` | fix(i18n): sleep headline suffix translates across all six locales |
| `72fcdc6` | fix(a11y): WCAG touch-target floor + ARIA pairing across W4–W9 surfaces |
| `8f3a954` | fix(design): Dracula tokens + Romance BP abbreviations + therapy-timeline polish |

## Deferrals

None. Every Critical, High, and Medium finding was applied.

## Flags

- Mid-session, a parallel process landed commits between mine (`c49fe73`, `04dd972`, `db5e07a`, `2bb49ae`, `71745b4`, `c38a2c8`, `3e78da6`) and silently reverted the unstaged H-cluster edits I had already made. Reapplied all edits; final state verified clean via diff and full test pass. No regressions surfaced in the test suite.
- Pre-existing tech-debt: `mood-chart.tsx:649` and `scatter-correlation-chart.tsx:89,128,129` carry the same `hsl(var(--border))` anti-pattern. The W10 review flagged these as separate from C1 (which only locked the new regression in). Left as-is per the report's explicit scoping; recommend a follow-up patch.

---

## Fix-E follow-up (2026-05-14) — C2 translation coverage already complete

The Fix-C release readiness sweep flagged "pre-existing i18n-locale-integrity failures (en/es, en/it, en/pl drift on `insights.sleep.headlineCaptionSuffix`)". Verified against the working tree: commit `e14466e` already shipped native translations for all six locales (en: "per night", de: "pro Nacht", fr: "par nuit", it: "per notte", es: "por noche", pl: "na noc"). `pnpm test src/lib/__tests__/i18n-locale-integrity.test.ts` is green (26/26). No follow-up patch needed — the C2 fix was complete on first landing; the Fix-C flag appears to reflect a transient mid-session snapshot.
