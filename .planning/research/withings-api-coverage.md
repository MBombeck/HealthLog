# Withings API — Full Surface Coverage Audit

Date: 2026-05-14
Status: Research + v1.4.25 implementation plan. Wave produces atomic commits per new mapping.
Baseline: HealthLog v1.4.25-dev / `develop`. Withings code lives in `src/lib/withings/`.

This document audits **every** Withings public API endpoint and meastype against HealthLog's ingestion path, scores the gaps, and lists what we ship in v1.4.25 vs defer to v1.4.26 / v1.5.

---

## Section 1 — Inventory of HealthLog's current Withings surface

Current ingestion path (`src/lib/withings/client.ts` → `MEASURE_TYPE_MAP`):

| meastype | Withings name               | HealthLog `MeasurementType` | Unit (DB) | Notes                                       |
| -------- | --------------------------- | --------------------------- | --------- | ------------------------------------------- |
| 1        | Weight                      | `WEIGHT`                    | kg        | ✅ Body+, Body Cardio, Body Comp, Body Scan |
| 6        | Fat Ratio                   | `BODY_FAT`                  | %         | ✅ Body+ family                             |
| 9        | Diastolic Blood Pressure    | `BLOOD_PRESSURE_DIA`        | mmHg      | ✅ BPM Connect, BPM Core, BPM Vision        |
| 10       | Systolic Blood Pressure     | `BLOOD_PRESSURE_SYS`        | mmHg      | ✅ same                                     |
| 11       | Heart Pulse                 | `PULSE`                     | bpm       | ✅ from BPM cuffs + scales                  |
| 54       | SpO2 (ScanWatch / pulse-ox) | `OXYGEN_SATURATION`         | %         | ✅ ScanWatch / BPM Vision                   |
| 77       | Hydration / Water Mass      | `TOTAL_BODY_WATER`          | kg        | ✅ Body Comp, Body Scan (kg of water)       |
| 88       | Bone Mass                   | `BONE_MASS`                 | kg        | ✅ Body Comp, Body Scan                     |

Endpoints actually used:

| Endpoint          | Action                              | Status                                                  |
| ----------------- | ----------------------------------- | ------------------------------------------------------- |
| `POST /v2/oauth2` | `requesttoken` (exchange + refresh) | ✅ implemented                                          |
| `POST /measure`   | `getmeas`                           | ✅ implemented (paged with `offset` until `more=false`) |
| `POST /notify`    | `subscribe` (appli=1)               | ✅ implemented — but ONLY appli=1 (weight)              |
| `POST /notify`    | `revoke`                            | ✅ implemented                                          |

OAuth scope requested: `user.metrics` — see `getAuthorizationUrl()`. That's the right minimum for measurements; it does NOT cover activity (`users.activity`), sleep events (`user.sleepevents`), or user info (`user.info`).

---

## Section 2 — Full Withings public surface

### 2.1 Measure API — `POST /measure`

Withings' core "scalar reading" endpoint. Returns `measuregrps` keyed by `meastype` int. Below is the meastype catalog as published in the Withings developer guide (cross-referenced against the API reference and the All Available Health Data table). All require `user.metrics` scope.

Coverage legend: ✅ ingested today / 🟡 enum exists but not wired / ⚠️ wire to existing bucket / ❌ no enum, would need additive schema change.

