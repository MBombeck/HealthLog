---
file: 04-data-model.md
purpose: Prisma schema reference for the v1.5 iOS client — enums, models, migrations 0051-0060, relations.
when_to_read: Before generating any DTO; before touching any ingest path; whenever an API field shape is unclear.
prerequisites: 02-server-architecture.md (skim), 02-server-architecture.md § Database (Prisma section).
estimated_tokens: 6800
version_anchor: v1.4.25 / sha 49f71c92
---

# Data Model — v1.4.25

> **TL;DR.** Postgres 16, Prisma 7, snake_case columns / camelCase client.
> Eight new enums and six new tables landed in v1.4.25 to make the iOS
> session a config-only change, not a schema change. `Measurement` is
> the one model the iOS app writes the most rows to; everything else
> hangs off `User` via `onDelete: Cascade`.

---

## 1. Conventions

| Concern | Rule |
| --- | --- |
| Column case | snake_case in SQL, camelCase in Prisma client (every column carries `@map`) |
| Primary key | `cuid()` — opaque string, NOT auto-increment |
| Timestamps | `created_at` + `updated_at` on every mutable row |
| Soft delete | None — `onDelete: Cascade` from `User` cleans up via FK |
| External-system id | `external_id TEXT` + composite unique `(user_id, type, source, external_id)`; Postgres NULL-distinct so manual rows never collide here |
| Enums | Postgres native enum where churn is rare; TEXT where the long tail will grow (sport types, device classes) |

**STOP HERE if** you came looking for legacy v1.4.24 columns — every
column on this page exists on `main` at sha `49f71c92`. Pre-v1.4.25
rows survive every migration (additive-only DDL); the iOS DTO does
not need to handle a "schema version" header.

---

## 2. Enums the iOS app touches

### 2.1 `MeasurementType` (Postgres enum `measurement_type`)

Single source of truth for the metric axis. iOS DTO mirrors **every
spelling exactly** — `APPLE_HEALTH`, not `HEALTHKIT`.

| Value | Unit canonical | HK identifier | Withings type | Notes |
| --- | --- | --- | --- | --- |
| `WEIGHT` | kg | `bodyMass` | 1 | — |
| `BLOOD_PRESSURE_SYS` | mmHg | `bloodPressureSystolic` | 9 | Pair with `_DIA` for one BP reading |
| `BLOOD_PRESSURE_DIA` | mmHg | `bloodPressureDiastolic` | 10 | — |
| `PULSE` | bpm | `heartRate` | 11 | Spot pulse; distinct from RHR |
| `BODY_FAT` | % | `bodyFatPercentage` | 6 | — |
| `SLEEP_DURATION` | **minutes** | `sleepAnalysis` (per stage) | (Sleep v2) | v1.4.23 shifted hours→minutes so HK category samples survive |
| `ACTIVITY_STEPS` | count | `stepCount` | (activity) | Cumulative daily rollup pattern |
| `BLOOD_GLUCOSE` | mg/dL | `bloodGlucose` | 60 | Display unit (`mg/dL` \| `mmol/L`) is user preference |
| `TOTAL_BODY_WATER` | kg | — | 77 | Withings hydration |
| `BONE_MASS` | kg | — | 88 | Withings |
| `OXYGEN_SATURATION` | % (0..100) | `oxygenSaturation` | 54 | HK ships fraction 0..1 — iOS DTO **must multiply by 100** before POST |
| `HEART_RATE_VARIABILITY` | ms | `heartRateVariabilitySDNN` | — | v1.4.23 |
| `RESTING_HEART_RATE` | bpm | `restingHeartRate` | — | v1.4.23 |
| `ACTIVE_ENERGY_BURNED` | kcal | `activeEnergyBurned` | — | v1.4.23 |
| `FLIGHTS_CLIMBED` | count | `flightsClimbed` | — | v1.4.23 |
| `WALKING_RUNNING_DISTANCE` | m (SI) | `distanceWalkingRunning` | — | v1.4.23 |
| `VO2_MAX` | mL/(kg·min) | `vo2Max` | — | v1.4.23 |
| `BODY_TEMPERATURE` | °C | `bodyTemperature` | — | v1.4.23 |
| `FAT_FREE_MASS` | kg | — | 5 | v1.4.25 W5d |
| `FAT_MASS` | kg | — | 8 | v1.4.25 W5d |
| `MUSCLE_MASS` | kg | — | 76 | v1.4.25 W5d |
| `SKIN_TEMPERATURE` | °C | — | 73 | **NOT** body-temp; surface temps ~32 °C |
| `PULSE_WAVE_VELOCITY` | m/s | — | 91 | v1.4.25 W5d |
| `VASCULAR_AGE` | years | — | 155 | v1.4.25 W5d |
| `VISCERAL_FAT` | rating (1-12) | — | 170 | Not a percent |
| `AUDIO_EXPOSURE_ENV` | dBA SPL | `environmentalAudioExposure` | — | v1.4.25 W8d |
| `AUDIO_EXPOSURE_HEADPHONE` | dBA SPL | `headphoneAudioExposure` | — | v1.4.25 W8d |
| `TIME_IN_DAYLIGHT` | minutes | `timeInDaylight` | — | v1.4.25 W8d (iOS 17+) |

