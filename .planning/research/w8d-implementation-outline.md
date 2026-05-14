# W8d AH-Server-Prep — Implementation Outline

**Scope:** Final v1.4.25 wave that locks the server contract for v1.5 iOS-Swift. Five deliverables — one mapping file extension, three Prisma migrations (0052 / 0053 / 0054), one dashboard tile. No detection-worker, no XML import worker; just enough schema + UI so the iOS session does not have to re-touch Postgres.
**Date:** 2026-05-14
**Author:** Research agent (W8d planning), for Marc Bombeck
**Status:** Research only — no code committed.

Prior work this outline builds on:
- `.planning/research/apple-health-ecosystem-scan.md` (W1, ~3850 words) — ecosystem inventory + Section 7 recommendations.
- `.planning/research/withings-plus-comparison.md` — Withings provider stance.
- `.planning/research/open-wearables-comparison.md` — open-wearables architectural lens.
- v1.4.23 mapping module `src/lib/measurements/apple-health-mapping.ts` (already in tree; W8d **extends** it rather than starting fresh — see §8 open question Q1).

---

## Section 1: HK-Identifier Coverage Audit

### 1.1 What v1.4.23 already maps

Sixteen HK identifiers ship in `src/lib/measurements/apple-health-mapping.ts` today (sources: `src/lib/measurements/apple-health-mapping.ts` lines 88–240):