| meastype | Withings name                    | Unit (raw)  | HealthLog status | Target bucket               | Notes                                                                                                                                                                                          |
| -------- | -------------------------------- | ----------- | ---------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Weight                           | kg          | ✅ ingested      | `WEIGHT`                    |                                                                                                                                                                                                |
| 4        | Height                           | m           | ❌ no enum       | (User profile field)        | One-shot. Belongs in `User` profile (display unit), not `Measurement`. Skip-with-rationale.                                                                                                    |
| 5        | Fat Free Mass                    | kg          | ❌ no enum       | (new `FAT_FREE_MASS`)       | Body+ family ships this. Algorithmically = weight − fat mass. Defer to v1.4.26 with schema enum addition.                                                                                      |
| 6        | Fat Ratio (body fat %)           | %           | ✅ ingested      | `BODY_FAT`                  |                                                                                                                                                                                                |
| 8        | Fat Mass Weight                  | kg          | ❌ no enum       | (new `FAT_MASS`)            | Body+ family. Mass form of `BODY_FAT` (kg, not %). Defer.                                                                                                                                      |
| 9        | Diastolic BP                     | mmHg        | ✅ ingested      | `BLOOD_PRESSURE_DIA`        |                                                                                                                                                                                                |
| 10       | Systolic BP                      | mmHg        | ✅ ingested      | `BLOOD_PRESSURE_SYS`        |                                                                                                                                                                                                |
| 11       | Heart Pulse                      | bpm         | ✅ ingested      | `PULSE`                     | From BPM cuff + scale. Scale = standing HR.                                                                                                                                                    |
| 12       | Temperature (legacy Thermo)      | °C          | 🟡 enum exists   | `BODY_TEMPERATURE`          | **Wire in v1.4.25.** First-gen Thermo (WBT01).                                                                                                                                                 |
| 35       | SpO2 (legacy code)               | %           | 🟡 enum exists   | `OXYGEN_SATURATION`         | **Wire in v1.4.25.** Some Withings devices report `35` instead of `54`.                                                                                                                        |
| 54       | SpO2 (ScanWatch / pulse-ox)      | %           | ✅ ingested      | `OXYGEN_SATURATION`         |                                                                                                                                                                                                |
| 71       | Body Temperature (Thermo / core) | °C          | 🟡 enum exists   | `BODY_TEMPERATURE`          | **Wire in v1.4.25.** Current-gen Thermo.                                                                                                                                                       |
| 73       | Skin Temperature                 | °C          | ❌ no enum       | (new `SKIN_TEMPERATURE`)    | ScanWatch dermal reading; distinct from core body temp. Defer to v1.4.26 with new enum (collapsing into `BODY_TEMPERATURE` would corrupt analytics — surface temps run 30–34 °C, core ≈37 °C). |
| 76       | Muscle Mass                      | kg          | ❌ no enum       | (new `MUSCLE_MASS`)         | Body+ family. Defer to v1.4.26.                                                                                                                                                                |
| 77       | Hydration / Water Mass           | kg          | ✅ ingested      | `TOTAL_BODY_WATER`          |                                                                                                                                                                                                |
| 88       | Bone Mass                        | kg          | ✅ ingested      | `BONE_MASS`                 |                                                                                                                                                                                                |
| 91       | Pulse Wave Velocity              | m/s         | ❌ no enum       | (new `PULSE_WAVE_VELOCITY`) | Body Cardio / Body Scan exclusive. Not in US. Defer to v1.4.26.                                                                                                                                |
| 123      | VO2 max                          | mL/(kg·min) | 🟡 enum exists   | `VO2_MAX`                   | **Wire in v1.4.25.** ScanWatch series.                                                                                                                                                         |
| 130      | Atrial Fibrillation (PPG)        | enum 0/1    | ❌ no enum       | (defer — needs event model) | Algorithmic AFib flag from PPG window. Defer to v1.5 with a dedicated `CardiacEvent` model.                                                                                                    |
| 135      | QRS interval (auto from ECG)     | ms          | ❌ no enum       | (defer — clinical)          | ScanWatch / BPM Vision. Defer to v1.5.                                                                                                                                                         |
| 136      | PR interval                      | ms          | ❌ no enum       | (defer — clinical)          | Defer to v1.5.                                                                                                                                                                                 |
| 137      | QT interval                      | ms          | ❌ no enum       | (defer — clinical)          | Defer to v1.5.                                                                                                                                                                                 |
| 138      | Corrected QT (QTc)               | ms          | ❌ no enum       | (defer — clinical)          | Defer to v1.5.                                                                                                                                                                                 |
| 139      | AFib classification result       | enum        | ❌ no enum       | (defer — clinical event)    | Defer to v1.5.                                                                                                                                                                                 |
| 155      | Vascular Age                     | years       | ❌ no enum       | (new `VASCULAR_AGE`)        | Body Scan. Defer to v1.4.26.                                                                                                                                                                   |
| 167      | Nerve Health Score               | 0–100       | ❌ no enum       | (new)                       | Body Comp / Body Scan, US-only via Total Biomarker Pack. Defer to v1.4.26 — niche.                                                                                                             |
| 168      | Extracellular Water              | L           | ❌ no enum       | (new)                       | Body Scan exclusive. Defer to v1.5 — segmental composition is a sub-feature.                                                                                                                   |
| 169      | Intracellular Water              | L           | ❌ no enum       | (new)                       | Same.                                                                                                                                                                                          |
| 170      | Visceral Fat                     | rating      | ❌ no enum       | (new `VISCERAL_FAT`)        | Body Comp / Body Scan. Defer to v1.4.26.                                                                                                                                                       |
| 174      | Fat Mass Segmental               | kg per limb | ❌ no enum       | (defer — JSON sub-doc)      | Body Scan segmental. Defer to v1.5.                                                                                                                                                            |
| 175      | Muscle Mass Segmental            | kg per limb | ❌ no enum       | (defer — JSON sub-doc)      | Same.                                                                                                                                                                                          |
| 196      | Electrodermal Activity           | µS          | ❌ no enum       | (defer)                     | Nerve-health module. Defer to v1.5.                                                                                                                                                            |
| 226      | Lean Mass                        | kg          | ❌ no enum       | (alias of 5?)               | Same semantics as Fat Free Mass — Withings ships both; verify before mapping. Defer.                                                                                                           |

