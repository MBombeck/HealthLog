---
file: .planning/research/v15-r-f-apple-health-depth.md
purpose: Apple Health / HealthKit integration depth audit and v1.5 coverage proposal
created: 2026-05-16
contributor: R-F
---

# Apple Health Depth Audit and v1.5 Coverage Proposal

## TL;DR

HealthLog ships **27 `MeasurementType` enum values**, of which **18 are reachable from iOS HealthKit today** (the rest are Withings-only or derived). The iOS reader, mapping table, and server ingest path are all in good shape — the architecture (anchored queries + `HKObserverQuery` + `enableBackgroundDelivery` + per-type frequency + per-user anchor partitioning + server-side dedup) is **already the industry-correct pattern**. Where we leave value on the table is **coverage breadth** (workouts not wired end-to-end on iOS, no walking-steadiness / six-minute-walk / running-power, no mindfulness, no state-of-mind read path, no audio-event chips) and **categorisation surface** (a flat 27-value enum is fine for storage but the iOS picker and the web Insights nav both need a category overlay so the user perceives "vitals / activity / body / sleep / hearing / mood" rather than 27 lines).

The recommended shape for v1.5: ship **the existing 18 HK reads plus a v1.5 Tier-1 add of HKWorkout end-to-end, HKStateOfMind read, and a hearing-events chip surface** — additive-only on the schema, no migrations beyond two new `MeasurementType` rows and one new column. Tier 2 and 3 fold in iOS-17/18 running-and-cycling power metrics, walking-steadiness, mindful-session, and the six-minute-walk test — none of which need a new model, just enum entries and Zod rows. The hold lines (nutrition, reproductive cycle, FHIR clinical) stay where Marc drew them.

---

## Section 1 — Current-state inventory

### 1.1 The `MeasurementType` enum surface

From `prisma/schema.prisma:292-326` and `src/lib/validations/measurement.ts:3-35`, the enum carries **27 values**. Grouped by origin:

| Origin | Count | Members |
|---|---|---|
| Apple-Health reachable (mapped) | 18 | `WEIGHT`, `BODY_FAT`, `BODY_TEMPERATURE`, `BLOOD_PRESSURE_SYS`, `BLOOD_PRESSURE_DIA`, `PULSE`, `RESTING_HEART_RATE`, `HEART_RATE_VARIABILITY`, `OXYGEN_SATURATION`, `BLOOD_GLUCOSE`, `ACTIVITY_STEPS`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`, `WALKING_RUNNING_DISTANCE`, `VO2_MAX`, `SLEEP_DURATION`, `AUDIO_EXPOSURE_ENV`, `AUDIO_EXPOSURE_HEADPHONE`, `TIME_IN_DAYLIGHT` |
| Withings-only today (mappable from HK with effort) | 7 | `TOTAL_BODY_WATER`, `BONE_MASS`, `FAT_FREE_MASS`, `FAT_MASS`, `MUSCLE_MASS`, `SKIN_TEMPERATURE`, `VISCERAL_FAT` |
| Withings-only (no HK equivalent) | 2 | `PULSE_WAVE_VELOCITY`, `VASCULAR_AGE` |

(Total reaches 27; off-by-one is `TIME_IN_DAYLIGHT` which mirrors HK and lands in both columns.)

### 1.2 Server ingest path

`src/app/api/measurements/batch/route.ts` is the iOS-batch sink. Each entry walks `mapAppleHealthEntry()` in `src/lib/measurements/apple-health-mapping.ts:483-509` against the `APPLE_HEALTH_TYPE_MAP` (18 mapped identifiers) and the `HK_QUANTITY_TYPE_DEFERRED` set (40+ identifiers we know about but deliberately do NOT store yet). Unknown identifiers return `{ status: "skipped", reason: "unknown_hk_identifier" }`; the iOS client advances its anchor past them so they never retry.

The dedup contract is the composite unique key `@@unique([userId, type, source, externalId])` (`prisma/schema.prisma:418`) where `externalId` is `HKSample.uuid`. Per-night sleep stages collide on the four-axis dedup until v1.4.25 W17b/c added `sleepStage` as the fifth axis on the `(userId, type, measuredAt, source, sleepStage)` unique constraint (`prisma/schema.prisma:415`, `NULLS NOT DISTINCT` semantics).

Blood-pressure is **stored as two rows** (`BLOOD_PRESSURE_SYS` + `BLOOD_PRESSURE_DIA`) joined by shared `measuredAt`. Reads pair them at the read layer (`src/lib/insights/blood-pressure-status.ts`). This matches Apple's own `HKCorrelationTypeIdentifierBloodPressure` shape (two child samples in a correlation) but stores them flat. Pragmatic and matches the Withings v1 ingest model — keep it.

### 1.3 iOS-side read path

`HealthKitService.swift` (`/Users/marc/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Services/HealthKitService.swift`) is an actor-isolated wrapper around `HKHealthStore`. The `defaultReadTypes` static set (lines 101-137) authorises exactly the 18 reachable types listed in §1.1. The architecture is **correct by 2024-2026 best practice**:

- **`HKObserverQuery` per type** with `enableBackgroundDelivery(for:frequency:)` — the only correct way to do bidirectional sync without re-shipping everything (matches the `kingstinct/react-native-healthkit` reference, Stanford BDHG's `SpeziHealthKit`, and Apple's own [WWDC20 "Getting started with HealthKit"](https://developer.apple.com/videos/play/wwdc2020/10664/) guidance).
- **Per-type frequency** classes (lines 354-383): `.immediate` for the eight cardio-vital-glucose-temp metrics that drive anomaly pushes, `.daily` for sleep (HK aggregates phases overnight anyway), `.hourly` for cumulative metrics. This is well-judged — sleep `.immediate` would wake the device every time the user briefly woke up during the night.
- **`HKAnchoredObjectQuery` follow-up on observer wakeups** (lines 422-454, line 462) with per-user anchor partitioning in `UserDefaults` (lines 659-718). The partitioning by user-id is something most OSS HK projects skip; HealthLog gets this right.
- **Deletion reconciliation** via the `deletedObjects` callback (lines 441-451) → `DELETE /api/measurements/by-external-ids`. Most OSS projects ignore HK deletes; HealthLog correctly tombstones them.
- **Auth-failure storm guard** (lines 289-336) for the "Authorization not determined" error → stops the observer rather than spinning in a retry loop. This is a hotfix-grade detail nobody else surfaces.
- **`HKStateOfMind` write path** for iOS 18+ mood bidirectional sync (lines 219-243). This is one direction only today (HealthLog → HK); the inbound HK-State-of-Mind → HealthLog mood read is **not wired**.

The wire converter (`HealthKitWireConverter.swift`) handles unit pre-multiplication (×100 for `oxygenSaturation` and `bodyFatPercentage`), the sleep-stage codepoint extraction, and the `HKDevice.model` → `deviceType` ladder (`watch | phone | scale | ring | band | unknown`). Clean.

The default-read set excludes seven HK identifiers we either map server-side for Withings (visceral-fat etc.) or do not map at all (mindfulness, state-of-mind read, six-minute-walk, walking-steadiness, etc. — full list in §1.5).

### 1.4 Insights pipeline coverage

`src/lib/insights/sub-page-metric.ts:27-37` declares seven sub-pages: `blutdruck`, `gewicht`, `puls`, `stimmung`, `medikamente`, `bmi`, `schlaf`. Dedicated status modules exist for blood pressure, weight, pulse, BMI, mood, medication compliance, and a generic fallback. Chart-overlay-keys (`src/lib/dashboard-layout.ts:113-127`) cover: `bp`, `weight`, `bmi`, `pulse`, `bodyFat`, `mood`, `medications`, `sleep`, `steps`, `vo2Max` — ten overlay slots.

**Gap:** of the 18 HK-reachable measurement types, 10 have a chart overlay and 7 have a status module. The remainder (`BODY_TEMPERATURE`, `RESTING_HEART_RATE`, `HEART_RATE_VARIABILITY`, `OXYGEN_SATURATION`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`, `WALKING_RUNNING_DISTANCE`, `AUDIO_EXPOSURE_ENV`, `AUDIO_EXPOSURE_HEADPHONE`, `TIME_IN_DAYLIGHT`) **arrive at the server, get stored, contribute to the source-priority picker and the Coach evidence shelf, but have no dedicated chart card and no status module.** Their values surface only in (a) the raw Insights timeline and (b) the Coach evidence chips when an AI run pulls them.