**Since v1.4.24:** `FAT_FREE_MASS`, `FAT_MASS`, `MUSCLE_MASS`,
`SKIN_TEMPERATURE`, `PULSE_WAVE_VELOCITY`, `VASCULAR_AGE`,
`VISCERAL_FAT`, `AUDIO_EXPOSURE_ENV`, `AUDIO_EXPOSURE_HEADPHONE`,
`TIME_IN_DAYLIGHT` are new.

### 2.2 `MeasurementSource` (`measurement_source`)

```
MANUAL | WITHINGS | IMPORT | APPLE_HEALTH
```

Spelled `APPLE_HEALTH`, not `HEALTHKIT`. The iOS app submits this
exact string in every batch entry's `source`.

### 2.3 `GlucoseContext` (`glucose_context`)

```
FASTING | POSTPRANDIAL | RANDOM | BEDTIME
```

NON-NULL only when `Measurement.type = BLOOD_GLUCOSE`. NULL for every
other row. Affects which target range applies — never used for
charting buckets.

### 2.4 `SleepStage` (`sleep_stage`) — v1.4.23

Per-stage label for `HKCategoryValueSleepAnalysis`:

```
IN_BED | AWAKE | ASLEEP | REM | CORE | DEEP
```

`ASLEEP` is the iOS 15- legacy `asleepUnspecified` bucket. NON-NULL
only when `type = SLEEP_DURATION`. **One night → ~5 rows**, one per
stage, all sharing `measuredAt`; the W17b unique-index extension
keeps them distinct (see Migration 0055).

### 2.5 `MeasurementDeviceType` — TEXT, not a Postgres enum

Stored on `Measurement.deviceType` (nullable TEXT). Canonical values
documented in `src/lib/validations/source-priority.ts` `deviceTypeEnum`:

```
watch | band | ring | phone | scale | other | unknown
```

Free-text at the SQL layer so a new device class lands as a Zod
refinement rather than a coordinated client + server enum bump. iOS
maps `HKDevice.model` to one of these classes; pre-v1.4.25 rows stay
NULL and are read as `unknown` by the picker.

### 2.6 `IntakeSource` (`intake_source`)

```
WEB | API | REMINDER | IMPORT
```

Stamped on `MedicationIntakeEvent`. iOS POSTing through the public
intake endpoint lands as `API`.

### 2.7 `InjectionSite` (`injection_site`) — v1.4.25 W4d

GLP-1-only. 8 zones for the body-map picker:

```
ABDOMEN_LEFT | ABDOMEN_RIGHT
ABDOMEN_UPPER_LEFT | ABDOMEN_UPPER_RIGHT
THIGH_LEFT | THIGH_RIGHT
UPPER_ARM_LEFT | UPPER_ARM_RIGHT
```

NON-NULL only on intake events for `Medication.treatmentClass = GLP1`.