The `getmeas` call we already make sends `meastypes=1,6,9,10,11,54,77,88` (the keys of `MEASURE_TYPE_MAP`). To pick up the v1.4.25 additions we just extend the map; the query string grows automatically.

**Unit semantics** — Withings encodes every value as `value * 10^unit` where `unit` is the decimal exponent (e.g. `value=65750, unit=-3` → `65.750 kg`). The existing client already does this `m.value * Math.pow(10, m.unit)`. No new conversion logic needed for v1.4.25 wires — all four additions are SI / dimensionless and inherit the exponent rule.

**`category` parameter** — undocumented for new additions; we leave `category` unset, which returns _real measures_ (not goals). No change needed.

### 2.2 Sleep API — `POST /v2/sleep`

Two actions: `get` (high-frequency series, ≤24h window) and `getsummary` (per-night aggregates).

`getsummary` data fields (DB targets we'd need):

| Field                              | Description            | HealthLog target                                                        |
| ---------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `total_sleep_time`                 | Total sleep, sec       | `SLEEP_DURATION` (minutes; convert)                                     |
| `total_timeinbed`                  | Total in bed, sec      | sleepStage `IN_BED` row                                                 |
| `asleepduration`                   | Total asleep, sec      | sleepStage `ASLEEP` row                                                 |
| `lightsleepduration`               | Light sleep, sec       | sleepStage `CORE` row (HealthKit names "Core" = light)                  |
| `deepsleepduration`                | Deep sleep, sec        | sleepStage `DEEP`                                                       |
| `remsleepduration`                 | REM, sec               | sleepStage `REM`                                                        |
| `wakeupduration`                   | Wake during night, sec | sleepStage `AWAKE`                                                      |
| `wakeupcount`                      | Number of wake-ups     | (no slot — defer)                                                       |
| `durationtosleep`                  | Sleep latency, sec     | (no slot — defer)                                                       |
| `durationtowakeup`                 | Wakeup latency, sec    | (no slot — defer)                                                       |
| `sleep_score`                      | 0–100                  | (no slot — surface in UI as raw or store as `WithingsSleepScore` later) |
| `hr_average` / `hr_min` / `hr_max` | bpm                    | (no slot — defer)                                                       |
| `rr_average`                       | breaths/min            | (no slot — defer)                                                       |
| `snoring`                          | sec                    | (no slot — defer)                                                       |
| `breathing_disturbances_intensity` | severity 0–100         | (no slot — apnea screening signal; defer)                               |
| `apnea_hypopnea_index`             | events/h               | (no slot — defer; clinical)                                             |
| `sdnn_1` (sleep block 1)           | ms                     | `HEART_RATE_VARIABILITY` (per-night agg)                                |
| `rmssd`                            | ms                     | (alternative HRV metric — store under same enum or add `RMSSD`?)        |

**v1.4.26 candidate.** Wiring this needs:

1. A new sync routine `syncUserSleep(userId, opts)` that calls `POST /v2/sleep?action=getsummary`.
2. `getmeas` and `getsummary` cannot share the same request because the two endpoints take different action verbs.
3. Subscription `appli=44` (User Sleep) to drive webhook updates.
4. Decide HRV storage: SDNN is what HealthKit + Apple Watch + Withings all expose, so map `sdnn_1` → `HEART_RATE_VARIABILITY` (existing enum). Skip `rmssd` for now.

### 2.3 Heart API — `POST /v2/heart`

Two actions: `list` (per-ECG-record metadata + AFib classification) and `get` (raw ECG signal in µV at 500 Hz).

A `list` response item looks like:

```json
{
  "ecg": { "signalid": 48, "afib": 1 },
  "bloodpressure": { "diastole": 100, "systole": 101 },
  "heart_rate": 82,
  "timestamp": 1594159644
}
```

- **`heart_rate`** field on a BPM Core record is already coverable via `getmeas` (meastype 11), so no new ingestion. But the `list` action gives us **AFib flag + ECG signal id + capture timestamp**, which `getmeas` does not. Defer to v1.5 with a `CardiacEvent` model. ECG signal storage is gigabyte-scale (500 Hz × 30s = 15k samples per capture); needs careful design.

### 2.4 Activity / Workouts API — `POST /v2/measure`

Three actions:

| Action                | Returns                                                                                                                                                  | Auth scope       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `getactivity`         | per-day aggregates: steps, distance (m), elevation, soft/moderate/intense sec, active sec, calories, totalcalories, hr_average/min/max, hr_zone_0..3 sec | `users.activity` |
| `getintradayactivity` | high-freq per-minute samples of the same fields                                                                                                          | `users.activity` |
| `getworkouts`         | discrete workout sessions with start/end + per-session aggregates + sport-specific fields (pool laps, strokes, GPS)                                      | `users.activity` |

**Mapping potential** (with `users.activity` scope added to OAuth):

- `steps` → `ACTIVITY_STEPS` (enum exists; Apple Health path already uses it)
- `distance` → `WALKING_RUNNING_DISTANCE` (enum exists)
- `elevation` → `FLIGHTS_CLIMBED` (enum exists, but Withings unit is _floors_; verify — Withings docs list `elevation: Number of floors climbed`. Match!)
- `calories` → `ACTIVE_ENERGY_BURNED` (enum exists)
- `hr_average` per day → (no enum; could use `RESTING_HEART_RATE` if marked as "rest"; skip for now)

**v1.4.26 candidate.** Wiring needs:

1. Scope upgrade: append `users.activity` to `getAuthorizationUrl()` scope string. **Breaking change for existing connections** — they must reconnect. Mitigation: trigger reauth flow with messaging "we've added activity sync; reconnect to enable."
2. New sync routine `syncUserActivity(userId)`.
3. Workouts need a brand-new `Workout` model — defer that piece to v1.5.

### 2.5 User API — `POST /v2/user`

| Action        | Returns                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `getdevice`   | List of user's devices: type, model, model_id, last activation, firmware version, battery |
| `getbyuserid` | Internal user info (probably gated to dropshipment partners)                              |

**v1.5 candidate.** A "Connected Withings devices" badge under Settings → Integrations is a nice polish item — surfaces which physical device the data came from. Not in v1.4.25 critical path.

### 2.6 Notify API — `POST /notify`

Subscribe / list / revoke / get. Subscribing requires the user's access token. The `appli` integer is the **category we want to be notified about**:

| appli | Trigger                                            | Scope              | Service to call back                          |
| ----- | -------------------------------------------------- | ------------------ | --------------------------------------------- |
| 1     | New weight/composition meas (types 1, 5, 6, 8, 88) | `user.metrics`     | `Measure-Getmeas`                             |
| 2     | New temperature meas (12, 71, 73)                  | `user.metrics`     | `Measure-Getmeas`                             |
| 4     | New BP/SpO2 meas (9, 10, 11, 54)                   | `user.metrics`     | `Measure-Getmeas`                             |
| 16    | New activity data                                  | `users.activity`   | `getactivity` / `getintraday` / `getworkouts` |
| 44    | New sleep summary                                  | `users.activity`   | `Sleep v2-Get` / `Getsummary`                 |
| 46    | User profile changed (delete / unlink / update)    | `user.info`        | (no fetch — react to event)                   |
| 50    | Bed in event                                       | `user.sleepevents` | (no fetch)                                    |
| 51    | Bed out event                                      | `user.sleepevents` | (no fetch)                                    |
| 52    | Sleep sensor inflate done                          | `user.sleepevents` | (no fetch)                                    |
| 53    | No account associated (cellular device handoff)    | n/a                | `User v2-Link`                                |
| 54    | New ECG data                                       | `user.metrics`     | `Heart v2-List`                               |
| 55    | ECG measure failed                                 | `user.metrics`     | (no fetch)                                    |
| 58    | New glucose meas                                   | `user.metrics`     | `Measure-Getmeas`                             |
| 119   | New glucose (alternate code per partner package)   | `user.metrics`     | `Measure-Getmeas`                             |

**Gap:** HealthLog only subscribes to `appli=1`. **Even today**, BP readings (meastype 9/10/11) and SpO2 (54) flow in via the hourly poll, not via webhook — because they live behind `appli=4`, not `appli=1`. This is an **unflagged latency bug**: a new BP reading takes up to an hour to surface in HealthLog. Fix-in-v1.4.25 candidate (cheap; just subscribe to `appli=4` as well).

For v1.4.25 we add `appli=2` (temperature) and `appli=4` (BP/SpO2) subscriptions to match what we already poll for. `appli=58` (glucose) we leave aside until we connect a Withings glucose device (none in BPM/scale family today — gated to CGM partners).

### 2.7 Notes on Withings+ subscription

None of the endpoints in §2.1 – §2.6 require a Withings+ subscription on the user's side. Coverage is purely a function of:

1. **Withings developer app permissions** — set per-app in the partner hub.
2. **OAuth scope** — must include `users.activity` / `user.sleepevents` / `user.info` for the corresponding endpoints.
3. **Hardware** — the user needs the device that produces the metric (ScanWatch for SpO2, Body Scan for segmental composition, etc.).

The Withings+ tier (`Cardio Check-Up`, `Health Improvement Score`, `Vitality Indicator`) sits **above** the API layer — those features are computed inside Withings' app and are not exposed by the public API. There's nothing to "ingest" from Withings+ even if the user pays. See `.planning/research/withings-plus-comparison.md` §1.2.

**This is good news.** Marketing copy can honestly say: _"HealthLog reads everything a Withings device records, regardless of whether you subscribe to Withings+."_

---

## Section 3 — Gap scoring

Scale: User-value (UV) 5=most users / 1=niche. Effort (E) 5=trivial / 1=multi-day. Schema-impact (S) 5=none / 1=new model needed.

| Gap                                                      | UV  | E   | S   | Wave        | Rationale                                                                                                                          |
| -------------------------------------------------------- | --- | --- | --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| meastype 12 Temperature (legacy)                         | 2   | 5   | 5   | **v1.4.25** | One line in `MEASURE_TYPE_MAP`. Enum already has `BODY_TEMPERATURE`.                                                               |
| meastype 71 Body Temperature (Thermo)                    | 3   | 5   | 5   | **v1.4.25** | Same. Thermo owners get fever tracking sync.                                                                                       |
| meastype 35 SpO2 (alt code)                              | 3   | 5   | 5   | **v1.4.25** | Same. Some devices report 35 instead of 54.                                                                                        |
| meastype 123 VO2 max                                     | 3   | 5   | 5   | **v1.4.25** | Same. Enum already has `VO2_MAX`.                                                                                                  |
| Subscribe appli=4 (BP webhook)                           | 5   | 5   | 5   | **v1.4.25** | Latency bug fix. BP currently waits an hour; should be seconds.                                                                    |
| Subscribe appli=2 (temperature webhook)                  | 2   | 5   | 5   | **v1.4.25** | Cheap; matches the new meastype 12/71 mapping.                                                                                     |
| meastype 73 Skin Temperature                             | 2   | 4   | 3   | v1.4.26     | Needs new `SKIN_TEMPERATURE` enum (different physiology than core).                                                                |
| meastype 5/8/76 Body composition (FFM / FM / Muscle)     | 4   | 4   | 3   | v1.4.26     | Three new enum values + i18n strings + chart slots. Body Comp / Body Scan owners care.                                             |
| meastype 170 Visceral Fat                                | 3   | 4   | 3   | v1.4.26     | New enum slot. Body Comp / Body Scan.                                                                                              |
| meastype 91 Pulse Wave Velocity                          | 3   | 4   | 3   | v1.4.26     | New enum slot. Body Cardio / Body Scan, EU+US only.                                                                                |
| meastype 155 Vascular Age                                | 2   | 4   | 3   | v1.4.26     | New enum slot. Composite of PWV + age — surfaces a "year" value.                                                                   |
| Sleep API (getsummary) — duration + stages + HRV         | 5   | 3   | 4   | v1.4.26     | New sync routine; uses existing `SLEEP_DURATION`/`HEART_RATE_VARIABILITY` enums + `SleepStage`. Pairs with W4-shipped sleep chart. |
| Activity API (getactivity) — steps + distance + calories | 4   | 3   | 5   | v1.4.26     | Existing enums; scope upgrade requires user reauth.                                                                                |
| Workouts API (getworkouts)                               | 3   | 2   | 1   | v1.5        | Needs `Workout` model with sport type + GPS + per-session aggregates.                                                              |
| Intraday activity (getintradayactivity)                  | 2   | 3   | 4   | v1.5        | Per-minute samples; volume question (50k+ rows/day per user). Defer until storage strategy is set.                                 |
| ECG signal (Heart-Get)                                   | 5   | 1   | 1   | v1.5        | 30s @ 500 Hz signals; needs blob storage strategy + cardiologist-disclaimer copy. Off-strategy for clinical interpretation.        |
| AFib events (Heart-List + appli=54)                      | 4   | 2   | 2   | v1.5        | Needs `CardiacEvent` model + alerting policy. Clinical surface — design care.                                                      |
| meastype 167 Nerve Health Score                          | 1   | 4   | 3   | v1.5        | US-only via Total Biomarker Pack on Body Comp / Body Scan; niche.                                                                  |
| meastype 168/169 Extracellular / Intracellular Water     | 2   | 4   | 3   | v1.5        | Body Scan exclusive; clinical-adjacent.                                                                                            |
| meastype 174/175 Segmental composition (per-limb)        | 2   | 3   | 1   | v1.5        | JSON sub-document; needs new column or sidecar table.                                                                              |
| meastype 196 Electrodermal Activity                      | 1   | 3   | 3   | v1.5        | Nerve-health module; niche.                                                                                                        |
| meastype 4 Height                                        | 3   | 4   | 4   | v1.5        | Belongs on `User` profile, not as time-series. Wire to `User.heightCm` with last-write-wins.                                       |
| Devices list (User-Getdevice)                            | 3   | 4   | 5   | v1.5        | "Connected device" badge under Settings; needs a new API route + UI surface.                                                       |

---

## Section 4 — Webhook coverage

Withings push (notify) covers every category in §2.6. HealthLog **today** only subscribes to `appli=1`, meaning:

| Category               | What it covers              | HealthLog has webhook today? | Latency on a new reading |
| ---------------------- | --------------------------- | ---------------------------- | ------------------------ |
| 1 — Weight/composition | meastypes 1, 5, 6, 8, 88    | ✅ yes                       | ~seconds                 |
| 4 — BP & SpO2          | meastypes 9, 10, 11, 54     | ❌ no                        | up to 1 hour (poll)      |
| 2 — Temperature        | meastypes 12, 71, 73        | ❌ no                        | up to 1 hour             |
| 44 — Sleep             | sleep summary               | ❌ no (not ingested at all)  | n/a                      |
| 16 — Activity          | steps / distance / calories | ❌ no (not ingested at all)  | n/a                      |
| 54 — ECG               | ECG records                 | ❌ no                        | n/a                      |
| 58 — Glucose           | meastype 119                | ❌ no                        | n/a                      |

**Cadence reasonableness for poll-only fallback:**

- Hourly poll for weight/BP/temperature is fine — those are spot readings made a few times per day.
- For sleep, hourly poll is fine — there's one summary per night.
- For activity, hourly poll would miss the live-step feedback loop entirely. **Activity ingest cannot rely on poll** — it requires webhook.

**v1.4.25 action:** subscribe to `appli=2` and `appli=4` for instant BP / temperature deltas. Cheap. Atomic commit `feat(withings): subscribe to BP + temperature webhooks alongside weight`.

**v1.4.26 action:** add `appli=44` (sleep) and `appli=16` (activity) when those sync routines land.

---

## Section 5 — OAuth scope + subscription tier

| Scope              | Endpoints                                                     | Status                                                                     |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `user.metrics`     | Measure-Getmeas, Heart v2 (BP from cuffs, SpO2, ECG metadata) | ✅ already requested                                                       |
| `users.activity`   | Activity, Sleep                                               | ❌ not requested. Needs scope-string update + user reauth on next connect. |
| `user.info`        | User v2 (devices, profile)                                    | ❌ not requested.                                                          |
| `user.sleepevents` | Bed-in / bed-out / inflate events                             | ❌ not requested. Niche — defer to v1.5.                                   |

**Withings+ subscription:** none of the endpoints listed above require Withings+ on the user side. The "Cardio Check-Up review" is the only Withings+-locked surface that exposes derived data, and it ships as a PDF to the user — there's no API for HealthLog to pull from.

**Developer-app billing tier (partner hub):**

- Basic Biomarker Pack: weight, body fat %, BMR, BP, pulse, SpO2 — covers everything we ingest today.
- Total Biomarker Pack: adds PWV, nerve health, ECG signal, segmental composition. Required for v1.4.26+ work that touches PWV/NHS/segmental.

For HealthLog self-hosters, the partner hub pack is what their **own Withings developer app** gets registered as — we don't pay anything centrally. Document this in the docs so a self-hoster who wants PWV knows to flip their app to Total Biomarker Pack.

---

## Section 6 — Files that need touching for v1.4.25

| File                                          | Change                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/withings/client.ts`                  | Extend `MEASURE_TYPE_MAP` with meastype 12, 35, 71, 123.                                                                                         |
| `src/lib/withings/sync.ts`                    | Call `subscribeWebhook(token, url, 2)` and `subscribeWebhook(token, url, 4)` alongside the existing `appli=1`.                                   |
| `src/lib/withings/__tests__/client.test.ts`   | **New file.** Cover the four new mappings + edge cases (unit exponent, missing fields, unknown meastype).                                        |
| `src/lib/withings/mapping.md`                 | **New file.** Single source-of-truth table of every meastype → MeasurementType. Reference from `client.ts` doc comment.                          |
| `docs/api/openapi.yaml`                       | No change. Endpoint surface didn't change.                                                                                                       |
| `messages/en.json` + `messages/de.json`       | No new user-facing keys needed for the meastype additions — the values surface in existing measurement charts via their already-localised types. |
| `.planning/research/withings-api-coverage.md` | This file (delivered).                                                                                                                           |

For v1.4.26 (NOT in this wave):

- `prisma/schema.prisma` — add `FAT_MASS`, `FAT_FREE_MASS`, `MUSCLE_MASS`, `SKIN_TEMPERATURE`, `PULSE_WAVE_VELOCITY`, `VISCERAL_FAT`, `VASCULAR_AGE` to `MeasurementType` enum.
- `prisma/migrations/0046_withings_body_composition_metrics/migration.sql` — additive enum values.
- `src/lib/validations/measurement.ts` — extend `measurementTypeEnum`, `unitMap`, `VALUE_RANGES`.
- `src/lib/withings/sleep.ts` — **new.** `Sleep v2-Getsummary` client + sync routine.
- `src/lib/withings/activity.ts` — **new.** `Measure v2-Getactivity` client + sync routine.
- OAuth scope string upgrade (`getAuthorizationUrl`): `"user.metrics,users.activity"`.

---

## Section 7 — Implementation plan for v1.4.25

Per the wave brief, atomic commits per logical sub-change. Each test file lives under `src/lib/withings/__tests__/`.

1. `chore(withings): document the full meastype mapping in src/lib/withings/mapping.md` — single source of truth so future additions don't drift.
2. `feat(withings): ingest meastype 12 (legacy temperature) into BODY_TEMPERATURE` — one line in `MEASURE_TYPE_MAP` + test.
3. `feat(withings): ingest meastype 71 (body temperature) into BODY_TEMPERATURE` — same shape.
4. `feat(withings): ingest meastype 35 (legacy SpO2) into OXYGEN_SATURATION` — same shape.
5. `feat(withings): ingest meastype 123 (VO2 max) into VO2_MAX` — same shape.
6. `feat(withings): subscribe to BP + temperature webhooks alongside weight` — extend `setupWebhook` to subscribe to appli 1, 2, and 4. Removes the up-to-1h latency on BP readings, gives real-time temperature deltas to anyone using a Thermo.

Each commit ships green tests (`pnpm test`, `pnpm typecheck`, `pnpm lint`).

---

## Section 8 — Deferred items + rationale

### v1.4.26 (next maintenance wave)

- **Body composition expansion (meastypes 5, 8, 76)** — `FAT_FREE_MASS`, `FAT_MASS`, `MUSCLE_MASS` enum values. Body Comp / Body Scan ships these on every step; not surfacing them feels under-built for Withings owners. Schema migration is purely additive (new enum values).
- **Skin temperature (meastype 73)** — `SKIN_TEMPERATURE` enum. Distinct physiology from core body temp.
- **Pulse wave velocity (meastype 91)** + **Vascular age (meastype 155)** — Body Cardio / Body Scan exclusive; defer until enum expansion lands.
- **Visceral fat (meastype 170)** — same wave.
- **Sleep v2 sync (Getsummary)** — duration into `SLEEP_DURATION` minutes, per-stage rows via `SleepStage`, `sdnn_1` into `HEART_RATE_VARIABILITY`. Pairs cleanly with W4-shipped sleep chart at `/insights/schlaf` which already renders `SleepStage` rows.
- **Activity sync (Getactivity)** — steps + distance + calories into existing enums (`ACTIVITY_STEPS`, `WALKING_RUNNING_DISTANCE`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`). Requires OAuth scope upgrade — every existing connection must reconnect once. Plan a one-time banner in Settings explaining the reconnect.
- **Webhook subscriptions appli=16 (activity) and appli=44 (sleep)** — paired with the above sync routines.

