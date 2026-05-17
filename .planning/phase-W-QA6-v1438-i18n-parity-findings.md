# Phase W-QA-6 — v1.4.38 i18n Runtime Parity Audit

Scope: `messages/{de,en,es,fr,it,pl}.json` after W-E wave.
Diff range: `v1.4.37.2..HEAD` (develop, snapshot 2026-05-17).
Mode: READ-ONLY i18n parity audit.

---

## Headline numbers

| Locale | Keys | == DE (untranslated source leak) | == EN (fallback to English) |
| ------ | ---: | -------------------------------: | --------------------------: |
| de     | 2427 | — | 6.8% (English-only product strings carried in DE file) |
| en     | 2427 | 166 (6.8%) | — |
| es     | 2427 | 104 (4.3%) | **897 (37.0%)** |
| fr     | 2427 | 116 (4.8%) | **948 (39.1%)** |
| it     | 2427 | 118 (4.9%) | **915 (37.7%)** |
| pl     | 2427 | 119 (4.9%) | **898 (37.0%)** |

Structural parity: **PASS** — every locale carries the identical 2427-key tree (0 missing, 0 extra vs DE).
UTF-8 / mojibake scan: **PASS** — 0 mojibake sequences across all six locales; 50-string diacritic spot-checks all round-trip cleanly.

---

## Critical

_None._ No blockers for shipping; placeholders fail safe (TS lint would have caught hard breaks).

---

## High

### H-1. ICU placeholder dropped — pagination string loses `{count}` in es/fr/it/pl

`medications.intakeHistoryPageInfo`

- DE: `Seite {page} von {total} · {count} Einträge`
- ES: `Página {page} de {total}`
- FR: `Page {page} sur {total}`
- IT: `Pagina {page} di {total}`
- PL: `Strona {page} z {total}`

All four W-E translations dropped the `{count} Einträge` clause. Users on those locales lose the per-page entry count. next-intl will silently ignore the missing var but the UI parity vs DE/EN breaks.

**Fix:** re-append the count clause in all four locales. Suggested:
- es: `Página {page} de {total} · {count} registros`
- fr: `Page {page} sur {total} · {count} entrées`
- it: `Pagina {page} di {total} · {count} voci`
- pl: `Strona {page} z {total} · {count} pozycji`

### H-2. ICU placeholder dropped — weekday aria-labels lose `{day}` in es/fr/it/pl

`medications.dayActivate` / `medications.dayDeactivate`

- DE: `{day} aktivieren` / `{day} deaktivieren`
- ES: `Activar día` / `Desactivar día`
- FR: `Activer le jour` / `Désactiver le jour`
- IT: `Attiva giorno` / `Disattiva giorno`
- PL: `Włącz dzień` / `Wyłącz dzień`

These are a11y labels per weekday chip; without `{day}` interpolation, every chip announces the same generic "Activate day" to screen-reader users instead of "Activate Monday / Tuesday / …".

**Fix:** restore `{day}` in all four:
- es: `Activar {day}` / `Desactivar {day}`
- fr: `Activer {day}` / `Désactiver {day}`
- it: `Attiva {day}` / `Disattiva {day}`
- pl: `Włącz {day}` / `Wyłącz {day}`

---

## Medium

### M-1. ES — blood-pressure term split (`tensión` vs `presión`)

`Blutdruck` is rendered two different ways in `es.json`:

- 16 keys use **`tensión arterial`** (e.g. `doctorReport.bpClassificationTitle`, `doctorReport.avgBp`, `doctorReport.typeBpSys`, `doctorReport.typeBpDia`, `measurements.subtitle`).
- 11 keys use **`presión arterial`** (e.g. `dashboard.bloodPressure`, `measurements.typeBloodPressure`, `medications.categoryBloodPressure`, `insights.coach.metric.bp`, `doctorReport.sections.bp`).

Both are clinically valid in Spanish, but the same metric should read one way across dashboard, doctor report, and Coach. Recommend choosing **`presión arterial`** (medically dominant, matches WHO Spanish guidelines) and unifying the 16 `tensión` keys to it.

### M-2. PL — blood-pressure term split (`ciśnienie tętnicze` vs `ciśnienie krwi`)

- 6 keys use **`ciśnienie tętnicze`** (clinical: `doctorReport.bpClassificationTitle`, `doctorReport.avgBp`, `measurements.subtitle`).
- 9 keys use **`ciśnienie krwi`** (lay: `doctorReport.sections.bp`, `dashboard.bloodPressure`, `measurements.typeBloodPressure`).

The clinical sections (doctor report) say `tętnicze` while the same doctor report's section heading says `krwi`. Unify to **`ciśnienie tętnicze`** in clinical / doctor-report contexts; keep `ciśnienie krwi` only if intentional in casual dashboard copy. Currently the inconsistency reads as a translation oversight.

### M-3. PL — pulse term split (`tętno` vs `puls`)