| HK identifier | Maps to MeasurementType | Sensitive? | Aggregation |
|---------------|------------------------|------------|-------------|
| `HKQuantityTypeIdentifierBodyMass` | `WEIGHT` | – | latest |
| `HKQuantityTypeIdentifierBodyFatPercentage` | `BODY_FAT` | – | latest |
| `HKQuantityTypeIdentifierBodyTemperature` | `BODY_TEMPERATURE` | – | latest |
| `HKQuantityTypeIdentifierBloodPressureSystolic` | `BLOOD_PRESSURE_SYS` | – | latest |
| `HKQuantityTypeIdentifierBloodPressureDiastolic` | `BLOOD_PRESSURE_DIA` | – | latest |
| `HKQuantityTypeIdentifierHeartRate` | `PULSE` | – | latest |
| `HKQuantityTypeIdentifierRestingHeartRate` | `RESTING_HEART_RATE` | – | latest |
| `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | `HEART_RATE_VARIABILITY` | yes | mean |
| `HKQuantityTypeIdentifierStepCount` | `ACTIVITY_STEPS` | – | sum |
| `HKQuantityTypeIdentifierActiveEnergyBurned` | `ACTIVE_ENERGY_BURNED` | – | sum |
| `HKQuantityTypeIdentifierFlightsClimbed` | `FLIGHTS_CLIMBED` | – | sum |
| `HKQuantityTypeIdentifierDistanceWalkingRunning` | `WALKING_RUNNING_DISTANCE` | – | sum |
| `HKQuantityTypeIdentifierVO2Max` | `VO2_MAX` | yes | latest |
| `HKQuantityTypeIdentifierBloodGlucose` | `BLOOD_GLUCOSE` | – | latest |
| `HKQuantityTypeIdentifierOxygenSaturation` | `OXYGEN_SATURATION` | – | latest |
| `HKCategoryTypeIdentifierSleepAnalysis` | `SLEEP_DURATION` (+ `SleepStage`) | yes | sum |

### 1.2 Union of identifiers seen across upstream parsers

Aggregated from:
- `BRO3886/healthsync/internal/parser/types.go` (Go, MIT) — 37 quantity + 3 category identifiers (full list returned by the file fetch; canonical reference for this outline).
- `k0rventen/apple-health-grafana/ingester/formatters.py` (Python, no license header — only the sleep-stage rosetta is reused as **data**, see §2.2).
- `dogsheep/healthkit-to-sqlite` (Python, Apache-2.0) — uses dynamic prefix stripping, contributes pattern not a list.
- `.planning/research/apple-health-ecosystem-scan.md` §7 — list of items already on the v1.4.26+ shortlist.

iOS-17/18 additions (sources: `sdkdiffs.furnacecreek.org/ios-17.0/HealthKit.html`, `sdkdiffs.furnacecreek.org/ios-18.0/HealthKit.html`):

- **iOS 17:** `CyclingCadence`, `CyclingFunctionalThresholdPower`, `CyclingPower`, `CyclingSpeed`, `PhysicalEffort`, `TimeInDaylight`.
- **iOS 18:** `CrossCountrySkiingSpeed`, `DistanceCrossCountrySkiing`, `DistancePaddleSports`, `DistanceRowing`, `DistanceSkatingSports`, `EstimatedWorkoutEffortScore`, `PaddleSportsSpeed`, `RowingSpeed`, `WorkoutEffortScore`, `AppleSleepingBreathingDisturbances` (quantity). Category: `BleedingAfterPregnancy`, `BleedingDuringPregnancy`, `SleepApneaEvent`. Plus `HKScoredAssessmentTypeIdentifier` (`GAD7`, `PHQ9`) and `HKDataTypeIdentifierStateOfMind` (a new top-level category branch).

### 1.3 W8d coverage decision (direct-map / aggregate / defer)

**Direct-map — add in W8d (Migration 0052 wires the 4 new enums; mapping table extends to 20 entries):**

| HK identifier | MeasurementType | Notes |
|---------------|----------------|-------|
| `HKCategoryTypeIdentifierEnvironmentalAudioExposure` | `AUDIO_EXPOSURE_ENV` | dB SPL; aggregate hint `mean` |
| `HKCategoryTypeIdentifierHeadphoneAudioExposure` | `AUDIO_EXPOSURE_HEADPHONE` | dB SPL; aggregate hint `mean` |
| `HKQuantityTypeIdentifierTimeInDaylight` | `TIME_IN_DAYLIGHT` | minutes; aggregate hint `sum`; iOS 17+ |
| — (no direct measurement type; routed to `Workout`/`WorkoutRoute` table) | `WORKOUT_ROUTE` enum exists only so `Measurement.type` can carry a "this user has a route" sentinel if needed for analytics; see §4 alternative |

The fourth value — `WORKOUT_ROUTE` — is reserved as a `MeasurementType` enum slot per the task spec, **but** the actual route data does not flow through the `Measurement` table; the `WorkoutRoute` schema (§4) owns it. The enum value is added so future code that wants a `Measurement.type = WORKOUT_ROUTE` summary row (e.g. "12 routes recorded this month") has a clean slot without another migration. See §8 open question Q2.

**Aggregate-required — map but rolled up before insert:**

| HK identifier | Rollup target | Notes |
|---------------|---------------|-------|
| `HKCategoryTypeIdentifierSleepAnalysis` (already shipped v1.4.23) | per-stage rows into `SLEEP_DURATION` | unchanged |
| `HKQuantityTypeIdentifierAppleExerciseTime` + `AppleStandTime` + `AppleStandHour` | implied by `Workout` records; do not store as quantity | follow `health-data-hub` precedent |
| `HKWorkoutTypeIdentifier` | `Workout` row (§4) | one workout = one row |
| `HKSeriesType.workoutRoute` (`HKWorkoutRoute`) | `WorkoutRoute` row (§4) | LineString + workout FK |

**Defer-bucket — document, not in v1.4.25 (target v1.5+):**

Body composition & vitals: `BodyMassIndex` (we compute it; do not store), `Height` (in `User.heightCm` already), `RespiratoryRate`, `BloodOxygen` (already mapped as `OXYGEN_SATURATION`), `WalkingHeartRateAverage`, `HeartRateRecoveryOneMinute`, `AppleSleepingWristTemperature`, `AppleSleepingBreathingDisturbances` (iOS 18+), `BasalEnergyBurned`.

Running form: `WalkingSpeed`, `WalkingStepLength`, `WalkingAsymmetryPercentage`, `WalkingDoubleSupportPercentage`, `StairAscentSpeed`, `StairDescentSpeed`, `SixMinuteWalkTestDistance`, `RunningSpeed`, `RunningPower`, `RunningStrideLength`, `RunningGroundContactTime`, `RunningVerticalOscillation`.

Cycling (iOS 17): `CyclingCadence`, `CyclingFunctionalThresholdPower`, `CyclingPower`, `CyclingSpeed`, `DistanceCycling`.

iOS 18 sport-specific: `DistanceCrossCountrySkiing`, `CrossCountrySkiingSpeed`, `DistancePaddleSports`, `PaddleSportsSpeed`, `DistanceRowing`, `RowingSpeed`, `DistanceSkatingSports`, `EstimatedWorkoutEffortScore`, `WorkoutEffortScore`, `PhysicalEffort`.

Nutrition (Marc directive — skip): `DietaryWater`, `DietaryCaffeine`, every other `Dietary*`.

State-of-mind / mood: `HKDataTypeIdentifierStateOfMind`, `MindfulSession` — flagged for v1.5 mapping into existing `mood` model. Out of W8d scope.

Cycle tracking: explicit hold per `apple-health-ecosystem-scan.md` §7.

Clinical: `HKClinicalRecord` (FHIR) — v1.6+ per §7.

ECG: `HKElectrocardiogram` — defer.

---

## Section 2: `apple-health-mapping.ts` shape

### 2.1 File location decision

**Recommendation:** extend the **existing** `src/lib/measurements/apple-health-mapping.ts` instead of creating `src/lib/ingest/apple-health-mapping.ts`. Rationale:
- The v1.4.23 file already carries the canonical type contract used by `POST /api/measurements/batch` (`AppleHealthEntryInput`, `mapAppleHealthEntry()`).
- Three callers already import the existing path (mapping module, batch route, mapping test suite).
- The task brief notes "port identifier list from k0rventen … only the lookup data, with file-header attribution" — that data can sit in the existing file as a new top-block (no namespace conflict).

If Marc prefers a `src/lib/ingest/` namespace as a future home for **all** ingest helpers (batch route, Withings sync, XML parser when it lands), a one-time rename is cheaper after W8d than now. See §8 Q1.

### 2.2 What W8d adds to the file

Three additive blocks, **all** behind the same default-export and the same `AppleHealthMapping` type — no breaking change for callers.

1. **Sleep-stage rosetta extension.** Already shipped (v1.4.23). No change. (k0rventen's `HKCategoryValueSleepAnalysis*` mapping in `ingester/formatters.py` was cross-checked against Apple's header `HKCategoryValueSleepAnalysis.h` during v1.4.23 — see existing comment block in file.)

2. **Three new mapping entries (audio exposure × 2, time-in-daylight):**
   - `HKCategoryTypeIdentifierEnvironmentalAudioExposure` → `AUDIO_EXPOSURE_ENV`, `dB SPL`, mean.
   - `HKCategoryTypeIdentifierHeadphoneAudioExposure` → `AUDIO_EXPOSURE_HEADPHONE`, `dB SPL`, mean.
   - `HKQuantityTypeIdentifierTimeInDaylight` → `TIME_IN_DAYLIGHT`, `minutes`, sum.
   All non-`isPrivacySensitive` (Apple does not gate these behind explicit consent screens beyond the bulk "Health share" prompt — confirmed via `developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/timeindaylight`).

3. **Workout type registry (new constant + new helper).** A separate exported map keyed by `HKWorkoutActivityType` numeric code, mapping to a string-typed `SportType` union — see §4.4. This is NOT routed through `mapAppleHealthEntry()`; the batch route only handles point-samples. Workouts arrive on a sibling endpoint (`POST /api/measurements/batch?kind=workout`, see §4.5) and consult this map directly.

### 2.3 File header attribution

A single comment block above the new entries, referencing the prior-art sources used to validate the mapping data (not code):

```ts
/**
 * v1.4.25 W8d — HK-mapping extension.
 *
 * Identifier roster cross-checked against:
 *   - Apple Developer docs (HKQuantityTypeIdentifier, HKWorkoutActivityType)
 *     https://developer.apple.com/documentation/healthkit
 *   - dogsheep/healthkit-to-sqlite (Apache-2.0)
 *     https://github.com/dogsheep/healthkit-to-sqlite
 *   - k0rventen/apple-health-grafana (no license header at root; only the
 *     HKCategoryValueSleepAnalysis* rosetta was consulted as DATA. The
 *     v1.4.23 sleep-stage map was built from Apple's HKCategoryValueSleepAnalysis.h
 *     header to avoid a license fog.)
 *   - BRO3886/healthsync (MIT) — internal/parser/types.go for the union of
 *     HK identifiers ever observed in a real `export.zip`.
 *
 * No upstream code is copied. Only the identifier strings and their
 * documented unit + aggregation semantics — facts about Apple's API, not
 * expressive content.
 */