### 2.8 `MedicationCategory` / `treatmentClass` (`medication_category`)

```
GENERIC | GLP1
```

**Not** the clinical category (BLOOD_PRESSURE / VITAMIN / …) — that
lives in a side-table. `GLP1` unlocks the injection-site picker, the
titration history, the pen inventory, the side-effect logbook, and
the Coach's GLP-1-aware reply mode. iOS surface gating reads this
field.

### 2.9 `MedicationInventoryState` (`medication_inventory_state`) — v1.4.25 W19b

```
ACTIVE | IN_USE | EXPIRED | USED_UP
```

State machine in `src/lib/medications/inventory/state-machine.ts`:
ACTIVE → IN_USE (first-use stamped) → EXPIRED (30-day clock or
printed expiry) | USED_UP (all doses consumed). Daily cron in
`medication-inventory-expire.ts` (`updateMany`, not per-row loop after
Fix-M).

### 2.10 `MedicationSideEffectCategory` + `Entry` (`*_category`, `*_entry`) — v1.4.25 W19d

5 surface categories × 21 enum entries:

| Category | Entries |
| --- | --- |
| `GI` | NAUSEA, VOMITING, DIARRHEA, CONSTIPATION, ABDOMINAL_PAIN |
| `METABOLIC` | HYPOGLYCEMIA_SYMPTOMS, DEHYDRATION, ANOREXIA, ELECTROLYTE_FATIGUE |
| `INJECTION_SITE` | INJECTION_REDNESS, INJECTION_SWELLING, INJECTION_BRUISING, INJECTION_INDURATION |
| `COGNITIVE` | BRAIN_FOG, DIZZINESS, LOW_MOOD, LOW_ENERGY |
| `GLP1_SPECIFIC` | EARLY_SATIETY, GASTROPARESIS_LIKE, DYSGEUSIA, GALLBLADDER_DISCOMFORT |

Severity is integer 1-5 (CHECK constraint at DB level), mapped to
translated semantic labels in the UI.

### 2.11 Other enums for completeness

| Enum | Values | Notes |
| --- | --- | --- |
| `PersonalRecordDirection` | `MAX \| MIN` | Stored on row so the worker doesn't re-resolve at query time |
| `ReminderPhase` | `GREEN \| YELLOW \| ORANGE \| RED` | Medication reminder dispatcher only |
| `PhaseMode` | `MINUTES \| PERCENT` | Reminder phase config |
| `FeedbackCategory` | `BUG \| FEATURE_REQUEST \| QUESTION \| OTHER` | In-app feedback model |
| `FeedbackStatus` | `OPEN \| ACKNOWLEDGED \| RESOLVED \| ARCHIVED` | — |

---

## 3. Migrations 0051-0060 (chronological — v1.4.25)

Every migration is **additive only**. iOS app does NOT need a schema-
version handshake — it can issue every v1.4.25 contract against a
fully-rolled v1.4.25 server.

### 0051 — `measurement_device_type` (W8c)

```sql
-- from prisma/migrations/0051_measurement_device_type/migration.sql:13
ALTER TABLE "measurements" ADD COLUMN "device_type" TEXT;
```

WHY: Two-axis source-priority picker (`pickCanonicalSource()`) needs
a tiebreak axis when more than one device contributes the same
source's metric (Apple Watch + iPhone both stream HealthKit steps
via `APPLE_HEALTH`). NULL = `unknown`; no backfill needed.

### 0052 — `apple_health_enum_extensions` (W8d)

Three additive enum values for HK iOS-17/18 coverage:

```sql
-- from prisma/migrations/0052_apple_health_enum_extensions/migration.sql:28
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'AUDIO_EXPOSURE_ENV';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'AUDIO_EXPOSURE_HEADPHONE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'TIME_IN_DAYLIGHT';
```

WHY: Close the HK identifier gap. **Note** a fourth value
`WORKOUT_ROUTE` was deliberately dropped — workouts are first-class
entities (`Workout` table, Migration 0053), not Measurements.

### 0053 — `workout_and_route` (W8d)

