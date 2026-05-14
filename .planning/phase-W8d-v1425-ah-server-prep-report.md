# W8d v1.4.25 — AH-Server-Prep — Phase Report

**Phase:** v1.4.25 Wave 8d — Apple Health server-contract prep before
the v1.5 iOS-Swift session.
**Branch:** `develop`
**Date:** 2026-05-14
**Status:** Shipped (six atomic commits).

---

## Scope summary

Five sub-tasks delivering the server contract the iOS-Swift session
needs to be able to assume Postgres is final:

1. **8d.1** — Migration 0052 + MeasurementType enum extension
   (`AUDIO_EXPOSURE_ENV`, `AUDIO_EXPOSURE_HEADPHONE`,
   `TIME_IN_DAYLIGHT`). Three new values rather than the brief's four —
   see "Orchestrator decisions restated" below.
2. **8d.2** — `apple-health-mapping.ts` extension: three new mapping
   entries, a derived compact lookup, a curated deferred set, and
   MIT/Apache-2.0 attribution header.
3. **8d.3** — Migration 0053 + `Workout` + `WorkoutRoute` schema for
   HKWorkout passthrough; Zod boundary in `src/lib/validations/workout.ts`.
4. **8d.4** — Migration 0054 + `PersonalRecord` schema + direction
   helper + `GET /api/personal-records` (no write endpoint, no
   detection worker — explicitly v1.4.26 scope).
5. **8d.5** — VO2 max trend tile on `/`, opt-in via Settings →
   Dashboard.

---

## Commits (in order)

| SHA       | Title                                                                                         |
|-----------|-----------------------------------------------------------------------------------------------|
| `41ba79b` | feat(schema): extend MeasurementType with audio-exposure + time-in-daylight (Migration 0052) |
| `6a7da4b` | fix(i18n): backfill audio-exposure + time-in-daylight + comparison hint keys                  |
| `c05292f` | feat(ingest): port HK identifier mapping from k0rventen + dogsheep with MIT/Apache-2.0 attribution |
| `5d6f0c3` | feat(schema): Workout + WorkoutRoute tables for HKWorkout passthrough (Migration 0053)       |
| `8f57f5e` | feat(schema): PersonalRecord + direction helper (Migration 0054)                              |
| `b324e6c` | feat(dashboard): VO2 max trend tile (opt-in, secondary-metric pattern)                        |

(`6a7da4b` is a fix-up for `41ba79b` — the original commit ran an
in-flight locale sync between my edit and the actual commit, leaving the
six locale files unchanged. The follow-up commit closes the gap.)

---

## Files changed

### Schema + migrations

- `prisma/migrations/0052_apple_health_enum_extensions/migration.sql`
  (NEW) — three `ALTER TYPE … ADD VALUE`.
- `prisma/migrations/0053_workout_and_route/migration.sql` (NEW) — two
  tables, three indexes, one composite unique.
- `prisma/migrations/0054_personal_record/migration.sql` (NEW) — one
  enum, one table, dedup unique + value index, FK to Measurement with
  `ON DELETE SET NULL`.
- `prisma/schema.prisma` — `MeasurementType` enum +3 values; `Workout`
  + `WorkoutRoute` models; `PersonalRecordDirection` enum +
  `PersonalRecord` model; `User.workouts` and `User.personalRecords`
  relations.

### Code

- `src/lib/measurements/apple-health-mapping.ts` — three new mapping
  entries, `HK_QUANTITY_TYPE_TO_MEASUREMENT` derived view,
  `HK_QUANTITY_TYPE_DEFERRED` set covering iOS-17/18 long-tail,
  attribution block.
- `src/lib/validations/measurement.ts` — enum + `unitMap` +
  `VALUE_RANGES` entries for the three new types.
- `src/lib/insights/chart-tokens.ts` — three new
  `metric:<TYPE>` allow-list entries + orphan-enum stripper coverage.
- `src/components/measurements/measurement-list-meta.ts` — label / icon
  / color entries for the three new types
  (`Volume2` / `Headphones` / `Sun`).
- `src/lib/validations/workout.ts` (NEW) —
  `workoutSportTypeEnum` (20 members), `geoJsonLineStringSchema`,
  `workoutRouteSamplesSchema`, `createWorkoutSchema`.
- `src/lib/personal-records/pr-direction.ts` (NEW) — `getPRDirection`
  exhaustive switch + `isPRTrackable` predicate.
- `src/app/api/personal-records/route.ts` (NEW) — GET list endpoint,
  optional `?metricType=` filter, loose-typed graceful drop.
- `src/lib/dashboard-layout.ts` — `vo2Max` widget id + default-invisible
  layout entry.
- `src/app/page.tsx` — VO2 summary derivation, data-floor gate, tile
  render with `Gauge` icon and up-good sentiment.
- `src/components/settings/dashboard-layout-section.tsx` — `vo2Max`
  label key wired so the toggle row picks it up.

### Translations

- `messages/en.json` — `dashboard.vo2Max` / `vo2MaxUnit` and
  `measurements.typeAudioExposureEnv` /
  `typeAudioExposureHeadphone` / `typeTimeInDaylight` (translated).