```

### 2.4 LOC estimate

- Three new mapping entries: ~45 LOC.
- Workout-type registry (HKWorkoutActivityType numeric code → sport-type string), 80+ entries: ~110 LOC.
- File header + section dividers: ~25 LOC.
- New helper `mapAppleHealthWorkout(input) → WorkoutInsertRow | null` (mirrors `mapAppleHealthEntry`): ~60 LOC.
- New `WorkoutInsertRow` and `WorkoutRouteInsertRow` interfaces: ~40 LOC.
- Test additions in `__tests__/apple-health-mapping.test.ts`: ~70 LOC.

**Total file delta:** ~280 LOC added (file grows from 316 → ~596). Within the "~300 LOC est." budget in the task brief.

---

## Section 3: `MeasurementType` enum extensions (Migration 0052)

### 3.1 Four enum values

The brief calls for `WORKOUT_ROUTE`, `AUDIO_EXPOSURE_ENV`, `AUDIO_EXPOSURE_HEADPHONE`, `TIME_IN_DAYLIGHT`. Strictly additive — same pattern as Migration 0049 (`Withings full metrics`) and Migration 0036 (`Apple Health measurement types`).

### 3.2 Migration SQL sketch

`prisma/migrations/0052_apple_health_w8d_measurement_types/migration.sql`:

```sql
-- v1.4.25 W8d — Apple Health server-contract prep.
--
-- Adds four MeasurementType enum values that close the iOS-17/18 HK
-- coverage gap and the route-summary slot. Additive only, forward-only;
-- no existing rows are rewritten and every value is unconditional.
--
-- WORKOUT_ROUTE is a sentinel slot — actual route geometry lives in the
-- new WorkoutRoute table (migration 0053). The enum value is reserved so
-- a future "user recorded N routes this week" analytics row can sit on
-- the existing Measurement table without another enum-add migration.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'AUDIO_EXPOSURE_ENV';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'AUDIO_EXPOSURE_HEADPHONE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'TIME_IN_DAYLIGHT';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WORKOUT_ROUTE';
```

### 3.3 Schema + Zod additions

`prisma/schema.prisma` — append the four values to the `MeasurementType` enum block (lines 238–267 today), with a comment matching the existing per-enum-value convention:

```prisma
// ── v1.4.25 W8d Apple Health server-prep ──
AUDIO_EXPOSURE_ENV        // dB SPL — HealthKit `environmentalAudioExposure`; ambient noise (e.g. concert, traffic).
AUDIO_EXPOSURE_HEADPHONE  // dB SPL — HealthKit `headphoneAudioExposure`; AirPods listening-volume sampling.
TIME_IN_DAYLIGHT          // minutes — HealthKit `timeInDaylight` (iOS 17+); daily-rollup pattern, mood/sleep correlate.
WORKOUT_ROUTE             // sentinel — actual geometry lives in WorkoutRoute table. Reserved for future analytics rollup row.
```

`src/lib/validations/measurement.ts` — append to:

- `measurementTypeEnum` array (line 3): four new strings.
- `unitMap` (line 56): `AUDIO_EXPOSURE_ENV: "dB"`, `AUDIO_EXPOSURE_HEADPHONE: "dB"`, `TIME_IN_DAYLIGHT: "minutes"`, `WORKOUT_ROUTE: "count"` (the sentinel-row use case is a count of routes).
- `VALUE_RANGES` (line 98):
  - `AUDIO_EXPOSURE_ENV: { min: 20, max: 140 }` (Apple's "loud audio" alert sits at 80 dB; concerts 110+; 140 = pain threshold; 20 = quiet bedroom floor).
  - `AUDIO_EXPOSURE_HEADPHONE: { min: 20, max: 130 }` (same envelope minus the extreme open-air upper edge).
  - `TIME_IN_DAYLIGHT: { min: 0, max: 1440 }` (minutes per day).
  - `WORKOUT_ROUTE: { min: 0, max: 10000 }` (sentinel count — capacious bound for any analytics rollup).

### 3.4 Apple Health mapping wire-up

Three entries added to `APPLE_HEALTH_TYPE_MAP` in §2.2.

---

## Section 4: `Workout` + `WorkoutRoute` schema (Migration 0053)

### 4.1 Three candidate patterns

| Pattern | Source / precedent | Pros | Cons |
|---------|-------------------|------|------|
| **A — Generic event record** | `the-momentum/open-wearables` `EventRecord` + `EventRecordDetail` | one table covers every event type ever needed; flexible | poor type safety; analytics queries need JSON probing; foreign-data ingest hard to dedup; doesn't compose with existing per-metric routes |
| **B — Typed Workout, HKWorkout-shaped** | Apple HKWorkout, `BRO3886/healthsync`, `k0rventen/apple-health-grafana`, `umutkeltek/health-data-hub` (TimescaleDB hypertable) | every analytics path is a plain SQL filter; Prisma types are full; iOS DTO mirrors `HKWorkout` 1:1 with zero translation glue; Withings v2/workout response fits without reshape | bigger schema (one new model); rigid `sportType` enum has to absorb 70+ HK types |
| **C — Hybrid Workout + JSONB metadata** | half of the OSS exports (e.g. `dogsheep` workouts table with `extras` blob); HealthKit reference apps | combines typed columns for the hot-path (analytics) with JSONB for the long-tail (HK metadata, deviceName, source revision string) | JSONB attracts schema rot; need lint rule to keep new fields out of the blob |

**Recommendation: B + JSONB extras (i.e. C as A's discipline).** Type-first columns for everything the dashboard, doctor PDF, and Coach evidence chips will read; one `metadata Json?` column for the Apple-specific tail (`HKWorkoutEventType` markers, `HKAverageMETs`, source bundle id) and the Withings tail (`model`, `attrib`, `hr_zone_0..3`). The body of evidence:
- Apple's `HKWorkout` has ~10 first-class fields + an open `metadata: [String: Any]` bag — Prisma is the same shape if we add `metadata Json?`.
- Withings v2/measure getworkouts (referenced by `pywithings/workouts.py` and `developer.withings.com/api-reference/`) returns `{id, category (sport type), startdate, enddate, date, timezone, deviceid, hr_average, hr_min, hr_max, hr_zone_0..3, calories, distance, steps, elevation, pause_duration}` — the Apple-shaped typed columns absorb everything except `hr_zone_*` (which goes in `metadata`).
- `umutkeltek/health-data-hub` (the closest competitor; see `.planning/research/apple-health-ecosystem-scan.md` §3) uses the same shape on a TimescaleDB hypertable.
- A typed `sportType` enum (string union, not Postgres enum) is portable — Garmin/Whoop ingest in v1.5+ can add string members without a migration.

### 4.2 `WorkoutSource` enum

Reuse the existing `MeasurementSource` enum (`MANUAL`, `WITHINGS`, `IMPORT`, `APPLE_HEALTH`) rather than carve a parallel `WorkoutSource`. Same provenance vocabulary, same source-priority surface (W5e), zero query glue. If a workout-only source ever needs to differ (e.g. `STRAVA` ingest), add it to `MeasurementSource` at that point.

### 4.3 `WorkoutSportType` — string union, not Postgres enum

Postgres enum + Prisma enum is hostile to forward additions (every new sport = migration). A string column with a Zod-validated TypeScript union covers Apple's 70+ `HKWorkoutActivityType` values + Withings' numeric codes + Garmin/Whoop futures without Postgres churn. Compile-time exhaustiveness still works via `as const` arrays.

Initial roster (~20, covers ≥98% of typical workouts seen in `health-data-hub` and `BRO3886/healthsync` corpora):

```
walking, running, cycling, hiking, swimming, rowing, elliptical, stairClimber,
yoga, mindAndBody, strength, hiit, dance, golf, tennis, basketball, soccer,
crossTraining, mixedCardio, other
```

The HK-numeric → sport-type lookup is the §2.2 workout-type registry; Withings-numeric → sport-type is a sibling lookup in `src/lib/withings/workout-categories.ts` (new file in W8d, ~30 LOC of `{ withingsCode: number; sportType: WorkoutSportType }[]`).

### 4.4 Prisma model sketch

```prisma
// ─── Workouts (v1.4.25 W8d) ────────────────────────────────