Two tables: `workouts` (HKWorkout-aligned typed columns + `metadata
JSONB` blob) and `workout_routes` (1:1, GeoJSON `LineString` in JSONB).

```sql
-- from prisma/migrations/0053_workout_and_route/migration.sql:52
CREATE UNIQUE INDEX "workouts_user_source_external_key"
  ON "workouts" ("user_id", "source", "external_id");
```

WHY: Locks the workout-ingest contract before v1.5 iOS Swift starts.
v1.4.25 ships no workout UI beyond the VO2-max tile; ingest endpoint
exists (`POST /api/workouts/batch`) so iOS can build against a stable
DTO. `sportType` is TEXT (not enum) — Apple alone has 70+
`HKWorkoutActivityType` values; managing as a PG enum would force
migrations forever.

**Known v1.5 TODO**: cross-source workout dedup. Current key is
`(userId, source, externalId)` — same workout via MANUAL + APPLE_HEALTH
lands two rows because `source` differs. Mirror
`pickCanonicalSourceRows()` for workouts; tracked for v1.5 P1.

### 0054 — `personal_record` (W8d, schema only)

```sql
-- from prisma/migrations/0054_personal_record/migration.sql:25
CREATE TYPE "personal_record_direction" AS ENUM ('MAX', 'MIN');
```

WHY: iOS app needs a stable `GET /api/personal-records` query path
from day one. Detection worker exists for v1.4.25 (W16c — enqueued
on every measurement batch); records appear as worker runs.

Direction (`MAX | MIN`) stored on the row so the read query is
`ORDER BY value DESC LIMIT 1` (MAX) or `ASC LIMIT 1` (MIN) — one
indexed pass per metric. PR rows have FK `source_measurement_id ON
DELETE SET NULL` so deleting the originating measurement keeps the
historical record fact intact.

### 0055 — `measurement_sleepstage_composite` (W17b/c)

```sql
-- from prisma/migrations/0055_measurement_sleepstage_composite/migration.sql:33
CREATE UNIQUE INDEX "measurements_user_id_type_measured_at_source_sleep_stage_key"
  ON "measurements" ("user_id", "type", "measured_at", "source", "sleep_stage")
  NULLS NOT DISTINCT;
```

WHY: Withings Sleep v2 (and iOS HK sleep) ship one Measurement per
stage segment for the same night — same
`(user_id, type=SLEEP_DURATION, measured_at, source=…)`. Legacy 4-axis
composite collapsed them onto one row. New 5-axis index uses Postgres
15+ `NULLS NOT DISTINCT` so non-sleep rows (`sleep_stage IS NULL`)
still dedup on the first four columns.

**Future Prisma regen warning**: Prisma 7 still defaults to NULLS
DISTINCT. Hand-edit the migration to preserve the `NULLS NOT DISTINCT`
clause every time this index is regenerated.

### 0056 — `medication_inventory_item` (W19b)

```sql
-- from prisma/migrations/0056_medication_inventory_item/migration.sql:34
CREATE TYPE "medication_inventory_state" AS ENUM (
  'ACTIVE', 'IN_USE', 'EXPIRED', 'USED_UP'
);
```

WHY: Coexists with the running-sum `MedicationInventoryEvent` ledger.
The ledger is the consumption stream; this is the entity-level view
("Pen #2 of 3 — 12 days left"). Carries the EMA EPAR §6.3 30-day
in-use clock per opened pen, plus per-pen dose-depletion math.
`expires_at` is persisted (not derived) so the daily expire-stale
cron is one indexed scan.

### 0057 — `user_onboarding_step` (W14b)

```sql
-- from prisma/migrations/0057_user_onboarding_step/migration.sql:27
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "onboarding_step" INTEGER DEFAULT 0;
```

WHY: Resume-state for the multi-step wizard at `/onboarding/[step]`.
Step encoding: 0=welcome, 1=goals, 2=source, 3=baseline, 4=done.
Closing the tab no longer wipes progress. iOS replicates the wizard
locally — when an onboarding flow completes, the iOS client must
POST `step = 4` and `onboardingCompletedAt` flips server-side.

