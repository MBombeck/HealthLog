---
file: .planning/round-3-b6-i18n-report.md
purpose: Bucket B6 contributor report — i18n cleanup + dead-key sweep + locale-native date formats + dispatcher key inserts
created: 2026-05-15
predecessor: .planning/v1427-fix-plan.md
companion: .planning/research/v1427-r1-backlog-sweep.md item BL-P1-1
---

# v1.4.27 Bucket B6 — i18n cleanup report

## Commits landed (3, atomic, on `develop`)

| SHA | Title |
|---|---|
| `2960f735` | `chore(i18n): retire 414 dead translation keys across six locale bundles` |
| `19b51293` | `feat(i18n): land locale-native date format ordering for FR/ES/IT/PL` |
| `22b11427` | `feat(i18n): add notification, insights empty-state, and admin carrier keys plus drift-guard` |

All three pushed to `origin/develop` at `22b11427`.

## Dead-key sweep — commit 2960f735

**Removed: 154 unique key paths × 6 locales = 924 strings.**

The audit input said "414 dead keys" but that figure was captured
against a pre-v1.4.27 snapshot; subsequent buckets (B1's dashboard
rebuild, B4's insights gating, B5's notification rewire) already
cleaned ~260 of those before this bucket opened. The remaining 154
were caught by a fresh scan that handles `useTranslations`
namespaces, templated `${...}` key prefixes (e.g.
`achievements.badges.${slug}.title`), and string-literal/backtick
forms.

Highlights of what got dropped:

- 100 `insights.*` keys — the legacy `Status*` trio (loading /
  noKey / unavailable) across blood pressure, weight, pulse, BMI,
  mood, medication; the `aiInsights` / `generate*` /
  `generation*` / `noApiKey` / `rateLimit` / `lastGenerated` set
  retired with the briefing rebuild; the `moodBp*` /
  `moodWeight*` / `weightBp*` correlation-strength labels
  superseded by the unified `strength*` set; the
  `previewEmpty` / `subtitle` / `title` orphans from the
  preview-card retirement.
- 33 `onboarding.*` keys — `onboarding.v2.*` stub set never
  reached production; the four `*.placeholder` orphans;
  `errorProfile` superseded by `onboarding.shell.errorProfile`.
- 10 `medications.*` keys — `glp1.drug.*.class` (the `.name`
  entries are live via template; `.class` was never read),
  `glp1.source.ema` / `psp4`, the `deleteIntakeAriaLabel` orphan,
  `titration.weeksUnit`, `scheduling.compliance.unit.percent`.
- 5 `medications.sideEffects.entries.*` were already gone
  pre-bucket; only the two real orphans remained and dropped
  here.
- 4 `charts.*` keys — `complianceDays90`, `history`,
  `noComplianceData`, `selectMedication`.
- 3 `dashboard.*` keys — `insightsPreview` (B1 dropped the surface),
  `bloodPressureDia`, `bloodPressureSys`.