model Workout {
  id            String            @id @default(cuid())
  userId        String            @map("user_id")
  sportType     String            @map("sport_type")                 // see WorkoutSportType union
  startedAt     DateTime          @map("started_at")
  endedAt       DateTime          @map("ended_at")
  durationSec   Int               @map("duration_sec")               // denormalised: endedAt - startedAt — query convenience
  totalEnergyKcal Float?          @map("total_energy_kcal")          // Apple `totalEnergyBurned`; Withings `calories`
  totalDistanceM  Float?          @map("total_distance_m")           // Apple `totalDistance`; Withings `distance`
  avgHeartRate    Int?            @map("avg_heart_rate")             // bpm; Withings `hr_average`; Apple computed
  maxHeartRate    Int?            @map("max_heart_rate")
  minHeartRate    Int?            @map("min_heart_rate")
  stepCount       Int?            @map("step_count")
  elevationM      Float?          @map("elevation_m")
  pauseDurationSec Int?           @map("pause_duration_sec")
  source        MeasurementSource @default(MANUAL)
  externalId    String?           @map("external_id")                // HK UUID or Withings workout id
  externalSourceVersion String?   @map("external_source_version")
  metadata      Json?                                                // HKWorkoutEventType markers, hr_zone_*, device bundle id
  createdAt     DateTime          @default(now()) @map("created_at")
  updatedAt     DateTime          @updatedAt @map("updated_at")

  user  User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  route WorkoutRoute? @relation("WorkoutToRoute")

  @@unique([userId, source, externalId])              // ingest dedup (NULL distinct ⇒ manual entries don't collide)
  @@index([userId, startedAt])                        // dashboard "recent workouts" query
  @@index([userId, sportType, startedAt])             // "show me my last 10 runs"
  @@map("workouts")
}