### 0058 — `user_research_mode` (W19c)

```sql
-- from prisma/migrations/0058_user_research_mode/migration.sql:32
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "research_mode_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "research_mode_acknowledged_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "research_mode_acknowledged_version" TEXT;
```

WHY: Gates the opt-in GLP-1 PK research-view chart behind an
undismissable MDR-disclaimer dialog. Version field records WHICH
copy the user acknowledged; when `RESEARCH_MODE_DISCLAIMER_VERSION`
drifts ahead (`src/lib/medications/glp1-pk.ts`), the Settings UI
re-prompts. See `08-locked-contracts.md` §6 for the byte-compare
contract.

### 0059 — `medication_side_effect` (W19d)

```sql
-- from prisma/migrations/0059_medication_side_effect/migration.sql:24
CREATE TYPE "medication_side_effect_category" AS ENUM (
  'GI', 'METABOLIC', 'INJECTION_SITE', 'COGNITIVE', 'GLP1_SPECIFIC'
);
```

Plus the 21-entry `medication_side_effect_entry` enum and a CHECK
constraint `severity >= 1 AND severity <= 5`. WHY: EMA EPAR §4.8
structured side-effect log, daily capture (not per-shot) — delayed-
onset symptoms (nausea day 4 post-tirzepatide) keep their actual
onset time. Coach reads occurredAt against `MedicationDoseChange` +
`MedicationIntakeEvent` to surface patterns without making a clinical
claim (GROUND RULE 9, see §08).

### 0060 — `onboarding_step_not_null` (Fix-O)

```sql
-- from prisma/migrations/0060_onboarding_step_not_null/migration.sql:20
UPDATE "users" SET "onboarding_step" = 0 WHERE "onboarding_step" IS NULL;
ALTER TABLE "users" ALTER COLUMN "onboarding_step" SET NOT NULL;
```

WHY: Closes the tri-state surface 0057 opened. Idempotent — re-running
on a flipped DB is a no-op for both statements. After 0060 the iOS
client can rely on `onboardingStep` being a real integer in every API
response.

---

## 4. Domain models the iOS app reads / writes

### 4.1 `Measurement` — the workhorse

```prisma
// from prisma/schema.prisma:363
model Measurement {
  id                    String            @id @default(cuid())
  userId                String            @map("user_id")
  type                  MeasurementType
  value                 Float
  unit                  String
  source                MeasurementSource @default(MANUAL)
  measuredAt            DateTime          @map("measured_at")
  notes                 String?
  externalId            String?           @map("external_id")
  externalSourceVersion String?           @map("external_source_version")
  glucoseContext        GlucoseContext?
  sleepStage            SleepStage?       @map("sleep_stage")
  deviceType            String?           @map("device_type")
  // ...

  @@unique([userId, type, measuredAt, source, sleepStage])  // legacy dedup
  @@unique([userId, type, source, externalId])              // batch dedup
}
```

**Two unique constraints — both matter to iOS:**

1. **Legacy wall-clock dedup** `(userId, type, measuredAt, source,
   sleepStage)`. NULLS NOT DISTINCT (Migration 0055) so non-sleep
   rows still collide on the first four columns.
2. **Batch dedup** `(userId, type, source, externalId)`. NULL
   externalId is distinct per Postgres semantics — manual entries
   don't collide here.

The iOS HK batch path relies on #2 (`externalId = HKSample.uuid`).

### 4.2 `Workout` + `WorkoutRoute`

`Workout` has HKWorkout-aligned typed columns (`sportType`,
`startedAt`, `endedAt`, `durationSec`, `totalEnergyKcal`,
`totalDistanceM`, `avgHeartRate`, `maxHeartRate`, `minHeartRate`,
`stepCount`, `elevationM`, `pauseDurationSec`) plus `metadata JSONB`
for the source-specific tail (HK key/value, Withings hr_zone_0..3,
device bundle id). Dedup on `(userId, source, externalId)`.

