# Apple Health > cycle mapping

How HealthLog folds Apple Health reproductive samples into the cycle model.
Both the `export.xml` importer and the iOS batch contract share one mapping
table: `src/lib/cycle/healthkit-mapping.ts`. This page is the human-readable
companion — keep the two in sync.

Reproductive samples route into **cycle day-logs** (`CycleDayLog`), never into
`Measurement`. Each Apple Health day collapses into one canonical day-log per
`(user, date)`; the importer writes `source = APPLE_HEALTH` with a synthetic
per-day `externalId` (`hkcycle:<YYYY-MM-DD>`) so a re-import upserts the same
row. The fold only runs when cycle tracking is enabled for the account.

## Day-log fields

| HealthKit category type  | CycleDayLog field                 | Values                                                                                                                                                      |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MenstrualFlow`          | `flow`                            | unspecified > LIGHT, light > LIGHT, medium > MEDIUM, heavy > HEAVY, none > NONE                                                                             |
| `IntermenstrualBleeding` | `intermenstrualBleeding`          | presence becomes `true`                                                                                                                                           |
| `CervicalMucusQuality`   | `cervicalMucus`                   | dry > DRY, sticky > STICKY, creamy > CREAMY, watery > WATERY, eggWhite > EGG_WHITE                                                                          |
| `OvulationTestResult`    | `ovulationTest`                   | negative > NEGATIVE, lhSurge > POSITIVE_LH_SURGE, indeterminate > INDETERMINATE, estrogenSurge > ESTROGEN_SURGE                                             |
| `SexualActivity`         | `sexualActivity` + `protectedSex` | presence becomes `true`; `HKMetadataKeySexualActivityProtectionUsed` becomes `protectedSex`                                                                             |
| `PregnancyTestResult`    | `pregnancyTest`                   | negative > NEGATIVE, positive > POSITIVE, indeterminate > INDETERMINATE                                                                                     |
| `ProgesteroneTestResult` | `progesteroneTest`                | negative > NEGATIVE, positive > POSITIVE, indeterminate > INDETERMINATE                                                                                     |
| `Contraceptive`          | `contraceptive` (+ profile nudge) | unspecified > UNSPECIFIED, implant > IMPLANT, injection > INJECTION, iud > IUD, ring > INTRAVAGINAL_RING, oral > ORAL, patch > PATCH, emergency > EMERGENCY |

HealthLog's `SPOTTING` flow level has no HealthKit counterpart; it is only ever
produced by a manual entry. HealthKit `unspecified` flow maps to `LIGHT` (a
logged-but-unspecified bleeding day is at least light flow).

## Symptom category types > seeded symptom keys

Symptom category samples link to the seeded `CycleSymptom` catalogue by key. A
sample whose severity is _not present_ (codepoint 1) does NOT create a link.

| HealthKit category type | CycleSymptom key    |
| ----------------------- | ------------------- |
| `AbdominalCramps`       | `cramps`            |
| `Headache`              | `headache`          |
| `Bloating`              | `bloating`          |
| `Acne`                  | `acne`              |
| `BreastPain`            | `breast_tenderness` |
| `Fatigue`               | `fatigue`           |
| `LowerBackPain`         | `back_pain`         |
| `SleepChanges`          | `insomnia`          |
| `MoodChanges`           | `mood_swings`       |
| `AppetiteChanges`       | `food_cravings`     |
| `Nausea`                | `nausea`            |

## Profile-level signals

A `Contraceptive` sample asserting an active method also nudges the
`CycleProfile.goal` to `AVOID_PREGNANCY` — but only when the goal is still on
its `GENERAL_HEALTH` default, so an explicit user choice is never overwritten.

## Basal body temperature

`basalBodyTemperature` is **not** routed here. It stays a
`Measurement(BODY_TEMPERATURE)` (the system of record for the rollup tier and
the cross-source source-priority ladder) and is mirrored onto
`CycleDayLog.basalBodyTempC` for the cycle chart. Apple Watch wrist/skin
temperature already flows to `WRIST_TEMPERATURE` / `SKIN_TEMPERATURE` and feeds
the temperature-trend ovulation method directly from `Measurement`.

## Pregnancy and lactation status

`Pregnancy` and `Lactation` are status samples, read from `export.xml` only,
and never become a day log. They set the `CycleProfile` pregnancy state, and
only while the profile holds none and its owner never set or cleared one in
the cycle settings: an ongoing `Pregnancy` sample sets `PREGNANT` with
its first day as `pregnancyStartDate`; an ongoing `Lactation` sample sets
`POSTPARTUM` only when a `Pregnancy` sample ended at most 14 days before it
began, that end becoming `deliveryDate`. An ended pregnancy alone sets nothing.
Every state set this way is audited (`cycle.profile.pregnancy-imported`). See
`docs/using/pregnancy.md`.

## Deferred

| HealthKit category type                                                                                                  | Status                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `BleedingDuringPregnancy`, `BleedingAfterPregnancy`                                                                      | Not read yet: the pregnancy state stores no bleeding. |
| `IrregularMenstrualCycles`, `InfrequentMenstrualCycles`, `ProlongedMenstrualPeriods`, `PersistentIntermenstrualBleeding` | Server-derived from the cycle engine, never ingested. |