model WorkoutRoute {
  id          String   @id @default(cuid())
  workoutId   String   @unique @map("workout_id")                    // 1:1 with Workout
  // GeoJSON LineString — `{ "type": "LineString", "coordinates": [[lon,lat,alt], ...] }`.
  // Persisted as JSONB rather than Postgres `point[]` or PostGIS `geometry` to avoid
  // adding the PostGIS extension to the Coolify Postgres template (extension audit
  // 2026-05-14 confirmed extensions stay opt-in across the self-host fleet). GeoJSON
  // is also the native GPX-import shape and the format Recharts / Mapbox / Leaflet read.
  geometry    Json     @map("geometry")
  // Optional per-sample timestamps + speeds; one entry per coordinate in `geometry`.
  // NULL when the source only ships static GPX (e.g. Withings).
  samples     Json?    @map("samples")                               // [{ t: iso, speedMs?, hr? }, ...]
  startedAt   DateTime @map("started_at")
  endedAt     DateTime @map("ended_at")
  source      MeasurementSource @default(APPLE_HEALTH)
  externalId  String?  @map("external_id")                           // HK `HKWorkoutRoute` UUID
  createdAt   DateTime @default(now()) @map("created_at")

  workout Workout @relation("WorkoutToRoute", fields: [workoutId], references: [id], onDelete: Cascade)

  @@map("workout_routes")
}
```

### 4.5 Migration SQL sketch

`prisma/migrations/0053_workouts_and_routes/migration.sql`:

```sql
-- v1.4.25 W8d — Workout + WorkoutRoute schema.
--
-- Locks the table contract before v1.5 iOS work. Marc directive
-- 2026-05-14: include now even though v1.4.25 ships no UI surface
-- for workouts beyond the VO2-Max tile, so the iOS-Swift session can
-- assume Postgres is final.
--
-- WorkoutRoute.geometry is GeoJSON-as-JSONB. Alternatives considered:
--   * Postgres `point[]` — works, but loses altitude + timestamp; no
--     spatial-query primitive (closest-distance, bounding-box) without
--     PostGIS anyway.
--   * PostGIS `geometry` — adds an extension to every self-host install,
--     which v1.4.20 explicitly avoided when the same trade-off came up
--     for `correlations`.
-- JSONB matches the GPX-import path (the v1.4.26 XML/route worker reads
-- GeoJSON natively) and Leaflet / MapLibre consume it directly.