20 keys use `tętno`, 11 keys still carry the German fallback `puls` (lowercase substring match). Most of the 11 are likely DE/EN-fallback strings rather than active mistranslations, but worth a sweep — `puls` is also a Polish word so it does not look obviously wrong, just inconsistent. Unify on **`tętno`** to match the dominant choice.

### M-4. EN-fallback remains 37–39% across es/fr/it/pl — T3 surface

W-E correctly excluded the heavy `admin`, `settings`, and `achievements` namespaces. The leftover EN-fallback breaks down (top 4 namespaces):

| Locale | admin | settings | achievements | medications |
| -----: | ----: | -------: | -----------: | ----------: |
| es | 337 | 328 | 149 | 30 |
| fr | 341 | 329 | 149 | 41 |
| it | 340 | 328 | 149 | 37 |
| pl | 340 | 328 | 149 | 31 |

`admin` + `settings` are documented as intentional T3 deferral (developer/operator surface, low user impact). `achievements` (149 keys × 4 locales) is the largest remaining user-facing gap. The smaller per-locale residuals (medications, insights, doctorReport, charts) are 4-41 strings each — quick to mop up in a follow-up wave.

**Action:** add an entry to `.planning/v1.4.38-backlog.md` documenting the T3 gap explicitly: "admin/settings/achievements + ~30-40 per-locale stragglers fall back to EN; tracked, not blocking."

---

## Low

### L-1. IT — longest strings approach 320 px clip threshold

Six IT strings in the dashboard / insights surface run > 35 chars and > 1.15× the DE source. None exceed practical button widths, but two warrant a visual check at 320 px viewport:

- `insights.hrv.chartTitle` — IT `Variabilità della frequenza cardiaca` (36 chars vs DE 21).
- `measurements.subtitle` — IT `Peso, pressione arteriosa, pulsazioni e altro` (45 chars vs DE 33). Used as a subtitle, normally low clip risk.

Recommend a 320 px Playwright snapshot on `/insights` and `/measurements` in IT before release; if clipping shows up, shorten to `HRV` or `Variabilità FC`.

### L-2. FR — `fr.insights.trendAnnotation.pendingLabel` is 46 chars

`Commentaire de tendance en cours de génération` vs DE 30 chars. Used as a pill on the trend card. Shorten suggestion: `Commentaire en cours…`.

### L-3. ES — empty-state titles run 36–40 chars

Several `insights.emptyState.*.title` and `mood.emptyTitle/emptyFilteredTitle` in ES are 35-40 chars. Empty-state cards have more horizontal room than buttons, so clipping risk is low, but H1 wrap can look awkward on 320 px. Recommend visual spot-check; no edit needed unless wrap is ugly.

### L-4. ChatGPT / OpenAI brand mentions in `settings.*`

26 keys per locale contain `ChatGPT` / `OpenAI`. These are correct provider labels in the AI-settings panel and not Marc-Voice violations. The user-facing **Coach** / **Insights** strings contain no leaked `Claude`, `Anthropic`, `LLM`, `hallucinate`, `marathon`, `wave`, or `phase` language anywhere across all six locales. **PASS** on Marc-Voice register.

### L-5. EN file still carries 166 untranslated DE strings

6.8% of `en.json` is identical to `de.json`. These are mostly proper nouns (medication names, brand strings) and one technical leftover (`measurements.typePulseWaveVelocity: Pulse-wave velocity` — actually English, just happens to == DE). Not a regression, but worth a one-off pass at next opportunity to confirm none are genuine EN gaps.

---

## What was checked and passed cleanly

- Structural parity (key sets identical across all 6 locales) — **PASS**
- UTF-8 / no mojibake (`Ã¼`, `Ã³`, `â€`, smart-quote bleed, etc.) — **PASS** in all 6
- ICU plural / select preservation — N/A (DE source carries 0 ICU `plural`/`select` blocks; all plurals are handled in TS via `intl.formatNumber` + helper components)
- Marc-Voice register: no `Claude / Anthropic / LLM / hallucinate / marathon / phase / wave / AI-agent` in any user-facing string in any locale — **PASS**
- FR `tension artérielle` (19/19) and IT `pressione arteriosa` (18/18) — fully consistent
- IT `Puls` leftover scan — **PASS** (counter false-positive earlier; no leftover German Puls in IT)

---

## Severity counts

- Critical: 0
- High: 2
- Medium: 4
- Low: 5

---

## Recommended fix order

1. **H-1 + H-2** (placeholder restores, 12 strings total) — single i18n edit pass, ship in next patch.
2. **M-1 + M-2** (ES/PL BP-term unification) — quick global replace.
3. **M-4** (document T3 gap in v1.4.38-backlog).
4. **L-1 + L-2** Playwright 320 px snapshot pass in IT + FR before release.
5. Defer **M-3, L-3, L-4, L-5** to v1.4.39 or later.