`WorkoutRoute` is 1:1 with `Workout`, holds GeoJSON LineString in
`geometry JSONB`. Parallel array `sampleTimestamps JSONB?` carries
per-coordinate ISO timestamps + optional speeds.

### 4.3 `Medication` + intake / dose / inventory / side-effect chain

```
Medication ─┬─ MedicationSchedule (per-window dosing config)
            ├─ MedicationIntakeEvent (per-shot/pill record + injectionSite)
            ├─ MedicationDoseChange (append-only titration history)
            ├─ MedicationInventoryEvent (running-sum ledger ±delta)
            ├─ MedicationInventoryItem (per-pen entity + 30-day clock)
            ├─ MedicationSideEffect (21-entry × 5-category logbook)
            ├─ ReminderPhaseConfig (1:1, per-med GREEN/YELLOW/ORANGE/RED thresholds)
            └─ TelegramReminderMessage (channel sent log)
```

`treatmentClass = GLP1` gates the injection-site picker, dose
titration, pen inventory tile, side-effect logbook, and the GLP-1
Coach reply mode. Pre-v1.4.25 medications stay `GENERIC` until the
user explicitly migrates one.

### 4.4 `User` + auth chain

```
User ─┬─ Session (web cookie sessions; 30d sliding)
      ├─ Passkey (WebAuthn credential)
      ├─ AuthChallenge (registration/auth challenge cache)
      ├─ ApiToken (Bearer for iOS — hashed)
      ├─ RefreshToken (native client rotating refresh)
      └─ Device (iOS APNs target; partial unique on apns_token)
```

Auth flows: `05-auth-flows.md`.

### 4.5 `WithingsConnection`

1:1 with User. Carries encrypted `accessToken` / `refreshToken`,
`tokenExpiresAt`, `lastSyncedAt`, and the v1.4.25 W5d `scope` field
(`"user.metrics,user.activity"` for new connections, NULL for legacy
v1.4.24- connections — UI surfaces a reconnect banner).

### 4.6 `MoodEntry`

YYYY-MM-DD bucket + `mood`/`score`/`tags`. v1.4.25 W7b added per-row
`tz` (IANA) so the `date` string is anchored to the user's timezone
at write time. NULL `tz` reads as Europe/Berlin (legacy).

### 4.7 Source priority (two-axis) — `User.sourcePriorityJson`

Per-metric ladder + optional per-device ladder. Shape mirrors
`src/lib/validations/source-priority.ts`:

```json
{
  "steps": ["APPLE_HEALTH", "WITHINGS", "MANUAL"],
  "weight": ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
  "deviceTypePriority": {
    "default": ["watch", "phone", "scale"],
    "steps": ["watch", "phone"]
  }
}
```

Cumulative metrics (steps, calories, distance, flights, sleep) get
ONE source per day. Point metrics (weight, BP, pulse, body-fat, body-
temp, SpO2, HRV, RHR, VO2 max) keep every source's row in the DB —
the priority just controls display preference. See `08-locked-contracts.md` §4.

---

## 5. Relations diagram (ASCII)

```
                 ┌─────────────┐
                 │    User     │
                 │   (cuid)    │
                 └──────┬──────┘
                        │ onDelete: Cascade (everywhere)
   ┌────────────────────┼────────────────────────────────────────────┐
   │                    │                                            │
   ▼                    ▼                                            ▼
┌────────────┐    ┌──────────────┐                          ┌──────────────────┐
│Measurement │    │  Workout     │── 1:1 ─▶│WorkoutRoute │  │   Medication     │
│            │    │              │         │  (GeoJSON)  │  │ (treatmentClass) │
└────────────┘    └──────────────┘         └─────────────┘  └────────┬─────────┘
   │                                                                │
   │ FK SET NULL                                                    │
   ▼                                                                ├─▶ MedicationSchedule
┌────────────────┐                                                  ├─▶ MedicationIntakeEvent (injectionSite?)
│PersonalRecord  │                                                  ├─▶ MedicationDoseChange
└────────────────┘                                                  ├─▶ MedicationInventoryEvent (ledger)
                                                                    ├─▶ MedicationInventoryItem (entity)
   ┌─────────────────────────────────┐                              ├─▶ MedicationSideEffect
   │ Session / Passkey / ApiToken /  │                              ├─▶ ReminderPhaseConfig (1:1)
   │ RefreshToken / Device / AuthChal│ ◀───── User auth ─────       └─▶ TelegramReminderMessage
   └─────────────────────────────────┘
                                              │ 1:1
                                              ▼
                                  ┌──────────────────────┐
                                  │ WithingsConnection   │
                                  │ (scope, tokens enc.) │
                                  └──────────────────────┘

   ┌──────────────┐    ┌──────────────┐    ┌───────────────────────┐
   │MoodEntry     │    │CoachConversa │── ▶│   CoachMessage        │
   │ (tz?)        │    │tion          │    │ (encrypted bytes)     │
   └──────────────┘    └──────────────┘    └───────────┬───────────┘
                                                       │
                                                       ▼
                                          ┌────────────────────────┐
                                          │ RecommendationFeedback │
                                          │  (coachMessageId? FK)  │
                                          └────────────────────────┘
```