### v1.5 (paired with iOS app)

- **ECG signal (Heart-Get)** — 30 s × 500 Hz blob per capture; needs storage strategy (signed-URL object store? Postgres `bytea`?), retention policy, and the "this is not a diagnosis" disclaimer copy reviewed by Marc before shipping.
- **AFib events (Heart-List + appli=54)** — needs `CardiacEvent` model and an alerting policy. Clinical-adjacent: requires careful product copy to avoid "HealthLog detected AFib" → "Withings detected AFib, here's the record" framing.
- **Workouts (Getworkouts)** — needs `Workout` model: sport type, start/end, distance, calories, GPS polyline. iOS app context first because workouts will round-trip through Apple Health and ordering matters.
- **Intraday activity** — per-minute samples; storage/aggregation strategy needs analytics-side work before we ingest.
- **Devices list (User-Getdevice)** — surfaced as a "Connected devices" badge under Settings → Integrations.
- **Height (meastype 4)** — `User.heightCm` last-write-wins, not a `Measurement` row.
- **Segmental composition (meastypes 174/175)** — JSON sub-document or per-limb measurement variant; decide once we have a Body Scan device in test.
- **Nerve health (167) / Extracellular & Intracellular Water (168/169) / Electrodermal Activity (196)** — Body Scan-exclusive niche.

