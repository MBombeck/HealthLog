# Withings meastype → HealthLog `MeasurementType` mapping

Single source of truth for the `MEASURE_TYPE_MAP` table in `client.ts`. When
Withings ships a new measurement type, look it up in the Withings developer
guide ([Data API → All Available Health Data][1], [Measure-Getmeas][2]) and
either extend `MEASURE_TYPE_MAP` here or add a new `MeasurementType` enum
value via `prisma/schema.prisma` + a new migration.

Audit + scoring of the full surface lives in
[`.planning/research/withings-api-coverage.md`](../../../.planning/research/withings-api-coverage.md).

## Ingested today (v1.4.25)

| meastype | Withings name               | DB enum               | DB unit     | Source devices                                                                                                                                 |
| -------- | --------------------------- | --------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Weight                      | `WEIGHT`              | kg          | every Body / Body+ / Body Cardio / Body Comp / Body Scan                                                                                       |
| 5        | Fat Free Mass               | `FAT_FREE_MASS`       | kg          | Body+ / Body Cardio / Body Comp / Body Scan                                                                                                    |
| 6        | Fat Ratio                   | `BODY_FAT`            | %           | Body+ family                                                                                                                                   |
| 8        | Fat Mass Weight             | `FAT_MASS`            | kg          | Body+ / Body Cardio / Body Comp / Body Scan                                                                                                    |
| 9        | Diastolic BP                | `BLOOD_PRESSURE_DIA`  | mmHg        | BPM Connect / Core / Vision                                                                                                                    |
| 10       | Systolic BP                 | `BLOOD_PRESSURE_SYS`  | mmHg        | BPM Connect / Core / Vision                                                                                                                    |
| 11       | Heart Pulse                 | `PULSE`               | bpm         | BPM cuffs + scales (standing HR)                                                                                                               |
| 12       | Temperature (legacy Thermo) | `BODY_TEMPERATURE`    | celsius     | first-gen Thermo (WBT01)                                                                                                                       |
| 35       | SpO2 (alt code)             | `OXYGEN_SATURATION`   | %           | older firmware reports 35 instead of 54                                                                                                        |
| 54       | SpO2                        | `OXYGEN_SATURATION`   | %           | ScanWatch / BPM Vision                                                                                                                         |
| 71       | Body Temperature (core)     | `BODY_TEMPERATURE`    | celsius     | current-gen Thermo                                                                                                                             |
| 73       | Skin Temperature            | `SKIN_TEMPERATURE`    | celsius     | ScanWatch dermal sensor. Distinct from `BODY_TEMPERATURE` — surface temps run ~32 °C, core ~37 °C; sharing the bucket would corrupt analytics. |
| 76       | Muscle Mass                 | `MUSCLE_MASS`         | kg          | Body+ / Body Cardio / Body Comp / Body Scan                                                                                                    |
| 77       | Hydration / Water Mass      | `TOTAL_BODY_WATER`    | kg          | Body Comp / Body Scan                                                                                                                          |
| 88       | Bone Mass                   | `BONE_MASS`           | kg          | Body Comp / Body Scan                                                                                                                          |
| 91       | Pulse Wave Velocity         | `PULSE_WAVE_VELOCITY` | m/s         | Body Cardio / Body Scan exclusive                                                                                                              |
| 123      | VO2 max                     | `VO2_MAX`             | mL/(kg·min) | ScanWatch family                                                                                                                               |
| 155      | Vascular Age                | `VASCULAR_AGE`        | years       | Body Scan; composite of PWV + chronological age                                                                                                |
| 170      | Visceral Fat                | `VISCERAL_FAT`        | rating      | Body Comp / Body Scan; Withings' 1–12 scale (not a percent)                                                                                    |

### Unit handling

Withings encodes every value as `value × 10^unit` where `unit` is the
decimal exponent (e.g. `value: 65750, unit: -3` → `65.750 kg`). The client
applies this rule once per measure in `fetchMeasurements()`. New mappings
do not need their own conversion as long as the canonical DB unit matches
Withings' SI default (kg, %, mmHg, bpm, °C, mL/(kg·min), …).

### Webhook subscriptions (v1.4.25)

`POST /notify?action=subscribe` with `appli`:

- `appli=1` — weight + composition meastypes (1, 5, 6, 8, 88)
- `appli=2` — temperature meastypes (12, 71, 73)
- `appli=4` — pressure meastypes (9, 10, 11, 54)

Without all three, BP and temperature readings flow only through the
hourly poll fallback. v1.4.25 fixes this for BP and temperature; sleep
(`appli=44`) and activity (`appli=16`) ship with the corresponding sync
routines in v1.4.26.

## Deferred — v1.4.26

The body-composition expansion (meastypes 5, 8, 73, 76, 91, 155, 170)
landed in **v1.4.25 W5d** — see migration `0049_withings_full_metrics`.
Deferred items now:

- **Sleep** (`POST /v2/sleep?action=getsummary`) → `SLEEP_DURATION`,
  `HEART_RATE_VARIABILITY` (sdnn_1), per-stage rows via existing
  `SleepStage` enum.
- **Activity** (`POST /v2/measure?action=getactivity`) → `ACTIVITY_STEPS`,
  `WALKING_RUNNING_DISTANCE`, `FLIGHTS_CLIMBED`, `ACTIVE_ENERGY_BURNED`.
  **Requires OAuth scope upgrade** to `user.activity` — every existing
  Withings connection has to reconnect once. v1.4.25 W5d ships the
  scope-upgrade plumbing + reconnect banner; the activity sync routine
  itself lands in v1.4.26.

## Deferred — v1.5 (with iOS app)

ECG signal storage (`Heart v2-Get`), AFib events (`Heart v2-List` +
`appli=54`), workouts (`getworkouts`, needs new `Workout` model),
segmental composition (174/175), nerve health (167), extracellular /
intracellular water (168/169), electrodermal activity (196), connected
devices badge (`User v2-Getdevice`), and Height (4) into `User.heightCm`.

## Skip with rationale

- **Withings+ derived metrics** (Health Improvement Score, Vitality,
  Cardio Check-Up review) — not exposed by the public API. HealthLog
  computes its own Health Score / Coach / Briefing. See
  `.planning/research/withings-plus-comparison.md` §6.
- **Sleep events** `appli=50/51/52` (bed-in / bed-out / inflate) — niche
  Sleep Analyzer mat events. No plan today.

[1]: https://developer.withings.com/developer-guide/v3/integration-guide/bulkship-sdk/data-api/all-available-health-data
[2]: https://developer.withings.com/api-reference#tag/measure