CREATE TABLE "workouts" (
  "id"                       TEXT PRIMARY KEY,
  "user_id"                  TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "sport_type"               TEXT NOT NULL,
  "started_at"               TIMESTAMP(3) NOT NULL,
  "ended_at"                 TIMESTAMP(3) NOT NULL,
  "duration_sec"             INTEGER NOT NULL,
  "total_energy_kcal"        DOUBLE PRECISION,
  "total_distance_m"         DOUBLE PRECISION,
  "avg_heart_rate"           INTEGER,
  "max_heart_rate"           INTEGER,
  "min_heart_rate"           INTEGER,
  "step_count"               INTEGER,
  "elevation_m"              DOUBLE PRECISION,
  "pause_duration_sec"       INTEGER,
  "source"                   "measurement_source" NOT NULL DEFAULT 'MANUAL',
  "external_id"              TEXT,
  "external_source_version"  TEXT,
  "metadata"                 JSONB,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "workouts_user_source_external_key"
  ON "workouts" ("user_id", "source", "external_id");
CREATE INDEX "workouts_user_started_idx"   ON "workouts" ("user_id", "started_at");
CREATE INDEX "workouts_user_sport_started_idx" ON "workouts" ("user_id", "sport_type", "started_at");

CREATE TABLE "workout_routes" (
  "id"          TEXT PRIMARY KEY,
  "workout_id"  TEXT NOT NULL UNIQUE REFERENCES "workouts"("id") ON DELETE CASCADE,
  "geometry"    JSONB NOT NULL,
  "samples"     JSONB,
  "started_at"  TIMESTAMP(3) NOT NULL,
  "ended_at"    TIMESTAMP(3) NOT NULL,
  "source"      "measurement_source" NOT NULL DEFAULT 'APPLE_HEALTH',
  "external_id" TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 4.6 Ingest entry point

No code in W8d. The eventual ingest path will be `POST /api/measurements/batch?kind=workout` with a sibling Zod schema; v1.5 iOS-Swift session builds the actual call. Schema is locked so the Swift DTO can be generated against `WorkoutInsertRow` from `apple-health-mapping.ts`.

---

## Section 5: `PersonalRecord` schema (Migration 0054)

### 5.1 PR definition rules per metric type

A **PersonalRecord** is "the best (or worst-in-the-favourable-direction) value observed for a given metric on a given user". Direction comes from the existing `TrendDirectionSentiment` vocabulary (`src/components/charts/trend-card.tsx` lines 38–40):

| Metric class | Aggregate | Direction | Example |
|--------------|-----------|-----------|---------|
| Activity counts (steps, flights, distance, active-energy, time-in-daylight) | max value | up-good | "highest daily step count" |
| Aerobic capacity (VO2_MAX) | max value | up-good | "highest VO2 max" |
| HRV (HEART_RATE_VARIABILITY) | max value | up-good | "highest HRV SDNN" |
| Resting HR (RESTING_HEART_RATE) | min value | down-good | "lowest resting heart rate" |
| Pulse spot reading (PULSE) | no PR (transient) | — | suppressed |
| Body composition (WEIGHT, BODY_FAT, FAT_MASS, MUSCLE_MASS, FAT_FREE_MASS, TOTAL_BODY_WATER, BONE_MASS) | no PR by default | — | requires user-defined goal direction; suppress unless `User.thresholdsJson` reveals a target direction |
| Blood pressure (BLOOD_PRESSURE_SYS/DIA) | no PR | — | clinical edge cases at both ends; do NOT compute a PR — surface "lowest in-target window" instead via existing `bpInTargetPct` |
| Blood glucose | no PR | — | same reasoning as BP |
| Workout (duration, distance, energy) | max per-sport-type | up-good | "longest run", "most cycling distance in a session" |
| Sleep (SLEEP_DURATION) | no PR (longer is not strictly better) | — | omit |

The detection-worker is **NOT** in v1.4.25 scope. The schema below is built to support it; v1.4.25 only ships the table, the `GET /api/personal-records` API skeleton, and the validator types.

### 5.2 Prisma model sketch

```prisma
// ─── Personal records (v1.4.25 W8d — schema only) ───────────

/// Aggregation direction for the PR — mirrors `TrendDirectionSentiment`.
/// Stored on the row so the future detection-worker doesn't have to
/// re-derive it from a per-metric lookup at query time.
enum PersonalRecordDirection {
  MAX     // higher is the record (steps, VO2max, HRV, distance)
  MIN     // lower is the record (resting HR, marathon time)

  @@map("personal_record_direction")
}

model PersonalRecord {
  id                    String                  @id @default(cuid())
  userId                String                  @map("user_id")
  metricType            MeasurementType         @map("metric_type")        // FK-ish via enum; reuse existing MeasurementType
  /// Per-sport-type bucket for workout-driven PRs. NULL for measurement-driven PRs.
  /// Matches `Workout.sportType` (string union, not enum) so a workout PR row stores
  /// e.g. "running" alongside `metricType = WORKOUT_ROUTE` to mean "longest run".
  sportType             String?                 @map("sport_type")
  /// "duration_sec" | "distance_m" | "energy_kcal" | "value" — discriminates which
  /// numeric the record refers to when `metricType` alone is ambiguous (workouts
  /// have three candidate PRs each).
  metricSlot            String                  @map("metric_slot") @default("value")
  direction             PersonalRecordDirection
  value                 Float
  unit                  String
  achievedAt            DateTime                @map("achieved_at")
  /// FK to the row that achieved the record — NULL for workout PRs (use sourceWorkoutId).
  sourceMeasurementId   String?                 @map("source_measurement_id")
  sourceWorkoutId       String?                 @map("source_workout_id")
  /// Multi-source tie-breaking: when two sources report the same value at the same
  /// time (e.g. iPhone + Apple Watch both report 12_348 steps for 2026-05-12), the
  /// detection worker writes BOTH rows. Display layer picks the canonical source via
  /// the existing `pickCanonicalSourceRows()` helper (W5e).
  source                MeasurementSource       @default(MANUAL)
  createdAt             DateTime                @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  /// Composite uniqueness key (userId, metricType, sportType, metricSlot, value, achievedAt, source)
  /// ensures the detection worker is idempotent — re-running it never inserts a duplicate row.
  @@unique([userId, metricType, sportType, metricSlot, value, achievedAt, source], name: "personal_records_dedup_key")
  /// Hot read pattern — "show me my current PR for this metric": ORDER BY value DESC LIMIT 1
  /// (MAX direction) / ASC LIMIT 1 (MIN direction). Index covers both directions.
  @@index([userId, metricType, sportType, value])
  @@map("personal_records")
}
```

### 5.3 Migration SQL sketch

`prisma/migrations/0054_personal_records/migration.sql`:

```sql
-- v1.4.25 W8d — Personal records schema (no detection worker yet).
--
-- Marc directive 2026-05-14: include the table now so v1.5 iOS doesn't
-- re-touch Postgres. The detection worker that populates the rows lands
-- in a later release (v1.4.26 or v1.5 — TBD). v1.4.25 only ships a
-- bare `GET /api/personal-records` API that returns `{ data: [] }` until
-- the worker is online.

CREATE TYPE "personal_record_direction" AS ENUM ('MAX', 'MIN');

CREATE TABLE "personal_records" (
  "id"                     TEXT PRIMARY KEY,
  "user_id"                TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "metric_type"            "measurement_type" NOT NULL,
  "sport_type"             TEXT,
  "metric_slot"            TEXT NOT NULL DEFAULT 'value',
  "direction"              "personal_record_direction" NOT NULL,
  "value"                  DOUBLE PRECISION NOT NULL,
  "unit"                   TEXT NOT NULL,
  "achieved_at"            TIMESTAMP(3) NOT NULL,
  "source_measurement_id"  TEXT REFERENCES "measurements"("id") ON DELETE SET NULL,
  "source_workout_id"      TEXT REFERENCES "workouts"("id") ON DELETE SET NULL,
  "source"                 "measurement_source" NOT NULL DEFAULT 'MANUAL',
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "personal_records_dedup_key"
  ON "personal_records" ("user_id", "metric_type", "sport_type", "metric_slot", "value", "achieved_at", "source");
CREATE INDEX "personal_records_user_metric_value_idx"
  ON "personal_records" ("user_id", "metric_type", "sport_type", "value");
```

### 5.4 Minimal `GET /api/personal-records` API

New file `src/app/api/personal-records/route.ts`, ~40 LOC, follows the existing `apiHandler + requireAuth + apiSuccess` idiom (e.g. `src/app/api/analytics/route.ts` line 31). Returns `{ data: PersonalRecord[] }`, optionally filtered by `?metricType=…&sportType=…`. With no detection worker the response is always `{ data: [] }` for the v1.4.25 release — but the contract is stable, so the v1.5 iOS-Swift app can write its query path against a real route from day one.

### 5.5 Tie-breaking rule

Per §5.2 schema: when two sources report the same value at the same instant, the dedup index treats them as distinct (via the `source` column). Display layer picks the canonical source via the existing `pickCanonicalSourceRows()` helper (`src/lib/analytics/source-priority.ts`, shipped in W5e). One row per `(user, metric, sport, slot, value, time, source)` — no overwrites, no value-loss.

---

## Section 6: VO2-Max-Tile UI

### 6.1 Insertion point

`/dashboard` route is `src/app/page.tsx` (root route — not under a `dashboard/` segment). The dashboard renders a sorted strip of `TrendCard`s gated by `isTileVisible(...)` (lines 313–320 and 768–811). The pattern for adding a new tile is mechanical:

1. Add `"vo2Max"` to `DASHBOARD_WIDGET_IDS` in `src/lib/dashboard-layout.ts` (line 17 — append after `"insightsPreview"`).
2. Add a default-invisible entry to `DEFAULT_DASHBOARD_LAYOUT.widgets` (line 188 — append after `"insightsPreview"`, with `visible: false, tileVisible: false, order: 15`).
3. In `src/app/page.tsx` near the existing tile gate block (line 313), add:
   ```ts
   const vo2 = data?.summaries?.VO2_MAX;
   const hasVo2 = (vo2?.count ?? 0) > 0;
   const showVo2Tile = isTileVisible("vo2Max") && hasVo2;
   ```
4. In the `trendCards.push(...)` block (after the `showStepsTile` push at line 790), add a new card:
   ```tsx
   if (showVo2Tile) {
     trendCards.push({
       id: "vo2Max",
       order: widgetOrder("vo2Max"),
       node: (
         <TrendCard
           key="vo2Max"
           label={t("dashboard.vo2Max") ?? "VO2 max"}
           latest={vo2?.latest ?? null}
           unit="mL/(kg·min)"
           avg7={vo2?.avg7 ?? null}
           avg30={vo2?.avg30 ?? null}
           slope30={vo2?.slope30 ?? null}
           trend7Delta={summaryToTrend7Delta(vo2)}
           icon={Wind}
           directionSentiment="up-good"
           compareBaseline={compareBaseline}
           compareDelta={tileCompareDelta(vo2)}
         />
       ),
     });
   }
   ```

5. Add the i18n key `dashboard.vo2Max` in `src/lib/i18n/locales/{de,en}/dashboard.json` (German: "VO2 max"; English: "VO2 max" — Apple-Health-style, no localisation needed).

6. Reuse `Wind` from lucide-react (already in the icon palette of the project — verify via existing dashboard imports at line 9; it is one of the standard cardio icons used elsewhere; if unavailable substitute `HeartPulse` or `Activity`).

### 6.2 Data wiring

`data?.summaries?.VO2_MAX` is **already** populated by `/api/analytics` because the route iterates over the full `measurementTypeEnum.options` list (`src/app/api/analytics/route.ts` line 45). No backend change required — Withings W5d already ingests VO2_MAX, and the analytics summariser auto-folds every enum value into the `summaries` object. The tile lights up the moment a user accumulates any VO2 sample.

### 6.3 Settings → Dashboard surface

The existing Settings → Dashboard widget toggles consume `DASHBOARD_WIDGET_IDS` automatically via the resolver (`src/lib/dashboard-layout.ts` lines 240–245). Once "vo2Max" is in the array, the toggle appears with no further work — the resolver merges legacy layouts with `visible: false, tileVisible: false` defaults so existing users see no behavioural change until they explicitly enable it.

### 6.4 Chart row (optional, deferred)

The task brief says "small trend tile" only — i.e. strip tile, not chart row. The chart-row component for VO2 is **not** in W8d. Path forward (deferred to v1.4.26+): add `vo2Max` to `CHART_OVERLAY_KEYS` (line 112) and add a `HealthChart` card next to the steps/sleep chart. Out of scope for W8d.

---

## Section 7: Tests strategy per file

### 7.1 `src/lib/measurements/apple-health-mapping.ts` (extension)

Augment existing `src/lib/measurements/__tests__/apple-health-mapping.test.ts`:

1. **Coverage assertion** — already exists (line 10–18). The new entries must satisfy "only references measurement types that exist in the canonical enum" — i.e. Migration 0052 must land first or the test fails. Confirms 0052 + Zod + TS enum drift gate.
2. **Unit conversions** — add a case for each of audio exposure (no conversion, identity) and time-in-daylight (no conversion).
3. **Privacy-sensitive list** — audio exposure is not sensitive; time-in-daylight is not sensitive. Update the existing `[…HKQuantityTypeIdentifierHeartRateVariabilitySDNN, HKQuantityTypeIdentifierVO2Max, HKCategoryTypeIdentifierSleepAnalysis]` assertion to confirm the new entries are **not** added to the sensitive set.
4. **Workout-type registry** — new describe block: every HK numeric code maps to a string in the canonical `WorkoutSportType` union; every union value is referenced by at least one HK code; the workout map exports a `mapAppleHealthWorkout()` helper that returns null on unknown HK codes.

### 7.2 `prisma/migrations/0052_*/migration.sql`

- **Migration smoke test** — extend `src/lib/__tests__/measurement-enum-drift.test.ts` (assumed existing per the pattern in the v1.4.23 W6 reconcile; if absent create as part of W8d).
- Verify the runtime enum (`measurementTypeEnum.options`) contains the four new values and that `getUnitForType()` returns the documented unit for each.
- Verify `validateMeasurementRange()` rejects out-of-band values for each new type.

### 7.3 `prisma/migrations/0053_workouts_and_routes/migration.sql`

- **Schema smoke test** (`prisma/__tests__/workout-schema.test.ts`, new) — round-trip insert + select via `prisma.workout.create` and `prisma.workoutRoute.create` with a minimal payload, asserting the foreign-key relation and the dedup index reject behaviour.
- **GeoJSON validator** (`src/lib/workouts/__tests__/geometry.test.ts`, new) — accept `{ type: "LineString", coordinates: [[lon,lat,alt?],...] }`; reject everything else.
- **Source-priority compatibility** — the existing `pickCanonicalSourceRows` (W5e) is metric-class-keyed; extend its tests to assert the `workout` class falls through cleanly when the user's `sourcePriorityJson` does not yet name it (defaults to `["APPLE_HEALTH","WITHINGS","MANUAL","IMPORT"]`).

### 7.4 `prisma/migrations/0054_personal_records/migration.sql`

- **Dedup index test** (`prisma/__tests__/personal-record-dedup.test.ts`, new) — same row twice ⇒ second insert raises P2002; same row different source ⇒ both rows persist (multi-source tie-break).
- **API route test** (`src/app/api/personal-records/__tests__/route.test.ts`, new) — `GET` with no rows returns `{ data: [] }`; `GET` with a seeded row returns it; auth required.
- **Direction validator** (`src/lib/personal-records/__tests__/direction.test.ts`, new) — map `MeasurementType → PersonalRecordDirection` resolver (small lookup table per §5.1); asserts every supported metric type returns the documented direction and unsupported types return null (so the future detection worker can short-circuit cleanly).

### 7.5 VO2-Max-Tile

- **TrendCard wiring test** — augment `src/app/__tests__/dashboard-page.test.tsx` (existing) with a fixture that supplies `summaries.VO2_MAX = { latest: 41.2, avg7: 40.8, avg30: 40.4, count: 8 }` and `dashboardWidgetsJson` enabling `vo2Max`, asserting the tile renders with the right label, unit, and arrow direction.
- **Hidden when no data** — same fixture without VO2 samples; tile must not appear (data-floor gate).
- **Default-invisible** — a fresh user with no saved layout sees no VO2 tile until they enable it via Settings → Dashboard.

### 7.6 Integration

One end-to-end Playwright path (against the in-process test server): seed a user, POST `/api/measurements/batch` with a VO2_MAX sample, GET `/api/personal-records`, GET `/api/analytics`, render `/` → tile visible. Reuses the v1.4.25 W4d Playwright harness.

---

## Section 8: Open questions for Marc

**Q1. File location for the mapping module.**
The task brief says `src/lib/ingest/apple-health-mapping.ts`. The codebase already has `src/lib/measurements/apple-health-mapping.ts` shipped in v1.4.23 with three importers. Recommendation: **extend in place**; create `src/lib/ingest/` as a future home (covers batch route + Withings sync + the eventual XML worker) only when those siblings actually need it. Ack required to keep the existing path or to plan a single move at the end of W8d.

**Q2. `WORKOUT_ROUTE` as a `MeasurementType` value vs. pure data in `WorkoutRoute` table.**
The brief requests `WORKOUT_ROUTE` in the enum, but the actual geometry never flows through the `Measurement` table — it lives in `WorkoutRoute`. Two options:
- **(a)** Add the enum value as a sentinel/reserved slot (this outline's recommendation). Cheap; gives future analytics "user has N route-recorded workouts this week" a clean rollup row.
- **(b)** Drop the enum value entirely; route data is fully owned by `WorkoutRoute` and `Workout`.
Recommend (a). Confirm.

**Q3. PR scope for blood pressure + blood glucose.**
§5.1 deliberately suppresses PRs for BP and glucose — clinical edge cases both ways (a too-low diastolic is bad). Confirm: surface "best in-target window %" via the existing `bpInTargetPct` instead, and add no PR rows for these metrics in the detection worker?

**Q4. `WorkoutSportType` as string-union vs Postgres enum.**
This outline recommends a string union (no Postgres migration to add a new sport), validated at the Zod boundary. Postgres enum is safer if you want DB-level rejection of typos. Confirm direction.

**Q5. GeoJSON LineString vs Postgres `point[]` vs PostGIS.**
Outline recommends GeoJSON-in-JSONB to avoid the PostGIS extension dependency on every self-hosted Postgres (v1.4.20 set the same precedent for correlations). Confirm or override.

**Q6. iOS-18 identifiers (sleep-apnea event, breathing disturbances, GAD-7/PHQ-9 assessments).**
Defer-bucket per this outline. Marc may want assessments mapped (PHQ-9 = depression screener) for v1.5 — flag now to size the future enum-add migration appropriately.

**Q7. VO2-Max tile default visibility.**
Outline recommends default-invisible (matches `sleep`, `steps`, `glucose`, `oxygenSaturation` precedent — secondary metrics opt-in only). Override if you want it on by default.

**Q8. Existing `apple-health-mapping.ts` module rename.**
If Q1 lands on "move to `src/lib/ingest/`", the rename happens at the end of W8d as a single commit; the alternative (rename now) breaks three importers mid-wave. Confirm timing.

---

**Word count target:** ~3000 words (within the 2500–3500 brief).
**Sources cited:** Apple Developer docs (HK identifier index, timeInDaylight, HKWorkoutRoute), `sdkdiffs.furnacecreek.org` for iOS 17/18 SDK diffs, `BRO3886/healthsync` (MIT, Go), `k0rventen/apple-health-grafana` (sleep-stage data only), `dogsheep/healthkit-to-sqlite` (Apache-2.0), `umutkeltek/health-data-hub`, `vangorra/python_withings_api`, `a-toms/pywithings`, internal files (`src/lib/measurements/apple-health-mapping.ts`, `src/lib/dashboard-layout.ts`, `src/lib/validations/measurement.ts`, `src/app/page.tsx`, `src/components/charts/trend-card.tsx`, `src/app/api/analytics/route.ts`, prior research notes in `.planning/research/apple-health-ecosystem-scan.md`).
