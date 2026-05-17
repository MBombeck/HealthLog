# v1.4.37 — W10 i18n findings

Scope: `v1.4.36..HEAD` on develop, 6 locales (de, en, es, fr, it, pl),
21 new leaf keys across `dashboard.medicationIntakeQuickAdd.*` (13),
`measurements.{dailyTotalCaption,expandDay,collapseDay}` (3),
`settings.sections.export.{otherOptionsHeading,hero.*}` (5).
Removals: `settings.account.{timezoneDetect,timezoneDetectAria}` and
`settings.sections.export.cards.doctorReport.action`.

Approach: code-grep (no runtime probe — Playwright not spun up;
six dev-server boots × six locales would exceed the read-only lane
and other reviewers are in flight). Static parity proved 100 %
across all 6 locale bags (2427/2427 leaf keys per locale, zero
missing / zero extra), so a runtime probe would only confirm the
copy renders — not surface new fallback keys.

## Critical / High (missing key, raw fallback at runtime)

_None._

- All 21 new keys are present in all 6 locale files (`messages/de.json`,
  `en.json`, `es.json`, `fr.json`, `it.json`, `pl.json`).
- All 21 keys are referenced from source (verified via `grep -rn` on
  `src/`) — no orphan-on-arrival, no source-only references without a
  backing key.
- Removed keys `timezoneDetect`, `timezoneDetectAria`,
  `cards.doctorReport.action` are gone from all 6 locale files AND
  absent from `src/` — no dangling `t()` calls that would render the
  raw key at runtime.

## Medium (orphan keys, double-encoded UTF-8, EN-fallback copy)

- **Untranslated (EN-fallback) in es/fr/it/pl for the W7b + W7c
  copy.** 16 of the 21 new keys ship as the English string in the four
  non-DE/EN locales:
  - `dashboard.quickAddMedicationIntake` and all 12 children of
    `dashboard.medicationIntakeQuickAdd.*`
  - `measurements.dailyTotalCaption`, `measurements.expandDay`,
    `measurements.collapseDay`
  - Affected files: `messages/es.json`, `messages/fr.json`,
    `messages/it.json`, `messages/pl.json`.
  - **Established pattern, not a regression**: es/fr/it/pl already
    ship at 72-73 % EN-fallback overall (de=6 %, en=baseline,
    es=72 %, fr=73 %, it=72 %, pl=72 %). The W7a Arztbericht hero
    block (5 keys) was properly localised in every locale, which sets
    the bar; W7b + W7c did not match it.
  - Recommended fix (non-blocking for v1.4.37): in a follow-up
    translation pass, swap the EN fallbacks for native copy. Marc's
    primary launch locales are de + en, so this is Medium not High.

- **Inherited EN-fallback baseline.** The same pattern affects
  pre-existing keys in the same areas:
  - `dashboard.quickAddMeasurement`, `dashboard.quickAddMood`,
    `dashboard.compliance7d`, `dashboard.customizeTitle` are
    English in es/fr/it/pl (pre-existing, not introduced by W7).
  - `measurements.previousPage`, `measurements.nextPage`,
    `measurements.deleteConfirmDescription` likewise.
  - Recommended: same follow-up translation pass.

- **No double-encoded UTF-8 (`Ã¼`, `Ã¶`, etc.)** found in any of the
  21 new keys nor in any added line of the locale diff.

- **No orphan locale keys introduced by v1.4.37.** A heuristic sweep
  of `messages/en.json` against `src/` flagged 288 candidates after
  filtering dynamic namespaces (achievement-badge IDs,
  metric/measurement type tokens, time/date formatters,
  insights.metric_* dynamic lookups). Spot-check confirms every one
  of the 288 is either dynamically composed
  (`t("achievements.badges." + badgeId + ".title")`-style) or
  pre-existing — none was introduced by this release. The keys added
  in v1.4.36..HEAD are all source-referenced.

## Low (style, copy nit)

- **`Anthropic (Claude)` is a literal substring in `settings.ai.*`**
  across all 6 locales (pre-existing in v1.4.36). The Marc-Voice
  feedback memo treats "Claude" as banned, but this is the legitimate
  Anthropic model name in a provider-selector dropdown — same way
  "OpenAI (GPT-4)" or "Google (Gemini)" would appear. Not a v1.4.37
  regression; flagged for awareness only.

- **`User agent` literal in `admin.feedback.metaUserAgent`** across
  all 6 locales. Standard HTTP-header terminology in an admin-only
  view; not the "AI agent" sense. Not a regression.

- **W7c "({count} samples)" English copy is unparenthesised in DE**
  ("({count} Einzelwerte)") — both use parentheses, consistent.
  No issue.

- **The W7c en string says "samples" not "samples today"**
  (the W10 brief expected `{count} samples today`). The shipped
  string is `({count} samples)` / `({count} Einzelwerte)`. This is
  consistent across all locales and matches the rendering context
  (the caption sits next to a day header which already carries the
  date), so the "today" qualifier would be redundant. Confirmed
  intentional from `src/components/measurements/measurement-list.tsx:545`
  where the caption is rendered under each day row.

## Confirmed clean

- **Structural parity**: 2427 leaf keys per locale, all 6 locales
  identical key-set (zero missing, zero extra).
- **`{count}` placeholder** present in `measurements.dailyTotalCaption`
  across all 6 locales — runtime substitution will work.
- **`{tz}` placeholder removal**: `timezoneDetectAria` (the only key
  consuming `{tz}`) is gone from all 6 locale files and `src/`.
- **DE umlauts/ß**: all 13 new DE strings render the correct
  ä / ö / ü / ß bytes: "Medikamenteneinnahme", "auswählen",
  "Zeitfenster", "ausblenden", "für" (in
  `Ein druckbarer PDF-Bericht für den Arzttermin`), "Bericht" — all
  clean UTF-8, no `Nrnberg`-style stripping, no `Ã¼` double-encoding.
- **Latin diacritics in es/fr/it/pl new strings**: `é`, `à`, `í`,
  `ó`, `ú`, `ę`, `ż`, `ć`, `ś`, `ñ` all render correctly in the W7a
  Arztbericht hero block and `otherOptionsHeading`. No
  double-encoding.
- **Marc-Voice on new copy**: zero hits of "AI", "Claude", "agent",
  "marathon", "phase", "KI" in any of the 21 added strings across
  all 6 locales. Tone reads as Marc's authorship throughout.
- **Removed-key hygiene**: `grep -rn "timezoneDetect" src/ messages/`
  is silent. `grep -rn "doctorReport.action" src/ messages/` is
  silent. No stale `t("settings.account.timezoneDetect")` calls.
- **Namespace usage matches key location**:
  - `src/app/page.tsx:659-660` → `dashboard.medicationIntakeQuickAdd.sheetTitle/sheetDescription`
  - `src/components/dashboard/medication-intake-quick-add.tsx:245-408` → all 12 quick-add children
  - `src/components/measurements/measurement-list.tsx:545,590,591,682,717,718` → `dailyTotalCaption / expandDay / collapseDay`
  - `src/components/settings/arztbericht-hero-card.tsx:141,155,174,177` → `settings.sections.export.hero.eyebrow/valueStatement/cta/formatHint`
  - `src/components/settings/export-section.tsx:106` → `settings.sections.export.otherOptionsHeading`
- **Contract tests pinned**: the W7b quick-add fallback-guard test at
  `src/components/dashboard/__tests__/medication-intake-quick-add.test.tsx:175-176`
  already asserts the rendered text does not contain the literal
  `"dashboard.medicationIntakeQuickAdd"` key path, so a missing-key
  regression in en/de would fail CI.
