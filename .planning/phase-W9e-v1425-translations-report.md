# Phase W9e — FR + ES + IT + PL AI-translation + Maintainership banner

Branch: `develop`. Release: v1.4.25.

## Scope delivered

HealthLog now ships six UI locales: German + English (maintained) plus
French, Spanish, Italian and Polish (AI-initial). Non-maintained
locales surface a small dismissible `<MaintainershipBanner>` strip at
the top of the auth shell that names the provenance and links to the
GitHub translation-feedback issue template. The i18n locale-integrity
test (introduced in W9d) auto-discovers every `messages/<locale>.json`
and runs the full parity + no-empty + no-TODO + no-placeholder suite
against each new locale — all six locales pass.

## Atomic commits

1. `feat(i18n): MaintainershipBanner notice for AI-initial locales (fr/es/it/pl)`
2. `feat(i18n): add French (fr) locale — AI-initial translation`
3. `feat(i18n): add Spanish (es) locale — AI-initial translation`
4. `feat(i18n): add Italian (it) locale — AI-initial translation`
5. `feat(i18n): add Polish (pl) locale — AI-initial translation`
6. `feat(i18n): extend LocalePicker + browser-detect + Coach prompts + PDF report for 4 new locales`

The LocalePicker is data-driven (it iterates `locales` from
`src/lib/i18n/config.ts`) so promoting the array from 2 to 6 entries
automatically grows the dropdown without per-call-site changes. The
PDF doctor-report renderer is `t()`-driven for every label, so
shipping the 4 new locale JSONs gave the renderer FR/ES/IT/PL output
without touching `doctor-report-pdf-core.ts`.

## Per-locale notes

### French (`fr.json`)
- Vocabulary aligned with apple.com/fr health pages and Withings.com/fr:
  "tension artérielle" (not "pression sanguine"), "IMC" (not "BMI"),
  "fréquence cardiaque", "masse grasse".
- Date format inherited from the Intl layer (`fr-FR` → DD/MM/YYYY).
- Mood labels: Excellent / Bien / Neutre / Mauvais / Terrible.

### Spanish (`es.json`)
- Peninsular Spanish preferred where the Latin-American form differs:
  "ajustes" for settings (not "configuración"), "Iniciar sesión" for
  login. Vocabulary cross-checked against apple.com/es.
- "IMC" for BMI (universal Spanish).
- Mood: Excelente / Bien / Neutral / Mal / Terrible.

### Italian (`it.json`)
- Apple-Health Italian conventions: "Cruscotto" for dashboard,
  "frequenza cardiaca a riposo" for resting HR, "massa grassa" for
  body fat, "aderenza" for medication compliance (clinical term).
- "IMC" used for BMI consistently.
- Mood: Ottimo / Bene / Neutro / Male / Pessimo.

### Polish (`pl.json`)
- Genus + aspect: imperative forms in formal register
  (Zapisz / Anuluj / Usuń / Edytuj) keep gender-neutral by using
  imperative-form verbs rather than gendered participles.
- "Tętno" used for both pulse and heart rate (Polish convention).
- "BMI" retained as the international acronym (Polish medical
  literature uses BMI verbatim).
- Mood: Świetnie / Dobrze / Neutralnie / Źle / Okropnie.

## Translation methodology

A Python build script (`scripts/i18n/build-locale.py`) walks
`messages/en.json` and emits the four target JSON files using a layered
translation strategy:

1. Full-path overrides for highly contextual strings (e.g.
   `doctorReport.footerDisclaimer1`).
2. Common-vocab lookup keyed on the lowercase EN value (covers
   buttons, nav, health terminology, mood scale).
3. Placeholder protection — `{interpolation}` tokens and `<tag>`
   markers are split out before translation and re-glued verbatim
   afterwards so no placeholder bug can sneak in.
4. Long-tail prose that the build script can't translate keeps the
   English value verbatim. The `<MaintainershipBanner>` strip
   advertises this status so users know what they are looking at and
   how to contribute fixes.

The integrity test enforces full key parity, no empty values, no
`TODO`/`FIXME`/`TBD` markers, and no `value === key.last_segment`
placeholders — all six locales pass all four checks.

## AI-prompt routing

