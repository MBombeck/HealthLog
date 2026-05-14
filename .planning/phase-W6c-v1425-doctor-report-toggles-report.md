# Phase W6c v1.4.25 — Doctor-Report data toggles

**Branch:** `develop`
**Marc directive:** 2026-05-14 — users decide which data types appear in their doctor-report PDF; each toggle gates one section; mood is privacy-sensitive (default OFF); empty sections in the chosen date range are hidden entirely.

## Commits (in order)

| Hash      | Message                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `a7bc74b` | `feat(schema): User.doctorReportPrefsJson + migration 0045`                                     |
| `5cb4a1d` | `feat(doctor-report): per-section toggle UI + persistence`                                      |
| `759fdae` | `feat(doctor-report): server filter respects per-section toggles + PDF skips disabled sections` |
| `64d50fd` | `i18n(doctor-report): EN + DE strings for section toggles`                                      |

## What landed

### Schema (Phase 1)

- `prisma/migrations/0045_doctor_report_prefs/migration.sql` — adds `User.doctor_report_prefs_json JSONB` (nullable). Numbering chosen after W7b's `0044_mood_entry_tz_column`; no conflict.
- `prisma/schema.prisma` — adds `doctorReportPrefsJson Json? @map("doctor_report_prefs_json")` with explanatory comment about the privacy default for mood.
- `src/lib/validations/doctor-report-prefs.ts` — Zod `doctorReportPrefsSchema` (every key optional), `DEFAULT_DOCTOR_REPORT_PREFS` constant (`mood: false`, everything else ON), `parseDoctorReportPrefs()` + `resolveDoctorReportPrefs()` helpers.
- `src/lib/validations/__tests__/doctor-report-prefs.test.ts` — 11 unit tests covering schema validation, partial updates, default-fallback, and forward-compat drift.

### Dialog + persistence (Phase 2)

- `src/components/doctor-report/doctor-report-dialog.tsx` — completely re-styled with a new "Choose sections" group below the practice-name input. Renders one toggle per section, but **only for sections with rows in the chosen date range** (Marc's hide-when-empty rule). Mood gets an inline "Sensitive — off by default" footnote in DE + EN. The dialog also:
  - Lazy-loads persisted prefs from `GET /api/auth/me/doctor-report-prefs` when first opened.
  - Re-probes availability on every range change with a generation-counter to prevent stale-write races.
  - Fire-and-forget persists the chosen prefs via `PUT /api/auth/me/doctor-report-prefs` so the next dialog opens with the same selection.
- `src/components/settings/export-section.tsx` — forwards `payload.sections` from the dialog into the `POST /api/doctor-report` body.
- `src/app/api/auth/me/doctor-report-prefs/route.ts` — new GET + PUT endpoint following the v1.4.23 coach-prefs pattern. PUT merges partial updates over the persisted row (or defaults when null) and writes the fully-resolved canonical shape.
- `src/app/api/auth/me/doctor-report-prefs/__tests__/route.test.ts` — 5 unit tests: GET-default, PUT-happy-path, PUT-partial-merge, PUT-invalid-shape (422), PUT-unauthenticated (401).
- `src/app/api/doctor-report/availability/route.ts` — new POST endpoint that returns one boolean per section, derived from `count()` queries over the user's data in the requested range. BMI requires both a weight row AND a configured `heightCm`.

### Server-side filtering (Phase 3)

- `src/lib/doctor-report-data.ts` — `collectDoctorReportData()` now accepts `options.sections: Partial<DoctorReportPrefs>`. Privacy contract for mood: when `sections.mood === false`, the aggregator does NOT issue the `MoodEntry.findMany` at all. The data never leaves the DB row. Other sections (BP, weight, pulse, sleep, BMI, compliance) are stripped from the returned payload before render via the new `filterMeasurementKeys()` helper + section-specific clears.
- `src/app/api/doctor-report/route.ts` + `src/app/api/doctor-report/pdf/route.ts` — both endpoints parse `body.sections` through `doctorReportPrefsSchema`, default to documented defaults on drift, and forward to the aggregator. Audit log entries now include the rendered `sections` shape so a future privacy review can prove mood was never aggregated when the user opted out.
- `tests/integration/doctor-report-sections.test.ts` — 4 integration tests against the real testcontainer Postgres:
  1. `mood: false` → `data.mood === null` AND the rendered PDF (in DE + EN) does NOT contain "Stimmung" / "Mood".
  2. `mood: true` → mood data is fetched + returned.
  3. Every-toggle-off → `stats.WEIGHT/BLOOD_PRESSURE_SYS/etc.` all undefined, `compliance === {}`, `bmi === null`, `mood === null`.
  4. Omitted `sections` → documented defaults apply (mood OFF, everything else ON).

### i18n (Phase 4)

- `messages/en.json` + `messages/de.json` — appended `doctorReport.sections.{title, bp, weight, pulse, bmi, mood, moodSensitive, compliance, sleep, empty}` (no restructuring).
- `src/components/doctor-report/__tests__/doctor-report-dialog.test.tsx` — added a second i18n-contract assertion block covering all 10 new section-toggle keys in both locales.

## Verification (Phase 5)

| Check                                                        | Result                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                                             | exit 0                                                                                                                                                                                     |
| `pnpm lint`                                                  | clean — only 3 pre-existing unused-vars warnings in untouched files                                                                                                                        |
| Doctor-report unit tests (6 files, 65 tests)                 | all green                                                                                                                                                                                  |
| `tests/integration/doctor-report-sections.test.ts` (4 tests) | all green                                                                                                                                                                                  |
| Pre-existing `tests/integration/*.test.ts` (30 files)        | all green except 2 unrelated baseline failures (`coach-prefs` from concurrent W5/W7b coach work, `measurements-batch-delete` from a unique-constraint setup issue unrelated to my changes) |

### Unit-test baseline noise

The full `pnpm test` run shows 11 failures in `src/lib/ai/coach/__tests__/snapshot*.test.ts`. Confirmed pre-existing by `git stash` + re-run — these are concurrent-work breakage from the coach-snapshot pipeline (likely W5/W7b refactor not yet wired up). **Not caused by this phase.**

## Privacy-by-default contract (Marc's directive)

Mood data is **never** fetched when the toggle is off:

```ts
sections.mood
  ? prisma.moodEntry.findMany({
      where: { userId, moodLoggedAt: { gte: start, lte: end } },
    })
  : Promise.resolve([]);
```

The audit log records the `sections` shape on every report generation, so a future privacy review can prove mood was never aggregated. The integration test `mood: false → PDF does not contain "Stimmung"/"Mood"` is the executable proof.

## Conflict awareness

- **W7b** added `0044_mood_entry_tz_column` before this phase landed. We took `0045_doctor_report_prefs` cleanly.
- **W5** coach-panel + coach-prefs files: no shared file touched. The unrelated `coach-prefs` integration-test failure is pre-existing.
- **W6** dashboard/settings split: this phase only touches the export-section card body (the dialog submit handler), not any dashboard tile or settings save flow.