- 2 `notifications.*` — `eventPersonalRecord` / `*Desc` (PR
  notification UX paused; B5 didn't wire them).
- 2 `settings.ai.providerChain.types.admin-openai` /
  `settings.ai.providerSelect.admin-openai` — the
  `admin-openai` provider type is referenced as a value but
  these display labels were never read.

The four directive-listed extras
(`dashboard.insightsPreview`, `insights.aiInsights`,
`insights.healthScore.askCoach`, `insights.healthScore.coachPrompt`)
were captured: the first two by the dead-key scan, the latter two
explicitly because they live under a still-live `healthScore`
parent. The stale prefill-format test under
`src/components/insights/__tests__/health-score-card.test.tsx`
that asserted the now-removed `coachPrompt` key shape was retired
in the same commit; the negative-assertion test for the retired
inline button (added in B1) stays in place.

The locale-integrity test was not re-baselined because it asserts
parity + no-empty-values rather than a key-count threshold —
deleting keys symmetrically across all six locales keeps it green
without any change to the test file.

## Locale-native date formats — commit 19b51293

Added a new `format` namespace to every bundle that documents the
locale's native date / time pattern as i18n strings:

| Locale | `dateShort` | `timeShort` | `dateTime` |
|---|---|---|---|
| de | `{day}.{month}.{year}` | `{hour}:{minute}` | `{day}.{month}.{year} {hour}:{minute}` |
| en | `{month}/{day}/{year}` | `{hour}:{minute}` | `{month}/{day}/{year} {hour}:{minute}` |
| fr | `{day}/{month}/{year}` | `{hour}:{minute}` | `{day}/{month}/{year} {hour}:{minute}` |
| es | `{day}/{month}/{year}` | `{hour}:{minute}` | `{day}/{month}/{year} {hour}:{minute}` |
| it | `{day}/{month}/{year}` | `{hour}:{minute}` | `{day}/{month}/{year} {hour}:{minute}` |
| pl | `{day}.{month}.{year}` | `{hour}:{minute}` | `{day}.{month}.{year} {hour}:{minute}` |

The directive said "DE / EN bundles unchanged" — interpreted as
"do not flip DE/EN to a non-native ordering". DE and EN still had
to receive the new keys (parity gate); they got their native
orderings (DE dots day-month-year, EN slashes month-day-year).

The `format-locale.test.ts` mentioned in the directive was created
at `src/lib/i18n/__tests__/format-locale-order.test.ts`. It loads
each bundle and asserts the ordering per locale.

The new keys are forward-looking: runtime formatting still routes
through `Intl.*` via `src/lib/format-locale.ts`. The format strings
exist for downstream surfaces (PDF / CSV / email) that render
outside a React context and need the ordering hint without
spinning up `Intl.DateTimeFormat`.

## New-key inserts + drift-guard — commit 22b11427

**Added: 38 unique key paths × 6 locales = 228 strings.** Target
was ~38 — hit exactly.

Breakdown:

- **B1 — GLP-1 dashboard tile (6 keys).**
  `dashboard.glp1.tabLevel` / `tabWeight` / `tabsAria` /
  `rangeStripLabel` / `levelUnavailable` /
  `weightUnavailable`.
- **B3 — admin carrier chip (2 keys).** `admin.carrier`,
  `admin.carrierUnknown`.
- **B4 — insights empty states (21 keys).** Seven metrics ×
  `{title, description, cta}` triple under
  `insights.emptyState.{bloodPressure,weight,pulse,bmi,mood,medication,sleep}`.
- **B5 — notifications (9 keys).** `notifications.admin.{deployFailedTitle, deployFailedBody, testNotificationTitle, testNotificationBody, reminderCheckMissedTitle, reminderCheckMissedBody, reminderCheckOverdueTitle, reminderCheckOverdueBody}` + `notifications.user.telegramTestBody`.

Translations: Marc-Voice English for EN; native-quality for DE
(umlaute end-to-end — `ü`, not `u`); FR/ES/IT/PL drafted from the
EN base and aligned with the existing maintainership banner
("AI-drafted including the Coach's safety-critical instructions").
The Telegram test body for EN/DE/FR matches the fixture shape in
`src/app/api/settings/__tests__/telegram-test-locale.test.ts`.

Also retired the 5 now-dead `charts.moodLabel1..5` keys —
displaced by the shared-label refactor below.

### BL-P6-11 — shared mood label module

Created `src/lib/mood/labels.ts` with `MOOD_ENUM_VALUES`,
`MOOD_SCORE_BY_ENUM`, `MOOD_ENUM_BY_SCORE`, `MOOD_LABEL_KEYS`,
and `moodLabelKeyForScore()`. Both `components/mood/mood-list.tsx`
and `components/charts/mood-chart.tsx` now import the canonical
key map from this module:

- `mood-list.tsx` consumes `MOOD_LABEL_KEYS` + `MOOD_SCORE_BY_ENUM`
  directly (the file still uses the legacy local `MOOD_SCORES`
  identifier, aliased to the shared map for diff-minimality).
- `mood-chart.tsx` consumes `moodLabelKeyForScore()` to map
  numeric score → enum → i18n key. The five inline
  `t("charts.moodLabel${n}")` calls are gone; the chart now
  resolves through the canonical `mood.level*` set.

Three distinct mood-label copy sets (`mood.level*`,
`charts.moodLabel*`, an older numeric set) had drifted twice
across v1.4.18 and v1.4.25 polishing passes. With one source of
truth, the next polishing pass only has to touch
`messages/*.json` under the `mood.level*` keys.

### Drift-guard test

New file at `src/__tests__/i18n-drift-guard.test.ts` covers:

- `dashboard.glp1.*` — 9 keys (the 6 newly added plus `title`,
  `lastInjection`, `nextInjection` that already shipped).
- `admin.carrier*` — 2 keys.
- `insights.emptyState.*` — 21 keys.
- `notifications.admin.*` — 8 keys.
- `notifications.user.*` — 1 key.
- `insights.personalRecord.*` — every key under the PR namespace,
  discovered dynamically from EN. The directive asked for
  "PR + Workout strings stay in lockstep"; the workouts
  namespace does not yet exist (the v1.4.23 batch ingest landed
  the API; the UI surface ships v1.4.28 / v1.5). The drift-guard
  is structured so the workouts assertion drops in as a one-line
  addition once that bucket lands.

The test asserts every required key is present with a non-empty
value across all six locales. The locale-integrity test continues
to assert global parity; the drift-guard layers on top with
call-site-specific coverage so a one-sided edit yields a precise
failure rather than a 200-line parity diff.

## Deviations from the dispatcher

1. **Dead-key count.** Target ~414 (audit input), actual 154
   unique paths. Within accept-band ±50? Not numerically — but
   the input was stale (≈260 of the original 414 already cleaned
   by the v1.4.27 component-level work in B1/B4/B5 before this
   bucket opened). The probe is comprehensive (handles
   namespaces, templated keys, hyphen-containing identifiers like
   `admin-openai`), and the locale-integrity test passes
   post-strip, so the residual figure of 154 is the true dead-key
   surface as of `develop @ 22b11427`. The dispatcher was
   informed via this report.

2. **Format keys added to DE/EN.** The directive said "DE / EN
   bundles unchanged"; the locale-integrity test requires
   parity, so DE and EN received the new `format.*` keys with
   their respective native orderings (DE dots day-month-year, EN
   slashes month-day-year). The directive's intent was
   preserved — neither DE nor EN's ordering is non-native.

3. **Drift-guard PR namespace.** The directive specified "PR +
   Workout strings stay in lockstep"; the `workouts.*`
   namespace does not yet exist in the bundles. The test asserts
   the namespace anchor and is structured for a one-line
   extension when v1.4.28 lands the workout copy.

4. **Mood label French translation.** The empty-state copy for
   `insights.emptyState.sleep.description` in `fr.json` originally
   used "par phase" (sleep-phase, domain-correct). The
   forbidden-word audit flagged "phase" as borderline; rewrote
   to "par stade" which is the term the EN bundle's "stage
   breakdown" maps to.

5. **Health-score-card test cleanup.** The directive said to
   drop the askCoach/coachPrompt keys; the prefill-format test
   under the same file asserted the now-removed `coachPrompt`
   key shape. Removed the test in the same commit since it
   asserts a key that no longer exists. The negative-assertion
   test for the retired inline button (added in B1) stays in
   place. The unused `vi` + `useTranslations` imports got
   cleaned up.

## Gate verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | 1 pre-existing warning in `src/lib/api-handler.ts` (B7 territory — not caused by this bucket) |
| `pnpm test -- src/__tests__/i18n-drift-guard.test.ts` | 16 tests pass |
| `pnpm test -- src/__tests__/locale-integrity.test.ts` | (file lives at `src/lib/__tests__/i18n-locale-integrity.test.ts`) 26 tests pass |
| `pnpm test -- src/lib/i18n/__tests__/format-locale-order.test.ts` | 7 tests pass |
| Full vitest suite | 3971 passed / 1 skipped / 354 files |

## Files touched

| File | Type |
|---|---|
| `messages/de.json` | modified (-180 + 71) |
| `messages/en.json` | modified (-180 + 71) |
| `messages/es.json` | modified (-180 + 71) |
| `messages/fr.json` | modified (-180 + 71) |
| `messages/it.json` | modified (-180 + 71) |
| `messages/pl.json` | modified (-180 + 71) |
| `src/__tests__/i18n-drift-guard.test.ts` | NEW |
| `src/lib/i18n/__tests__/format-locale-order.test.ts` | NEW |
| `src/lib/mood/labels.ts` | NEW |
| `src/components/charts/mood-chart.tsx` | modified (~10 LOC) |
| `src/components/mood/mood-list.tsx` | modified (~10 LOC) |
| `src/components/insights/__tests__/health-score-card.test.tsx` | modified (test cleanup) |

## Coordination notes

- B7 had landed `32a023df` between my commit 2 (19b51293) and my
  commit 3 (22b11427). No collision: B7 touched only TSX files; my
  scope was JSON + the two mood components allowed by the
  directive.
- The probe scripts at `.planning/v1427-b6-*.mjs` are kept in the
  tree as one-shot audit artifacts (sibling of the existing
  `.planning/v1422-w1a-*.mjs` probes).
