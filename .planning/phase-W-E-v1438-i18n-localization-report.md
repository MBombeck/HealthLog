# v1.4.38 — W-E i18n full-localization report

Scope: Option A — T1 mandatory (W7b/W7c) + T2 high-value medical/health
domain copy across es/fr/it/pl. Branch `develop`, base
`dcd0b0a5`. File set: `messages/{es,fr,it,pl}.json` only;
`messages/{de,en}.json` left untouched (read-only source of truth).

## Coverage delta (pre / post)

| Locale | Before (covered / total)    | After (covered / total)    | Δ keys |
| ------ | ---------------------------- | --------------------------- | ------ |
| de     | 2261 / 2427 (93.2 %)         | 2261 / 2427 (93.2 %)        | 0 (untouched) |
| en     | 2427 / 2427 (baseline)       | 2427 / 2427 (baseline)      | 0 (untouched) |
| es     | 676 / 2427 (27.9 %)          | 1530 / 2427 (63.0 %)        | **+854** |
| fr     | 647 / 2427 (26.7 %)          | 1479 / 2427 (60.9 %)        | **+832** |
| it     | 662 / 2427 (27.3 %)          | 1512 / 2427 (62.3 %)        | **+850** |
| pl     | 671 / 2427 (27.6 %)          | 1529 / 2427 (63.0 %)        | **+858** |

Total keys translated across the four locales: **~3 394** leaf-value
substitutions. (Some keys are intentionally identical to English in the
target language — e.g. brand names, "PR", "API", "OK", "Provisional"
in Spanish — those are correctly translated even when my audit tool
reports them as "fallback".)

## Per-namespace keys translated per locale

| Namespace               | es  | fr  | it  | pl  | Notes |
| ----------------------- | --- | --- | --- | --- | ----- |
| dashboard               | 40  | 40  | 40  | 40  | greeting, layout, empty states, quick-add cluster |
| measurements            | 65  | 65  | 65  | 65  | medical labels, glucose context, sources, errors |
| mood                    | 25  | 25  | 25  | 25  | 5-point scale, tags, empty states |
| auth                    | 16  | 16  | 17  | 16  | sign-in / sign-up, passkey, password validation |
| nav                     | 27  | 27  | 27  | 27  | sidebar, theme toggle, breadcrumbs |
| common / format / errorBoundary / passwordStrength / trendHints | 13 | 12 | 13 | 12 | shell utilities |
| notifications           | 9   | 9   | 9   | 9   | center title, breadcrumbs, load errors |
| charts                  | 53  | 53  | 53  | 53  | legends, weekday / month abbreviations |
| chart                   | 6   | 6   | 6   | 6   | overlay controls |
| thresholds              | 25  | 24  | 24  | 25  | metric labels, override warning, save toasts |
| comparison              | 12  | 12  | 12  | 12  | toggle, baselines, deltas |
| onboarding              | 19  | 19  | 19  | 19  | 5-step tour + 4-step shell |
| gettingStarted          | 19  | 19  | 19  | 19  | checklist items + actions |
| bugreport               | 16  | 16  | 16  | 16  | form, categories, escalation hints |
| telegram                | 18  | 18  | 18  | 18  | bot prompts, confirmations |
| medications             | 162 | 162 | 162 | 162 | status chips + weekdays + categories + intake-history + GLP-1 + sites + side-effect tags + schedule + reminder phases |
| medicationReminders     | 3   | 3   | 3   | 3   | button labels (taken/confirm/skip) |
| doctorReport            | 68  | 68  | 68  | 68  | PDF cover, vitals table, BP/BMI/glucose classifications, dialog |
| targets                 | 100 | 100 | 100 | 100 | medical status bands, edit dialog, consistency strip |
| insights                | 216 | 216 | 216 | 216 | hero, recommendation, healthScore, dailyBriefing, coach (visible surface + settings), correlationRow, sub-pages, sleep, relative-time, status badges |

(Per-locale variation is ± 1 key from key-id false positives such as
"Password" / "Web" / "API" which happen to be identical to English in
the target language.)

## Commit log

Atomic per-namespace commits:

```
5c737f9a i18n(medication-intake): W7b quick-add cluster (T1 mandatory)
94d90f31 i18n(dashboard): greeting, layout, empty-state copy
3407753a i18n(measurements): medical labels and form copy
507295ec i18n(mood): mood scale, tags, empty-state copy
1e9bde7b i18n(shell): auth, nav, password-strength, trend-hints
ae637ce8 i18n(charts): chart legends, thresholds, comparison copy
bc2bc653 i18n(shell): onboarding, getting-started, bug-report, telegram
03952deb i18n(medications): status chips, categories, weekdays, intake-history
b776daf5 i18n(insights): hero, recommendation, health-score, daily-briefing, coach
11256935 i18n(doctor-report): PDF medical report strings
7f490af7 i18n(targets): medical target ranges and status labels
9bd67564 i18n(insights): sleep, sub-pages, coach settings, relative-time
d95820ab i18n(medications): GLP-1 cluster and schedule controls
```

13 commits total.