---

## 6. JSONB / unstructured columns the iOS app may read

| Column | Shape | Read or write? |
| --- | --- | --- |
| `User.sourcePriorityJson` | Two-axis ladder (§4.7) | Read + write via `PUT /api/auth/me/source-priority` |
| `User.thresholdsJson` | `{ "<metric>": { min, max } }` | Read-only on iOS; web is the editor |
| `User.coachPrefsJson` | `{ tone, verbosity, excludeMetrics[], showEvidenceByDefault }` | Read + write via `/api/auth/me/coach-prefs` |
| `User.doctorReportPrefsJson` | `{ bp, weight, pulse, bmi, mood, compliance, sleep }` | Read-only for iOS in v1.5 |
| `User.dashboardWidgetsJson` | `{ widgets: [{ id, visible, order }], version }` | iOS uses its own dashboard config; do not write |
| `User.healthKitConfigJson` | `{ entries: [{ id, kind, direction, enabled }], lastSyncedAt }` | iOS writes its per-metric ingest toggles here |
| `User.researchModeAcknowledgedVersion` | Plain string e.g. `"2026-05-14.1"` | Bytewise compared — see `08-locked-contracts.md` §6 |
| `Workout.metadata` | Free-form JSON; opaque to Coach | Write only; Zod-validate the slice you read on the client |
| `WorkoutRoute.geometry` | `{ type: "LineString", coordinates: [[lon, lat, alt?], ...] }` | Write on ingest, read for map |
| `CoachMessage.metricSourceJson` | Provenance labels — NEVER raw values | Read for the "What I'm looking at" disclosure |

**STOP HERE if** you are tempted to `JSON.parse` a column blindly.
Every JSONB column is Zod-validated at the API boundary — your iOS
DTO should match the same shape, and tolerate added fields (forward-
compat).

---

## 7. Self-test snippet — verify your DTO maps the right columns

```typescript
// iOS HK ingest entry MUST match this Zod shape:
// from src/app/api/measurements/batch/route.ts:61
const batchEntrySchema = z.object({
  hkIdentifier: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.string().min(1).max(60),
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true }),
  sleepStage: z.number().int().min(0).max(20).optional(),
  externalId: z.string().min(1).max(120),
  externalSourceVersion: z.string().min(1).max(120).optional(),
  deviceType: deviceTypeEnum.nullable().optional(),
});
```

Submit at most 500 entries per batch. Anything larger → HTTP 422
`measurement.batch.too_large`. See `08-locked-contracts.md` §2 for
the full batch contract.

---

## 8. What is NOT in this file

- **Auth + token flows** → `05-auth-flows.md`
- **Error envelopes, idempotency** → `17-error-handling.md`
- **Locked contracts (GROUND RULES, batch shapes, refusal probes)** → `08-locked-contracts.md`
- **AI Coach prompt + snapshot construction** → `14-coach-mental-model.md`
- **OpenAPI 3.1 spec on disk** → `docs/api/openapi.yaml` (regenerated via `pnpm openapi:generate`)