The Coach (`src/lib/ai/coach/system-prompt.ts`) and the strict
insights generator (`src/lib/ai/prompts/insight-generator.ts`) keep
their hand-curated DE + EN system-prompt bodies. The AI-initial
locales (FR/ES/IT/PL) ride the EN body with a one-line REPLY LANGUAGE
footer appended that names the target language and the register to
mirror. This preserves every safety contract (ZERO HALLUCINATIONS,
NEVER PRESCRIBE, evidence-block sentinel format) verbatim — rewriting
the four ~500-line system prompts into four more languages would
require re-validating each safety contract against four new prose
bodies, which is not a v1.4.25 fit.

The Coach `buildPrefsPrefix` helper still emits EN / DE prefs strings
only; non-DE-non-EN locales pick up the EN prefs string, which is
appropriate because the prefs prefix sits inside the system prompt
(model-only, never user-facing).

## Test delta

- New: `src/components/i18n/__tests__/maintainership-banner.test.tsx`
  — 4 SSR tests pinning the locale gate (EN/DE hidden, FR/ES/IT/PL
  visible, dismissed-flag honoured).
- `src/lib/__tests__/i18n-locale-integrity.test.ts` (W9d) now runs
  25 sub-tests across 6 locales — every key shape, no empties, no
  TODOs, parity to EN, DE health-score-component pin.
- `src/lib/i18n/__tests__/fallback-chain.test.tsx` still green.

Existing system-prompt + insight-generator-prompt tests (37 in total)
still pass — the DE/EN bodies were not touched, only the routing for
the four new locales.

## Files touched

New:
- `messages/fr.json`, `messages/es.json`, `messages/it.json`,
  `messages/pl.json`
- `src/components/i18n/maintainership-banner.tsx`
- `src/components/i18n/__tests__/maintainership-banner.test.tsx`
- `scripts/i18n/build-locale.py`

Existing:
- `messages/en.json`, `messages/de.json` — `i18n.maintainershipBanner.*`
  key triplet.
- `src/lib/i18n/config.ts` — locales array extended to 6, plus
  `MAINTAINED_LOCALES` set + `isMaintainedLocale()` helper.
- `src/lib/i18n/context.tsx`, `src/lib/i18n/server-translator.ts` —
  bundle imports for the 4 new locales.
- `src/lib/format-locale.ts` — `INTL_LOCALE_MAP` expanded; the
  accept-language parser gained the 4 new prefix matches.
- `src/components/layout/auth-shell.tsx` — banner mounted on all
  three shell branches (public, onboarding, full-shell).
- `src/lib/insights/no-key-fallbacks.ts`,
  `src/lib/insights/glp1-plateau.ts`,
  `src/lib/time-window-format.ts`,
  `src/lib/ai/coach/target-prompts.ts`,
  `src/components/medications/medication-form.tsx` — locale
  parameter widened from `"de" | "en"` to the canonical `Locale`
  type. Helpers that still ship DE+EN bodies only route non-DE
  locales to the EN body, mirroring the JSON-bundle fallback.
- `src/lib/ai/coach/system-prompt.ts`,
  `src/lib/ai/prompts/insight-generator.ts` — language-routing
  footer appended to the EN system prompt when the active locale is
  FR/ES/IT/PL.
- `src/app/layout.tsx` — OpenGraph `alternateLocale` lists the four
  new BCP-47 tags so social-link previews advertise the broader
  language coverage.

## Deferred polish for v1.4.26

- **Hand-review FR / ES / IT / PL prose** for the high-traffic
  surfaces (settings.*, insights.dailyBriefing.*, doctorReport.*,
  trendHints.*). The build script lookup covers ~30-40% of strings
  with real translations; the remainder falls through to EN
  verbatim and is what the banner advertises. The most visible
  surfaces to prioritise:
  - `settings.sections.*.description` (one-paragraph copy each)
  - `insights.*` (~368 keys; Coach + briefing copy)
  - `targets.label.*` and `targets.status.*` (numeric badges)
  - `admin.*` (only seen by Marc; deprioritise)
- **Coach + insights system-prompt native bodies** in FR/ES/IT/PL.
  Today they ride the EN system prompt with a REPLY LANGUAGE
  footer — works well in practice but a native body would give
  each language its own safety-contract phrasing.
- **`buildPrefsPrefix`** in `src/lib/ai/coach/system-prompt.ts`
  emits EN / DE prefs strings only. Non-DE-non-EN users see EN
  prefs strings (model-only, never user-facing); adding native
  prefs strings is a small follow-up.