- `messages/de.json` — same keys (German translations).
- `messages/fr.json` / `es.json` / `it.json` / `pl.json` — same keys,
  English placeholders matching the W5d convention; locale build
  script can refresh on the next pass.

### Tests (delta: +29 tests, full suite now 2606 passing)

- `src/lib/__tests__/measurement-type-enum-coverage.test.ts` — 25 → 28
  canonical types; PDF_VITAL_EXCLUSIONS gained three entries under the
  existing v1.5 clinical-layout gate.
- `src/lib/measurements/__tests__/apple-health-mapping.test.ts` —
  exhaustiveness assertion, deferred-vs-mapped dedup,
  identity-conversion check, `HK_QUANTITY_TYPE_TO_MEASUREMENT` parity.
- `src/lib/validations/__tests__/workout.test.ts` (NEW) — 13 tests
  covering sport-type rejection, GeoJSON validation (Point /
  single-point / OOB), route-sample edge cases, and full Apple-Health
  payload acceptance.
- `src/lib/personal-records/__tests__/pr-direction.test.ts` (NEW) —
  drift-guard + per-bucket membership.
- `src/app/api/personal-records/__tests__/route.test.ts` (NEW) — 401
  unauth, empty response, filter passthrough, unknown-filter graceful
  drop, seeded-record round-trip.

---

## Quality gates

| Gate         | Status |
|--------------|--------|
| `pnpm typecheck` | Clean |
| `pnpm lint`      | Clean |
| `pnpm test` (full suite) | 2606 passed / 1 skipped / 0 failed |
| `npx prisma validate`    | Clean |
| `pnpm prisma generate`   | Clean |

No `--no-verify`, no skipped hooks, no `Co-Authored-By: Claude` trailer,
no `git amend`.

---

## Orchestrator decisions restated

The brief listed **four** new `MeasurementType` enum values. We landed
**three**. The fourth — `WORKOUT_ROUTE` — was dropped per the
orchestrator's "Decisions already made" table. Rationale:

- Workouts are first-class entities with their own table (`Workout`)
  shipped in Migration 0053; route geometry lives in `WorkoutRoute`
  (1:1 FK to Workout).
- Apple HealthKit itself separates `HKWorkout` from `HKQuantitySample`
  — there is no quantity sample for "this is a route".
- Reserving a sentinel `MeasurementType` value that no real
  `Measurement` row will ever take would be a dead slot for analytics
  (`/api/analytics` iterates `measurementTypeEnum.options`), the doctor-
  PDF allow-list, and the chart-token registry.
- If a future analytics row genuinely needs to be carried on the
  `Measurement` table ("user recorded N routes this week" rollup), it
  lives in a clean, single-purpose enum value at that point; no
  forward-compatibility loss.

The other orchestrator decisions held — extending in place over
creating a new `src/lib/ingest/` namespace, GeoJSON LineString in JSONB
over PostGIS, string-union sport types over a Postgres enum, VO2
default-invisible, BP / glucose excluded from PersonalRecord direction
helper.

---

## Deferred items (explicit v1.4.26+ scope)

- **PersonalRecord detection worker.** Migration 0054 lands the table
  + the direction helper; the sweep-on-insert / nightly job that
  writes actual PR rows is intentionally not in W8d. The
  `GET /api/personal-records` endpoint exists today and returns
  whatever rows the DB carries — empty for every user until the worker
  ships in v1.4.26 or v1.5.
- **VO2 max chart row.** W8d.5 ships only the tile-strip surface. The
  matching chart card lands alongside the iOS-app body-composition
  sub-page in v1.5 per the W8d outline §6.4.
- **Workout ingest endpoint.** `POST /api/measurements/batch?kind=workout`
  is not in v1.4.25. The schema + the Zod boundary
  (`src/lib/validations/workout.ts`) are locked so the iOS-Swift DTO
  generator and the v1.4.26 XML/Strava worker target the same shape.
- **iOS-18 long-tail mappings.** Sleep apnea, scored assessments
  (GAD-7 / PHQ-9), running form, paddle / row / ski distances + speeds,
  pregnancy / cycle, FHIR clinical — all captured in
  `HK_QUANTITY_TYPE_DEFERRED` with their planned-release windows
  inline.

---

## Notes for Marc

1. Two of the six commits in this wave landed back-to-back with an
   in-flight locale-bundle sync; `6a7da4b` is the fix-up for
   `41ba79b`'s missing message keys. Net result is the same; the diff
   is just split across two commits.
2. A parallel agent's W9f hot-fix commit (`89fb3bc`) landed between
   mine and is independent — planning-doc only, no overlap with W8d
   surfaces.
3. The locale-bundle build script
   (`scripts/i18n/build-locale.py`) should be re-run before tagging
   v1.4.25 — the four English-placeholder entries we added to FR / ES /
   IT / PL can be picked up by the common-vocab pass.
4. No `metric:VO2_MAX` chart-row support yet; the AI Coach can
   reference `metric:VO2_MAX` in prose (allow-list extended in W5d)
   but the renderer will not mount a chart for it until v1.5.