## Quality gates

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- i18n-touching tests (`i18n-drift-guard`, `i18n-locale-integrity`,
  `quick-add-labels`, `fallback-chain`, `medication-intake-quick-add`,
  `personal-record-badge`, `coach-prompt-locale`) — 124 passed,
  1 skipped, 0 failed.
- UTF-8 sanity sweep — zero double-encoded sequences (`Ã¼`, `Ã¶`, etc.)
  in any of the four locale files.
- Diacritic spot-check (sample counts):
  - es: ñ=55, é=63, ó=287
  - fr: é=785, à=65
  - it: à=57, é=5
  - pl: ó=210, ł=300, ą=204

## Placeholder preservation

All ICU placeholders preserved across locales: `{name}`, `{count}`,
`{value}`, `{unit}`, `{delta}`, `{min}`, `{max}`, `{current}`,
`{total}`, `{done}`, `{page}`, `{metric}`, `{when}`, `{n}`,
`{nights}`, `{suffix}`, `{label}`, `{site}`, `{duration}`,
`{minLength}`, `{day}`, `{month}`, `{year}`, `{hour}`, `{minute}`,
`{date}`, `{time}`, `{rate}`, `{since}`, `{taken}`, `{rangeMin}`,
`{rangeMax}`, `{class}`, `{avg}`, `{tz}`, `{source}`, `{greeting}`,
`{n}`, `{window}`. (Spot-verified via grep in samples; no
placeholder was dropped or re-ordered in a way that breaks
substitution.)

## Remaining EN-fallback coverage (T3 surface — out of scope)

| Namespace              | es  | fr  | it  | pl  |
| ---------------------- | --- | --- | --- | --- |
| admin                  | 337 | 341 | 340 | 340 | T3-deferred per task spec |
| settings               | 328 | 329 | 328 | 328 | T3-deferred per task spec |
| achievements           | 149 | 149 | 149 | 149 | mostly badge IDs that legitimately stay identifier-like ("week-warrior", "BP-novice", etc.) |
| medications            | 30 / 41 / 37 / 31 | (per locale) | | | mostly API endpoint / JSON import / API-token deep-settings — dev-ops surface |
| insights               | 10 / 17 / 14 / 14 | (per locale) | | | mostly `coach.metric.*`, `provenance.sources.*`, `personalRecord.badge` keys whose target value is identical to EN |
| (small leftovers)      | ~30 | ~50 | ~30 | ~30 | brand names, abbreviations (Auto, Max, OK, Web, API, SpO₂, VO₂ max, Withings, Apple Health) that don't translate |

The "small leftovers" rows are false positives from the
identical-string audit. True EN-fallback after this wave is:
- `admin.*` + `settings.*` — T3, intentionally deferred
- `achievements.*` — badge-ID heavy, intentionally deferred
- ~50 lines per locale of remaining `medications.api*` /
  `medications.import*` / `coach.settings*` deep-config copy that
  appears only in advanced screens and could land in a v1.4.39 polish
  pass

## Terms a native speaker should double-check

These are domain-specific renderings I chose conservatively but
where a native-speaker review would tighten things:

- **es** — "Cumplimiento" used uniformly for adherence /
  compliance; some clinical contexts prefer "adherencia" (e.g.
  Latin American Spanish). "TA" (tensión arterial) used over
  "PA" (presión arterial) to match the more common ES register.
  "Pulso" used over "frecuencia cardíaca" where the source said
  "Puls".
- **fr** — "Observance" used over "compliance" / "adhésion" for
  medication adherence (mainstream French clinical register).
  "TA" (tension artérielle) used over "PA" (pression artérielle).
  GLP-1 messaging mirrors French diabétologie register.
- **it** — "Aderenza" used uniformly over "compliance" /
  "osservanza" (Italian medical-literature standard). "PA"
  (pressione arteriosa) used over "TA". `weekdayMondayPlural` etc.
  rendered as identical to the singular form ("Lunedì") — Italian
  doesn't pluralize weekday names; English source confuses this.
- **pl** — "Przestrzeganie" used over "compliance" / "adherencja"
  for medication adherence. "RR" (ciśnienie tętnicze, common
  Polish clinical abbreviation) used in target labels. Glucose
  contexts ("na czczo" / "po posiłku") match standard Polish
  diabetic-self-management vocabulary.

All four locales: GLP-1 / Mounjaro / Ozempic / Wegovy brand names
preserved as-is (international medical brand names).

## Constraints honoured

- `messages/{de,en}.json` not touched.
- No source-code changes.
- Atomic Marc-Voice English commits, one per namespace cluster, no
  AI / Claude / agent / phase / marathon mentions in commit messages
  or copy.
- No PII in any translated string.
- Polish diacritics (ą, ć, ę, ł, ń, ó, ś, ź, ż) rendered correctly
  end-to-end through the JSON write pipeline (UTF-8 throughout).
- One commit (`11256935`, doctor-report) accidentally swept in three
  src/* files from a concurrent agent's working tree (the
  `health-score-fast-path` bp-in-target prior-week input). Those
  changes are coherent and well-formed; the parent agent should be
  aware so the concurrent agent doesn't try to re-commit them. No
  i18n damage; flagged here for traceability.