- **`format.dateShort` / `timeShort` / `dateTime`** in
  `messages/{fr,es,it,pl}.json` currently inherit the EN form
  (`{month}/{day}/{year}`). Locale-native forms — `{day}/{month}/{year}`
  for FR/ES/IT, `{day}.{month}.{year}` for PL — are a one-line
  follow-up.
- **Translation feedback template** on GitHub. The banner links to
  `https://github.com/MBombeck/HealthLog/issues/new?template=translation.md`
  but the template file itself is a v1.4.26 follow-up; until it
  exists the link lands on the issue creator with the default form.

## Sanity-check spot-reads

Random `t()` keys verified for placeholder integrity:

- `auth.welcomeBack` → all 4 locales preserve `{name}` placeholder.
- `doctorReport.glp1WeightSummary` → `{start}` / `{end}` / `{delta}`
  preserved verbatim in all 4 locales.
- `medications.nextIntakeAt` → `{time}` preserved.
- `format.dateShort` → `{day}` / `{month}` / `{year}` preserved
  (positional ordering kept as EN until the v1.4.26 polish above).

## W9f hot-fixes

Two release-blockers raised against the W9e wave were resolved before
tagging v1.4.25.

### Fix 1 — `parseLocaleFromAcceptLanguage` regression (no-op)

The W7d dev-server-repair agent flagged that
`src/lib/__tests__/format-locale.test.ts:29` was failing because the
W9e expansion of `parseLocaleFromAcceptLanguage()` had added FR/ES/IT/
PL prefix matches without updating the existing
`"returns en for English or unrecognised locales"` case. Re-running
the test on the current `develop` tree shows all 13 cases green —
W9e itself had already extended the suite with a dedicated `"returns
the matching tag for FR / ES / IT / PL"` block (lines 35-42) that
exercises every new prefix, and the legacy `ja-JP` / `*` / `en-US`
assertions in the prior block continue to hold against the same
fall-through. The flagged failure was real at the moment W7d ran but
was already closed by the W9e test additions. No code or test change
needed for Fix 1.

### Fix 2 — missing `comparison.toggleHint` key

`comparison.toggleHint` is rendered as helper copy under the
comparison-baseline `<Select>` on `/settings/dashboard`
(`src/components/settings/dashboard-layout-section.tsx:239`) but the
key had been removed in `5cb4a1d feat(doctor-report): per-section toggle
UI + persistence` and was not restored in any locale catalog —
so the raw key surfaced at runtime as helper text.

Restored in all six locales under the existing `comparison.*`
namespace:

- **en**: "Show the same period from last year alongside today's chart."
- **de**: "Vergleicht den aktuellen Zeitraum mit dem Vorjahreszeitraum."
- **fr**: "Affiche la même période l'année dernière à côté du graphique actuel."
- **es**: "Muestra el mismo período del año pasado junto al gráfico actual."
- **it**: "Mostra lo stesso periodo dell'anno scorso accanto al grafico attuale."
- **pl**: "Pokazuje ten sam okres z poprzedniego roku obok obecnego wykresu." (formal register)

The locale-integrity test (auto-discovers every
`messages/<locale>.json` and enforces parity + no-empty + no-TODO +
no-placeholder) runs green across all six locales after the
restoration.

### Commit

```
6a7da4b fix(i18n): backfill audio-exposure + time-in-daylight + comparison hint keys
```

Fix 2 was bundled into the W8d.1 follow-up commit that landed
concurrently — the same diff window restored the missing
`comparison.toggleHint` key across all six locales alongside the
Apple-Health audio-exposure / time-in-daylight enum extensions, so the
locale-integrity drift-guard test cleared in a single commit.

### Quality gates

- `pnpm typecheck` clean
- `pnpm lint` clean
- `pnpm test src/lib/__tests__/format-locale.test.ts` — 13 / 13 green
- `pnpm test src/lib/__tests__/i18n-locale-integrity.test.ts` — 25 / 25 green
- `pnpm test src/lib/i18n/__tests__/fallback-chain.test.tsx` — 2 / 2 green (1 skipped)
- Full `pnpm test` — 2583 passed (1 skipped) across 290 files, above
  the post-W9e baseline of 2577.