### Skip with rationale

- **Withings+ derived metrics (Health Improvement Score, Vitality Indicator, Cardio Check-Up cardiologist review)** — not exposed by the public API. Computed inside Withings' app, not reachable by any partner. Cross-reference `.planning/research/withings-plus-comparison.md` §6 — HealthLog's own AI surfaces (Health Score, Coach, briefing) are the answer here.
- **Sleep events appli=50/51/52 (bed-in / bed-out / inflate)** — niche; only useful with a Withings Sleep Analyzer mat. Defer indefinitely; we'd surface them only if a user explicitly asks.

---

## Section 9 — Forward compatibility note

The mapping table in `src/lib/withings/mapping.md` is intended as the single place to grep when Withings ships a new meastype. When the Health Mate app surfaces a new metric:

1. Find the numeric meastype in Withings' developer guide (`developer.withings.com/developer-guide/v3/data-api/all-available-health-data`).
2. Check if HealthLog's `MeasurementType` enum has a slot. If yes, one-line addition to `MEASURE_TYPE_MAP`. If no, additive migration first.
3. Add a unit test fixture for the new meastype.
4. Update `mapping.md`.

Marketing-side: the docs site `features/integrations.mdx` carries a forward-compatibility note that points back to this audit. The audit is updated each marathon, so the docs always link the latest coverage.