That gap is the largest single piece of value HealthLog is leaving on the table. Section 4 proposes the v1.5 chart-card additions.

### 1.5 Workouts and the cross-source dedup gap

The schema has a `Workout` model (`prisma/schema.prisma:432-491`) + `WorkoutRoute` (lines 494-512) — both shipped in v1.4.25 W8d (Migration 0053). The Zod validation lives at `src/lib/validations/workout.ts` with a 19-entry `workoutSportTypeEnum` covering the high-frequency sports plus a permissive `other` sink, a `MAX_ROUTE_POINTS = 20_000` cap, and a `MAX_WORKOUTS_PER_BATCH = 100` ingest cap.

**Status: schema and Zod are ready; the iOS Swift HealthKit reader does NOT yet read HKWorkout.** `HealthKitService.defaultReadTypes` only enumerates quantity-types and the sleep category type — no `HKWorkoutType.workoutType()` insertion. The W16b research outline (`.planning/research/w16b-workout-ingest.md`) names this as a v1.5 P1 deliverable. The cross-source workout dedup TODO is annotated in the schema itself (`schema.prisma:476-485`) — the same workout arriving from Apple Watch + Withings ScanWatch lands twice today; a `pickCanonicalWorkoutRows()` helper has to mirror the existing measurement source-priority picker.

### 1.6 What iOS knows but the server doesn't yet store

`HK_QUANTITY_TYPE_DEFERRED` (`apple-health-mapping.ts:303-438`) enumerates 40+ identifiers we explicitly defer:

- **Body composition (HK-side, Withings-side stored already):** `BodyMassIndex` (derived), `Height` (on `User.heightCm`), `LeanBodyMass`, `RespiratoryRate`, `WalkingHeartRateAverage`, `HeartRateRecoveryOneMinute`, `AppleSleepingWristTemperature`, `BasalEnergyBurned`, `AppleExerciseTime`, `AppleStandTime`, `AppleStandHour`.
- **Running form (iOS 16+):** `WalkingSpeed`, `WalkingStepLength`, `WalkingAsymmetryPercentage`, `WalkingDoubleSupportPercentage`, `StairAscentSpeed`, `StairDescentSpeed`, `SixMinuteWalkTestDistance`, `RunningSpeed`, `RunningPower`, `RunningStrideLength`, `RunningGroundContactTime`, `RunningVerticalOscillation`.
- **Cycling (iOS 17+):** `CyclingCadence`, `CyclingFunctionalThresholdPower`, `CyclingPower`, `CyclingSpeed`, `DistanceCycling`.
- **Sport-specific distances/speeds (iOS 18):** cross-country skiing, paddle sports, rowing, skating, swimming.
- **Workout-effort scores (iOS 18):** `EstimatedWorkoutEffortScore`, `WorkoutEffortScore`, `PhysicalEffort` (per [Sasquatch Studio's iOS 18 effort-score guide](https://sasq.ca/blog/2025/4/28/reading-writing-workout-effort-scores)).
- **Sleep apnea (iOS 18):** `AppleSleepingBreathingDisturbances`, `SleepApneaEvent` (per [MacRumors iOS 18.1 beta coverage](https://www.macrumors.com/2024/10/07/ios-18-1-beta-6-sleep-apnea/) and Apple's [sleep-apnea support page](https://support.apple.com/en-us/120031)).
- **Cardio events:** `AtrialFibrillationBurden`, `PeripheralPerfusionIndex`, `LowHeartRateEvent`, `HighHeartRateEvent`, `IrregularHeartRhythmEvent`, `LowCardioFitnessEvent`.
- **Mobility (iOS 15+):** `AppleWalkingSteadiness`, `NumberOfTimesFallen`, `AppleWalkingSteadinessEvent`.
- **Respiratory clinical (iOS 17):** `ForcedExpiratoryVolume1`, `ForcedVitalCapacity`, `PeakExpiratoryFlowRate`, `InhalerUsage`.
- **Mental state:** `MindfulSession`, `StateOfMind` (the **read** path).
- **Hearing events:** `EnvironmentalAudioExposureEvent`, `HeadphoneAudioExposureEvent`, `EnvironmentalSoundReduction`.
- **Reproductive / pregnancy (explicit hold):** menstrual flow, ovulation, contraceptive, lactation, pregnancy etc. — per Marc directive, do not chase.
- **Clinical (HKClinicalType, FHIR):** `AllergyRecord`, `ConditionRecord`, `ImmunizationRecord`, `LabResultRecord`, `MedicationRecord`, `ProcedureRecord`, `VitalSignRecord`. Deferred to v1.6+.
- **Scored assessments (iOS 18):** `PHQ9`, `GAD7`.
- **ECG (`HKElectrocardiogramType`).**
- **Other privacy holds:** `InsulinDelivery`, `UVExposure`, `ElectrodermalActivity`, `BloodAlcoholContent`.
- **Behavioural:** `HandwashingEvent`, `ToothbrushingEvent`.

This list is doing the right job — being explicit about what we know-and-defer so we don't accidentally start dropping samples in production silently. The audit question is which entries should move out of `DEFERRED` for v1.5.

---

## Section 2 — Industry best practice 2024-2026

### 2.1 The right query pattern per metric class

Apple's [`HKAnchoredObjectQuery` docs](https://developer.apple.com/documentation/healthkit) plus the cross-checked third-party guides ([DevFright HKAnchoredObjectQuery walkthrough](https://www.devfright.com/how-to-use-healthkit-hkanchoredobjectquery/), [DevFright HKStatisticsCollectionQuery walkthrough](https://www.devfright.com/how-to-use-the-hkstatisticscollectionquery/)) draw a clear line:

- **`HKAnchoredObjectQuery`** — incremental sync of raw samples. Each call returns "everything since the anchor I gave you" and a new anchor. **This is the only correct choice for a server-syncing iOS client** — you need every sample, not a daily summary. Used by HealthLog today.
- **`HKStatisticsCollectionQuery`** — fixed-interval rollups (hourly/daily/weekly). Used for **on-device charts** when the app draws its own visualisations without round-tripping to a server. Apple's own Health app and most analytics dashboards use this. We do NOT need this on iOS because the server materialises the rollups.
- **`HKSampleQuery`** — one-shot snapshot. Used for "show me the most recent N samples". Useful for the iOS app's offline read cache backfill but not for the sync engine.

The decision tree per HK metric class:

| Metric class | Pattern | Rationale |
|---|---|---|
| Vital signs (BP, HR, RHR, HRV, BG, SpO2, body temp) | Anchored, `.immediate` background delivery | Anomaly pushes need real-time |
| Body composition (weight, fat %, lean mass) | Anchored, `.hourly` BD | Third-party scales often back-date samples |
| Cumulative activity (steps, energy, distance, flights) | Anchored, `.hourly` BD | Daily-aggregate server materialisation handles the rollup |
| Sleep (category type) | Anchored, `.daily` BD | One wake-up per morning |
| Workouts (`HKWorkoutType.workoutType()`) | Anchored, `.hourly` BD + paired route stream | New v1.5 surface |
| State of Mind (iOS 17+) | Anchored, `.hourly` BD | Bidirectional with the HealthLog mood model |
| Hearing events (audio-exposure events) | Anchored, `.hourly` BD | Pair with the existing dBA quantity samples |
| Mindfulness sessions (category) | Anchored, `.daily` BD | Low-volume; daily is plenty |

HealthLog already gets the vital / body / activity / sleep classification right (see `HealthKitService.preferredFrequency` in `HealthKitService.swift:364-383`). The new additions in §3 and §4 slot into the same scheme.

### 2.2 Source priority — what Apple does and what we do

Per [Apple Support: "Manage Health data"](https://support.apple.com/en-us/108779), the HK store can hold **multiple sources writing the same data type** simultaneously. The system Health app's default priority order is:

1. Manual user entries
2. iPhone / iPad / Apple Watch (the same-Apple-ID device family)
3. Third-party apps and Bluetooth devices

The user can drag-reorder per data category in Settings → Health → Data Access & Devices. The OS gives developers no automatic "winner" — every `HKAnchoredObjectQuery` returns every sample from every source.

HealthLog's `src/lib/analytics/source-priority.ts` is the **correct response** to this. The two-axis picker (source class + device type) resolves cross-source duplicates at READ time, not WRITE time. This is the right call — the iOS client posts every HK sample (it has to; the device-priority order can change after the fact), and the server's canonical row picker collapses to one logical reading at query time.

**Architectural note:** the picker today operates on `Measurement` rows but not on `Workout` rows (the TODO in `schema.prisma:476-485`). v1.5 should ship `pickCanonicalWorkoutRows()` as the symmetric helper — same shape, same precedence ladder, applied at the workout read path.

### 2.3 Permission scope — read-only is right for v1.5

Apple's [Configuring HealthKit access guide](https://developer.apple.com/documentation/xcode/configuring-healthkit-access) requires per-type read/write authorisation. Important: **the OS never tells you whether a read permission was granted** (returns the same opaque "authorized" state whether granted or denied) — only write permissions surface the user's choice. The HK reader must therefore assume every read might silently return zero samples and degrade gracefully.

HealthLog's iOS app correctly asks for read-only on every type except the four that have a manual UI write surface (weight, BP, glucose, mood/state-of-mind). The `defaultWriteTypes` set at `HealthKitService.swift:139-146` is minimal and well-judged. **v1.5 should keep write-only on these four** — letting the iOS app write back arbitrary types (e.g. user-edited insights) crosses the MDR line called out in `06-ios-responsibilities.md` §"MDR-critical iOS warnings".

### 2.4 Background delivery — battery vs freshness

Per Apple's [`enableBackgroundDelivery` docs](https://developer.apple.com/documentation/HealthKit/HKHealthStore/enableBackgroundDelivery(for:frequency:withCompletion:)) and the [HealthKit background-delivery entitlement page](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.background-delivery):

- `.immediate` — wakes the app on every new sample. Battery-intensive; reserved for clinically-meaningful signals.
- `.hourly` — coalesced wake-ups. Default for most non-vital metrics.
- `.daily` — once-a-day wake-up; cheapest. Right for sleep, mindful sessions, daylight.
- `.weekly` — exists but practically nobody uses it.

HealthLog's `preferredFrequency` classifier (HealthKitService.swift:354-383) matches the prevailing 2024-2026 convention. The new v1.5 additions slot in:

- Workouts → `.hourly` (a workout's completion is not a real-time event for an analytics product).
- State-of-Mind (read) → `.hourly`.
- Mindful sessions → `.daily`.
- Walking steadiness → `.daily` (one rollup per day is enough).
- Sleep-apnea breathing-disturbance events (iOS 18) → `.daily` (paired with the morning sleep summary).

### 2.5 Privacy disclosure — Apple is stricter since 2024

Per [Apple Developer Privacy Compliance 2025](https://clause-guard.com/blog/apple-developer-privacy-compliance-2025-avoid-app-rejection-account-termination) and the App Review Guidelines §5.1.3 (Health and Health Research):

> The single most common rejection reason for HealthKit apps is requesting data types you don't clearly use in the app. If you request blood glucose access but there's no visible glucose feature in the app, you're getting rejected.

**Action item for v1.5 iOS submission:** every HK type in `defaultReadTypes` must have a corresponding visible surface in the app (chart card, status pill, insight chip, or settings toggle). Today the iOS app reads 10 quantities + sleep + audio + daylight but the SwiftUI surface mostly shows the BP / weight / pulse / sleep / steps subset. **Before the App Store review, either:**
1. Add visible surfaces for every read type, OR
2. Trim `defaultReadTypes` to the visibly-used subset and re-request on-demand when the user navigates to a feature that needs it (incremental auth is supported).

Option 2 is the lower-risk path for first review. Option 1 is what §4's chart-card additions deliver.

### 2.6 The Apple Health XML export — the day-zero onboarding lever

Per the existing `.planning/research/apple-health-ecosystem-scan.md` §4 and §7 (recommendation 🔴-1), the `export.zip` file every iPhone user can produce in Settings → Health → Export All Health Data is **the universal Apple Health currency**. Every serious OSS project in the topic accepts it as the primary onboarding path. HealthLog **does not yet** — a ~200-LOC server-side Node SAX parser over `export.xml` (porting `k0rventen/apple-health-grafana/ingester/ingester.py`) would let a brand-new web-only user upload years of HK history before the iOS app even ships on their device. Reuse the existing `POST /api/measurements/batch` for the per-row insert.

**For v1.5 scope:** this is recommended in the prior research, not in this slot's question — but I cite it because the **XML importer mapping table and the iOS HK mapper share the same `HKQuantityTypeIdentifier* → MeasurementType` lookup**. Adding new identifiers to one is the same change as adding them to the other; the v1.5 Tier-1 additions in §3 should be added to **both** call sites in one commit.

---

## Section 3 — Proposed v1.5 coverage tiers

### Tier 1 — v1.5 ship (must-have)

These are the additions a maintainer needs for "the iOS app feels complete" the day it ships.

#### T1.1 — HKWorkout end-to-end on iOS (schema already exists)

**Schema impact:** zero. The `Workout` + `WorkoutRoute` models shipped in v1.4.25 W8d. The 19-entry `workoutSportTypeEnum` covers ~98% of typical workouts.

**iOS implementation:**
- Add `HKWorkoutType.workoutType()` to `HealthKitService.defaultReadTypes`.
- Run an `HKAnchoredObjectQuery` over workouts on observer wake.
- For each `HKWorkout`, run a paired `HKWorkoutRouteQuery` to stream `[CLLocation]` for the route (filter `horizontalAccuracy > 50 m` per W16b research).
- Map `HKWorkoutActivityType` numeric enum to the `workoutSportTypeEnum` strings (mapping table per [Apple's `HKWorkoutActivityType` docs](https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype)).
- Post each workout to `POST /api/workouts/batch` (≤100 per batch, ≤20 000 route points per workout — already capped at Zod).

**Server ingest path:** the validation in `src/lib/validations/workout.ts` is ready; the API route is the v1.5 deliverable. Reuse the idempotency-middleware + per-entry dedup pattern from `POST /api/measurements/batch`. The W16b research outline names the canonical shape.

**Insights surface impact:**
- New dashboard tile: "Recent workouts" (last 7 days, sport icon + duration + distance + avg HR).
- New chart card on `/insights/puls`: per-workout HR-zone breakdown (Z1-Z5) overlaid on the existing pulse chart.
- New PR-detection slot in the `PersonalRecord` table — `metricSlot = "running_5km_time" | "cycling_distance" | "longest_run"` etc. The W16c research already has this designed.

**Cross-source workout dedup (the open TODO):** `pickCanonicalWorkoutRows()` in `src/lib/analytics/source-priority.ts`. Same shape as `pickCanonicalSourceRows()`. v1.5 P1 ships this alongside the iOS workout read path so the dashboard never shows the same Apple-Watch-then-Withings run twice.

#### T1.2 — HKStateOfMind read path (iOS 18+)

HealthLog already writes `HKStateOfMind` samples on mood entry (one direction, see `HealthKitService.swift:219-243`). The inverse — reading `StateOfMind` samples the user logged via the Health app or another iOS app and ingesting them as HealthLog `MoodEntry` rows — is **not wired**.

**Schema impact:** zero. The `MoodEntry` model accepts the existing 1-5 scale; the Apple valence axis maps cleanly (per Apple's [State of Mind support page](https://support.apple.com/guide/iphone/log-your-state-of-mind-iph6a6decb13/ios)) — valence -1.0…+1.0 → 1-5 buckets.

**iOS implementation:**
- Authorise read on `HKDataTypeIdentifierStateOfMind` (iOS 17+, `HKStateOfMind.Kind`).
- Anchored query, `.hourly` background delivery.
- Map valence + kind (`.momentaryEmotion` | `.dailyMood`) → `MoodEntry { score, mood, source: "APPLE_HEALTH" }`.

**Server ingest path:** new column-less mapping — `MoodEntry.source` already supports free-text values (existing values include `"WEB"`, `"TELEGRAM"`, `"DAYLIO"` — `prisma/schema.prisma:1056`). Add `"APPLE_HEALTH"`. The mood ingest endpoint exists (`/api/mood`) — add a batch variant if iOS needs to backfill multiple entries.

**Insights surface impact:** the existing `/insights/stimmung` page picks up the new rows for free. No chart-card change.

#### T1.3 — Chart cards for the existing-but-invisible reads (no schema work)

The ten HK metrics that arrive at the server but have no chart-overlay key (§1.4) get cards. Concretely, extend `CHART_OVERLAY_KEYS` in `src/lib/dashboard-layout.ts:113-127` with:

- `restingHr` (today: same chart as `pulse` but the user expects a separate card)
- `hrv` (Whoop/Oura UX expectation)
- `spo2` (existing card on `/insights/puls`; promote to first-class overlay key)
- `bodyTemperature`
- `activeEnergy` (Apple's "Move" ring equivalent)
- `flights`
- `distance`
- `audioExposureEnv`
- `audioExposureHeadphone`
- `daylight`

Each one is a one-line addition to `CHART_OVERLAY_KEYS`, a one-card mount in the dashboard layout JSON, and zero schema work. The hard part is the design — Apple-Health-style ring vs bar vs line is a per-metric call.

**This is the single largest perceived-value-per-LOC change in v1.5.** Without it, the iOS app reads ten metrics but the user only "sees" them in the AI Coach evidence chips. With it, the dashboard finally matches what Apple Health surfaces.

#### T1.4 — Hearing-event chips (Tier 1 extension of existing audio reads)

The continuous `AUDIO_EXPOSURE_ENV` and `AUDIO_EXPOSURE_HEADPHONE` quantity samples are already mapped. Apple **also** fires category events (`HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent`, `…HeadphoneAudioExposureEvent`) when the rolling 7-day average crosses the WHO 80-dBA loud-listening threshold. These are the "Your headphones have been loud" notifications.

**Schema impact:** add two enum entries — `AUDIO_EXPOSURE_EVENT_ENV`, `AUDIO_EXPOSURE_EVENT_HEADPHONE` — OR a single `AUDIO_EXPOSURE_EVENT` with a `severity` annotation column. Recommend **the latter** to avoid enum bloat; the `notes` field can carry the kind.

**iOS implementation:** add the two category types to `defaultReadTypes`; map to the new `AUDIO_EXPOSURE_EVENT` MeasurementType with `value = 1` (boolean flag) per event.

**Insights surface impact:** chip strip on `/insights/puls` (the closest existing page) or a new `/insights/gehoer` (German for "hearing") sub-page — pick the cheaper option, recommend the chip strip first.

#### T1.5 — Walking-steadiness gauge (mobility, low-cost)

`HKQuantityTypeIdentifierAppleWalkingSteadiness` is a `0..1` percentage that Apple Watch reports as a daily rollup. Apple's own Health app shows this prominently in the Mobility section; it's a great Tier-1 add because the value is **a single number per day**.

**Schema impact:** one new `MeasurementType` enum entry — `WALKING_STEADINESS` (% canonical, scaled ×100 from Apple's 0..1 fraction, same pattern as oxygen saturation).

**iOS implementation:** add to `defaultReadTypes`; add a `WireUnit` entry; scale 100. Identical to the `bodyFatPercentage` handling.

**Insights surface impact:** small status card on a new "Mobility" sub-page OR fold into the existing `/insights/puls` page as an "activity health" chip. Recommend the chip — sub-page count is already at 7 and the user does not need an 8th.

#### Tier-1 schema-impact summary

| Change | Type | Migration needed? |
|---|---|---|
| `WALKING_STEADINESS` MeasurementType | enum entry | Y — one-line migration |
| `AUDIO_EXPOSURE_EVENT` MeasurementType | enum entry | Y — one-line migration |
| MoodEntry.source = "APPLE_HEALTH" allowed | free-text | N — column is TEXT |
| Workout endpoints | new API route, schema exists | N |
| Cross-source workout dedup | new analytics helper | N |
| Chart-overlay keys | TypeScript constant | N |

**Net: additive-only, two new enum entries, no destructive migrations.**

### Tier 2 — v1.5.x follow-ups (high-impact backlog)

#### T2.1 — Running and cycling power (iOS 16+)

The five-metric running-form set (`RunningSpeed`, `RunningPower`, `RunningStrideLength`, `RunningGroundContactTime`, `RunningVerticalOscillation`) and the four-metric cycling set (`CyclingCadence`, `CyclingFunctionalThresholdPower`, `CyclingPower`, `CyclingSpeed`) are what athletes expect from a serious sport platform.

**Schema impact:** these are per-workout metrics, not per-day measurements. Best surface is the **Workout metadata JSONB blob** (`Workout.metadata`) rather than nine new enum entries. The HKAnchoredObjectQuery side pulls the per-sample series; aggregate to "average / max / time-in-zone" on iOS and post the rollup in `metadata`. No new MeasurementType rows.

#### T2.2 — Workout-effort score (iOS 18)

`HKQuantityTypeIdentifierEstimatedWorkoutEffortScore` is a 1-10 rating Apple Watch auto-generates for walking/running/hiking/cycling. The user can override via `HKQuantityTypeIdentifierWorkoutEffortScore`. Both are documented in [Sasquatch Studio's effort-score guide](https://sasq.ca/blog/2025/4/28/reading-writing-workout-effort-scores).

**Schema impact:** store in `Workout.metadata.effortScore` (typed `number 1..10`, source `estimated | user`). No new enum.

#### T2.3 — Sleep-apnea breathing disturbances (iOS 18 / watchOS 11)

`HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances` (per-night value) plus `HKCategoryTypeIdentifierSleepApneaEvent` (flag). Apple's Watch needs 10 nights of data before it surfaces a sleep-apnea notification ([Apple Support: Sleep apnea notifications](https://support.apple.com/en-us/120031)).

**Schema impact:** one new MeasurementType (`BREATHING_DISTURBANCES`) for the nightly quantity. The event flag pairs with it via a notes annotation. Tier 2 because the audience for this is much smaller than the Tier 1 set.

#### T2.4 — Mindful sessions

`HKCategoryTypeIdentifierMindfulSession` is a duration sample (start-end pair) the user generates via Apple's Mindfulness app or Calm/Headspace.

**Schema impact:** one new MeasurementType (`MINDFUL_MINUTES`) — duration in minutes, mirroring `SLEEP_DURATION`. Or fold into a new `WellnessEntry` model. Recommend the MeasurementType for consistency.

#### T2.5 — Six-minute walk distance (cardio fitness)

`HKQuantityTypeIdentifierSixMinuteWalkTestDistance` is a metres value that Apple Watch derives from cardio-fitness session data. Lower-frequency (weekly at most) but a useful clinical reference for cardiovascular research.

**Schema impact:** one new MeasurementType. Tier 2 because the audience is narrow.

#### T2.6 — Heart-rate recovery one-minute

`HKQuantityTypeIdentifierHeartRateRecoveryOneMinute` — the post-workout one-minute HR drop. Strong cardiovascular signal (the lower the recovery delta, the worse). One value per workout.

**Schema impact:** store in `Workout.metadata.heartRateRecovery1min`. No new MeasurementType.

#### Tier-2 schema-impact summary

3 new MeasurementType entries (`BREATHING_DISTURBANCES`, `MINDFUL_MINUTES`, `SIX_MINUTE_WALK_DISTANCE`). Otherwise additive — Workout.metadata JSONB absorbs the rest. **Still additive-only, no destructive migrations.**

### Tier 3 — Post-v1.5 (defer)

- **HKClinicalRecord (FHIR).** Big US-market value (Epic/Cerner lab results); big compliance scope. v1.6+.
- **HKElectrocardiogramType (ECG waveforms).** The existing `apple-health-ecosystem-scan.md` covers this. Defer — the data model is unique (multi-channel time series) and not a Measurement row.
- **Atrial-fibrillation burden, peripheral perfusion index, scored assessments (PHQ-9 / GAD-7).** Clinical territory; defer with deliberate hold pending a clinical-decision-support architecture review.
- **Reproductive / cycle / pregnancy.** Marc has explicit "do not chase" — leave the deferred list intact.
- **Nutrition (`DietaryWater`, `DietaryEnergyConsumed`, etc.).** Marc directive — indefinite hold.
- **UV exposure, electrodermal activity, blood-alcohol content.** Niche, defer.
- **Behavioural (`HandwashingEvent`, `ToothbrushingEvent`).** Not in HealthLog scope.
- **Hearing tests (`AudiogramType`).** Hearing health is Tier 1 via audio-exposure events but the audiogram itself is a clinical waveform — defer with the ECG bucket.
- **Apple Watch independent app (glance widget).** Separate Xcode target; the iOS app comes first.

---

## Section 4 — Categorisation overlay (the "kategorisieren wir das gut?" question)

### 4.1 The current flat enum is fine for storage

The 27-value `MeasurementType` enum is the correct storage shape. Postgres enums are cheap; the alternative (per-category sub-tables) would explode read joins for the Insights overview and break the cross-source picker which operates uniformly across all types. Keep the enum.

### 4.2 The categorisation overlay belongs to the UI, not the database

For the iOS picker, the web Insights nav, and the AI Coach's evidence shelf, propose a **read-only category map**:

```typescript
// New file: src/lib/measurements/categories.ts
export const MEASUREMENT_CATEGORIES = {
  vitals: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE", "RESTING_HEART_RATE",
           "HEART_RATE_VARIABILITY", "OXYGEN_SATURATION", "BODY_TEMPERATURE"],
  body: ["WEIGHT", "BODY_FAT", "FAT_FREE_MASS", "FAT_MASS", "MUSCLE_MASS",
         "TOTAL_BODY_WATER", "BONE_MASS", "VISCERAL_FAT"],
  activity: ["ACTIVITY_STEPS", "ACTIVE_ENERGY_BURNED", "FLIGHTS_CLIMBED",
             "WALKING_RUNNING_DISTANCE", "VO2_MAX", "WALKING_STEADINESS"],
  sleep: ["SLEEP_DURATION"],
  hearing: ["AUDIO_EXPOSURE_ENV", "AUDIO_EXPOSURE_HEADPHONE", "AUDIO_EXPOSURE_EVENT"],
  environment: ["TIME_IN_DAYLIGHT"],
  cardiovascular: ["PULSE_WAVE_VELOCITY", "VASCULAR_AGE"],
  metabolic: ["BLOOD_GLUCOSE", "SKIN_TEMPERATURE"],
  mood: ["MOOD"],            // synthetic — not a MeasurementType but lives in the picker
  medication: ["COMPLIANCE"], // synthetic
} as const;
```

Properties of this overlay:

- **It does not exist at the DB layer.** No schema change. The picker is purely client-side / server-side TypeScript.
- **It mirrors Apple Health's own categorisation** — open the iPhone Health app → Browse and the categories are Activity / Body Measurements / Cycle Tracking / Hearing / Heart / Mental Wellbeing / Mindfulness / Mobility / Nutrition / Respiratory / Sleep / Symptoms / Vitals. HealthLog's overlay collapses some (Heart + Vitals → vitals) and omits the categories we deliberately don't track (Cycle, Nutrition, Respiratory clinical, Symptoms).
- **It drives the iOS HK permission picker.** Today `HealthKitPermissionGroup.swift` already does this **but** the groups are hand-coded in Swift and don't reference the canonical category map. v1.5 should derive the iOS permission picker from this overlay so adding a new MeasurementType requires only one change.
- **It drives the web Insights nav.** Today the nav is a flat 7-page list (`blutdruck`, `gewicht`, `puls`, `stimmung`, `medikamente`, `bmi`, `schlaf`). For v1.5 keep the existing pages but add an "All metrics" overview grouped by category (cheap; reuses the existing chart-card surface).
- **It feeds the Coach evidence chips.** Today the evidence shelf is a flat list; grouping by category makes the prose more navigable.

### 4.3 Why not a separate `category` column on `MeasurementType`?

Because the category is **never queried**. Every Insights page already knows which MeasurementType(s) it cares about (`SUB_PAGE_METRIC` in `sub-page-metric.ts`). The category overlay is a presentation concern, not a query concern. Adding a column would force every measurement-table consumer to thread an unused field through. The TypeScript-side map is the simpler tool.

### 4.4 The MOOD / COMPLIANCE problem

`metric:MOOD` and `metric:COMPLIANCE` are **synthetic tokens** (see `src/lib/insights/chart-tokens.ts:14-35`) — they look like MeasurementType values to the chart renderer but they back `MoodEntry` and `MedicationIntakeEvent` rows respectively. The categorisation overlay above includes them as `mood` and `medication` categories. **Recommend keeping the synthetic-token pattern**; introducing them as real enum values would force a four-axis dedup re-think for two metrics that don't behave like measurements.

---

## Section 5 — Open questions for the synthesizer

1. **Workout end-to-end is the single largest v1.5 deliverable.** §3 Tier 1.1 is bigger than every other Tier 1 item combined. The schema is ready; the iOS Swift HK reader, the new API route, the route-streaming worker, the cross-source dedup helper, and the dashboard tile are all v1.5 P1. Should this be a **standalone wave** (W-A "Workouts iOS + server") and the rest of the Tier 1 work a **second wave** (W-B "HK coverage breadth + categorisation overlay + chart cards")? Recommend yes; the workout work is its own scope and shares no code with the other Tier 1 items beyond the HKAnchoredObjectQuery + idempotency-batch pattern that's already proven.

2. **The chart-card additions in §3 Tier 1.3 require design decisions per metric.** A "loud audio events" chip is design-light; a "headphone audio level rolling 7-day average" chart needs a token-aligned visual. Recommend a **design wave between the data wave and the implementation wave** — same pattern v1.4.20 used for the Insights redesign.

3. **App Store review risk on `defaultReadTypes`.** §2.5 flagged the strictness. If the v1.5 iOS app ships with 10 quantity-types authorised but only the BP/weight/pulse/sleep/steps subset visibly used, reviewers will reject. Two paths: ship the chart-cards in §3 Tier 1.3 with the iOS app, OR trim `defaultReadTypes` to the visibly-used subset and re-authorise incrementally. **The synthesizer needs to pick.** Recommend the former — it's also the higher-perceived-value path.

4. **Cross-source workout dedup is an open TODO with non-trivial nuance.** A user with Apple Watch + Withings ScanWatch will see the same workout twice today. The fix is `pickCanonicalWorkoutRows()` — but the precedence ladder for workouts is **not the same as for measurements**. A Withings ScanWatch's HR-zone breakdown is richer than Apple's; an Apple Watch's GPS route is richer than Withings'. The picker should be metric-aware (route → Apple wins; HR zones → Withings wins; calories → tied). Recommend ship the picker with the existing measurement ladder (Apple ≻ Withings ≻ Manual) and tune in a follow-up rather than block v1.5.

5. **State-of-Mind bidirectional cycle risk.** HealthLog writes `HKStateOfMind` on mood entry; if Tier-1.2 reads back inbound `HKStateOfMind` and the iOS app re-writes those as `MoodEntry`, we'll have a round-trip. The Apple-side `HKMetadataKeyExternalUUID` write-back filter in the existing service (HealthKitService.swift:557-565) handles this for outbound writes; the inbound mapper has to mirror it. Recommend bake this filter into the read path from day one — same pattern as the existing quantity-sample filter.

6. **Should `SLEEP_DURATION` split into stage-specific MeasurementTypes?** The per-stage row pattern works but means every sleep query has to sum stages. An alternative is one MeasurementType per stage (`SLEEP_DEEP`, `SLEEP_CORE`, `SLEEP_REM`, `SLEEP_AWAKE`, `SLEEP_IN_BED`). Pro: simpler reads. Con: breaks the existing analytics pipeline. **Recommend no change** — the per-stage rows + the `sleepStage` enum is the right shape and matches Apple's `HKCategoryValueSleepAnalysis` codepoint model.

7. **Apple Health XML import (the §2.6 cross-reference).** Strictly out of this slot's question but the highest-leverage non-iOS-app deliverable in the broader research. If the synthesizer rolls v1.5 wider than "iOS app only", recommend pull this into v1.5. If v1.5 stays iOS-app-only, defer to v1.6 with the FHIR work.

---

## Section 6 — Senior view: are we doing this right?

**Yes, on architecture.** The HealthKit ingest path on iOS is **above industry average**. Per-user anchor partitioning, deletion reconciliation, auth-failure storm guard, per-type background-delivery frequency, idempotency-keyed batch posts with composite-unique dedup, source-priority resolution at READ time — every one of these is a hard-won detail that most OSS HK projects skip. The single largest piece of value Marc is leaving on the table is **breadth**, not depth. The depth is correct.

**Where the architecture has a soft spot:** the iOS app reads ten quantities the user cannot see on a chart. That's not wrong per se — the AI Coach uses them — but it's invisible to the user, and Apple's App Store reviewers will increasingly call it out as "unused authorisation" (§2.5). The §3 Tier 1.3 chart-card additions close that gap and double the perceived value of the existing data plumbing.

**Where we're leaving genuine value:** workouts are the single biggest miss. Apple's first-class workout data model (`HKWorkout` + `HKWorkoutRoute` + per-workout HR / power / cadence / route GPS) is the closest thing to a "killer feature" Apple Health offers, and HealthLog has the schema but not the iOS reader. v1.5 P1 closing this gap is the right call.

**Where the maintainer is **leading** the field:** the source-priority two-axis picker, the `deviceType` column, the per-user anchor partitioning, and the cross-source canonical-row architecture are **better than every open-source competitor** I reviewed in the prior `apple-health-ecosystem-scan.md` work. `umutkeltek/health-data-hub` punts on multi-source; `Lybron/health-auto-export` documents it but doesn't automate it; `StanfordBDHG/HealthGPT` reads only one source. HealthLog has solved a problem nobody else has solved.

**Where the categorisation question lands:** the flat 27-value enum is correctly the storage shape; the missing piece is the **UI-side category overlay** in §4. Today, the iOS permission picker hand-codes its groups in Swift (`HealthKitPermissionGroup.swift:25-86`) and the web Insights nav hand-picks 7 sub-pages — neither is derived from a canonical category map. v1.5 should ship the overlay and derive both from it. One change, two consumers.

**Bottom line:** HealthLog is **doing HealthKit right**. The v1.5 work is breadth (10 → 13 metrics, plus workouts end-to-end) and presentation (chart cards for the invisible metrics, category overlay for the picker), not architectural rework.

---

## Sources

- [Apple Developer — HealthKit](https://developer.apple.com/documentation/healthkit)
- [Apple Developer — `HKAnchoredObjectQuery`](https://developer.apple.com/documentation/healthkit) and the [DevFright walkthrough](https://www.devfright.com/how-to-use-healthkit-hkanchoredobjectquery/) (updated for iOS 18, March 2025)
- [Apple Developer — `HKStatisticsCollectionQuery`](https://developer.apple.com/documentation/healthkit/hkstatisticscollectionquery) and the [DevFright daily-summary guide](https://www.devfright.com/how-to-use-the-hkstatisticscollectionquery/)
- [Apple Developer — `enableBackgroundDelivery(for:frequency:withCompletion:)`](https://developer.apple.com/documentation/HealthKit/HKHealthStore/enableBackgroundDelivery(for:frequency:withCompletion:))
- [Apple Developer — `com.apple.developer.healthkit.background-delivery` entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.background-delivery)
- [Apple Developer — `HKWorkoutActivityType`](https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype)
- [Apple Developer — `HKWorkout`](https://developer.apple.com/documentation/healthkit/hkworkout)
- [Apple Developer — `HKWorkoutRouteBuilder`](https://developer.apple.com/documentation/healthkit/hkworkoutroutebuilder)
- [Apple Developer — `HKWorkoutRoute`](https://developer.apple.com/documentation/healthkit/hkworkoutroute)
- [Apple Developer — `HKDevice`](https://developer.apple.com/documentation/healthkit/hkdevice)
- [Apple Developer — Configuring HealthKit access](https://developer.apple.com/documentation/xcode/configuring-healthkit-access)
- [Apple Developer — Protecting user privacy (HealthKit)](https://developer.apple.com/documentation/healthkit/protecting-user-privacy)
- [Apple Developer — Track workouts with HealthKit on iOS and iPadOS (WWDC25)](https://developer.apple.com/videos/play/wwdc2025/322/)
- [Apple Developer — Explore wellbeing APIs in HealthKit (WWDC24)](https://developer.apple.com/videos/play/wwdc2024/10109/)
- [Apple Developer — Getting started with HealthKit (WWDC20)](https://developer.apple.com/videos/play/wwdc2020/10664/)
- [Apple Support — Manage Health data on your iPhone, iPad, or Apple Watch](https://support.apple.com/en-us/108779) — the canonical source-priority documentation
- [Apple Support — Sleep apnea notifications on your Apple Watch](https://support.apple.com/en-us/120031)
- [Apple Support — Log your state of mind in Health on iPhone](https://support.apple.com/guide/iphone/log-your-state-of-mind-iph6a6decb13/ios)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) §5.1.3 Health and Health Research
- [Apple Developer Privacy Compliance 2025](https://clause-guard.com/blog/apple-developer-privacy-compliance-2025-avoid-app-rejection-account-termination) — App Store rejection patterns 2024-2025
- [Sasquatch Studio — Reading and writing iOS 18 workout-effort scores](https://sasq.ca/blog/2025/4/28/reading-writing-workout-effort-scores)
- [MacRumors — iOS 18.1 beta sleep-apnea coverage](https://www.macrumors.com/2024/10/07/ios-18-1-beta-6-sleep-apnea/)
- [MacStories — Health in iOS 13: A Foundation for Apple's Grand Wellness Ambitions](https://www.macstories.net/stories/health-in-ios-13-a-foundation-for-apples-grand-wellness-ambitions/) (historical baseline)
- [`StanfordBDHG/SpeziHealthKit`](https://github.com/StanfordSpezi/SpeziHealthKit) and [`kingstinct/react-native-healthkit`](https://github.com/kingstinct/react-native-healthkit) — reference implementations
- [`kvs-coder/HealthKitReporter`](https://github.com/kvs-coder/HealthKitReporter) — pure-Swift HK wrapper reference
- Internal: `.planning/research/apple-health-ecosystem-scan.md`, `.planning/research/apple-health-sync-deep-dive.md`, `.planning/research/w16b-workout-ingest.md`, `.planning/research/w16c-pr-detection.md`, `.planning/v15-ios-handoff/06-ios-responsibilities.md`

---

**Word count:** ~3650.