---

## Sources

- [Withings API Reference (developer.withings.com)](https://developer.withings.com/api-reference)
- [Withings Developer Guide — Data API → All Available Health Data](https://developer.withings.com/developer-guide/v3/integration-guide/bulkship-sdk/data-api/all-available-health-data)
- [Withings Developer Guide — Data API → Keep User Data Up To Date (notifications)](https://developer.withings.com/developer-guide/v3/integration-guide/advanced-research-api/data-api/keep-user-data-up-to-date)
- [Withings API — Measure (getmeas)](https://developer.withings.com/api-reference#tag/measure)
- [Withings API — Sleep (sleepv2-get / getsummary)](https://developer.withings.com/api-reference#tag/sleep)
- [Withings API — Heart v2 (list / get)](https://developer.withings.com/api-reference#tag/heart)
- [Withings API — Measure v2 (getactivity / getintradayactivity / getworkouts)](https://developer.withings.com/api-reference#tag/activity)
- [Withings API — Notify (subscribe / list / revoke)](https://developer.withings.com/api-reference#tag/notify)
- HealthLog: `src/lib/withings/{client.ts, sync.ts, credentials.ts}`
- HealthLog: `prisma/schema.prisma` — `MeasurementType`, `MeasurementSource`, `SleepStage`
- HealthLog: `.planning/research/withings-plus-comparison.md` — v1.4.24 Withings+ feature comparison
