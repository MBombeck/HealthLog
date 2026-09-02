import { z } from "zod/v4";
import { EXTERNAL_SOURCE } from "@/lib/measurements/external-source";
import { validateEntryInstant } from "./entry-instant";

export const measurementTypeEnum = z.enum([
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "BLOOD_GLUCOSE",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "OXYGEN_SATURATION",
  // ── v1.4.23 Apple Health additions ──
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "ACTIVE_ENERGY_BURNED",
  "FLIGHTS_CLIMBED",
  "WALKING_RUNNING_DISTANCE",
  "VO2_MAX",
  "BODY_TEMPERATURE",
  // ── v1.4.25 W5d Withings full coverage ──
  "FAT_FREE_MASS",
  "FAT_MASS",
  "MUSCLE_MASS",
  "SKIN_TEMPERATURE",
  "PULSE_WAVE_VELOCITY",
  "VASCULAR_AGE",
  "VISCERAL_FAT",
  // ── v1.4.25 W8d Apple Health server-prep ──
  "AUDIO_EXPOSURE_ENV",
  "AUDIO_EXPOSURE_HEADPHONE",
  "TIME_IN_DAYLIGHT",
  // ── v1.4.30 R-F T1.4 + T1.5 ──
  "WALKING_STEADINESS",
  "AUDIO_EXPOSURE_EVENT",
  // ── v1.5.5 iOS-coord — six previously-deferred HK identifiers wired end-to-end ──
  "RESPIRATORY_RATE",
  "BODY_MASS_INDEX",
  "LEAN_BODY_MASS",
  "WALKING_HEART_RATE_AVERAGE",
  "WALKING_ASYMMETRY",
  "WALKING_DOUBLE_SUPPORT",
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  // Both ship raw SI on the wire (metres / metres-per-second); see
  // the convention block in `apple-health-mapping.ts`.
  "WALKING_STEP_LENGTH",
  "WALKING_SPEED",
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // Seven previously-deferred quantity identifiers; each ships raw on
  // the wire (identity conversion). See the convention block in
  // `apple-health-mapping.ts`.
  "CARDIO_RECOVERY",
  "WRIST_TEMPERATURE",
  "FALL_COUNT",
  "SIX_MINUTE_WALK_DISTANCE",
  "STAIR_ASCENT_SPEED",
  "STAIR_DESCENT_SPEED",
  "BREATHING_DISTURBANCES",
  // ── v1.10.0 — categorical events (WX-B) ──
  // Discrete device-flagged EVENT rows (value is always 1). The device's
  // own verdict / severity rides in the `rhythmClassification` column.
  "IRREGULAR_RHYTHM_NOTIFICATION",
  "HIGH_HEART_RATE_EVENT",
  "LOW_HEART_RATE_EVENT",
  "WALKING_STEADINESS_EVENT",
  "BREATHING_DISTURBANCE_EVENT",
  // ── v1.10.0 — computed scores (WX-C) ──
  // Server-derived wellness scores (0–100, unit `score`). Minted by a
  // nightly engine from the user's already-stored signals and persisted as a
  // `COMPUTED`-source row — never ingested from a client (the batch +
  // single-POST write surfaces reject the COMPUTED source). Only
  // RECOVERY_SCORE is computed in v1.10.0; the other two are defined now so
  // the later engines that compute them need no schema change.
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
  // ── v1.11.0 — WHOOP-native score classes (additive) ──
  // Native WHOOP scores ingest server-side as `source = WHOOP`. DAY_STRAIN /
  // HRV_RMSSD are deliberately distinct from STRAIN_SCORE / SDNN
  // HEART_RATE_VARIABILITY so a device-native value never shares a bucket
  // with a derived proxy. See `apple-health-mapping.ts` convention block and
  // `.planning/v1.11-build/epic-A-whoop-buildspec.md` §3.2.
  "HRV_RMSSD",
  "DAY_STRAIN",
  "WORKOUT_STRAIN",
  "SLEEP_PERFORMANCE",
  "SLEEP_EFFICIENCY",
  "SLEEP_CONSISTENCY",
  "SLEEP_NEED",
  "ENERGY_EXPENDITURE_KJ",
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion (additive) ──
  // Daily average / max heart rate ride WHOOP's cycle score (previously
  // fetched but dropped). Kept distinct from spot PULSE / RESTING_HEART_RATE /
  // WALKING_HEART_RATE_AVERAGE: these are the day's whole-cycle aggregates,
  // not a point-in-time or context-specific reading. Sleep disturbance count
  // is the per-night WHOOP `stage_summary.disturbance_count`.
  "AVERAGE_HEART_RATE",
  "MAX_HEART_RATE",
  "SLEEP_DISTURBANCE_COUNT",
  // v1.17.1 — Polar Nightly Recharge + Training Load Pro components ingested
  // server-side as `source = POLAR`. ANS_CHARGE is the HRV-based autonomic
  // charge (distinct from the 1–6 recovery band that maps to RECOVERY_SCORE);
  // CARDIO_LOAD is Polar's device-native cardiovascular-strain figure (distinct
  // from WHOOP DAY_STRAIN and the COMPUTED STRAIN_SCORE).
  "ANS_CHARGE",
  "CARDIO_LOAD",
  // ── v1.17.1 — Oura coverage completion (additive) ──
  // Oura's headline 0–100 Sleep Score (`daily_sleep.score`), distinct from the
  // WHOOP SLEEP_PERFORMANCE / SLEEP_EFFICIENCY sub-scores. The body-temperature
  // deviation is a SIGNED °C offset from the user's baseline
  // (`daily_readiness.temperature_deviation`), not an absolute reading, so it
  // never shares the BODY_TEMPERATURE / SKIN_TEMPERATURE / WRIST_TEMPERATURE
  // buckets. Both ingest server-side as `source = OURA`.
  "SLEEP_SCORE",
  "BODY_TEMPERATURE_DEVIATION",
  // ── v1.19.0 — Oura resilience (additive) ──
  // Oura's daily resilience LEVEL (`daily_resilience.level`) — a categorical
  // band (limited / adequate / solid / strong / exceptional) ORDINAL-ENCODED
  // into the numeric value (limited=1 … exceptional=5), unit `level`. Ingests
  // server-side as `source = OURA`. See `RESILIENCE_LEVELS` in `src/lib/oura/client`.
  "RESILIENCE",
  // ── v1.25 — clinical-signals wave ──
  // PHQ-9 / GAD-7 derived total scores (one row per completed administration;
  // value = total). The raw item answers never ride a Measurement row — they
  // stay in the encrypted MentalHealthAssessment blob.
  "PHQ9_SCORE",
  "GAD7_SCORE",
  // Grip strength (kg), pain Numeric Rating Scale (0–10), waist circumference
  // (cm) + waist-to-height ratio. First-class numeric clinical signals; bands
  // applied at the display edge from the signal registry.
  "GRIP_STRENGTH",
  "PAIN_NRS",
  "WAIST_CIRCUMFERENCE",
  "WAIST_TO_HEIGHT",
  // ── v1.27.9 — screening scores (same assessment contract as PHQ-9/GAD-7,
  // inverted direction: HIGHER is better). WHO-5 stores the reported 0–100
  // percentage (raw sum × 4); SCI stores the 0–32 total.
  "WHO5_SCORE",
  "SCI_SCORE",
]);

/**
 * v1.10.0 — categorical events (WX-B). The closed set of EVENT-class
 * MeasurementTypes. An EVENT row carries `value = 1`, an optional
 * `rhythmClassification` verdict, and never participates in trend / rollup
 * analytics (it is a discrete occurrence, not a continuous reading). Kept
 * as a `Set` so ingest + read paths can branch on "is this an event row?".
 */
export const EVENT_MEASUREMENT_TYPES: ReadonlySet<string> = new Set<string>([
  "IRREGULAR_RHYTHM_NOTIFICATION",
  "HIGH_HEART_RATE_EVENT",
  "LOW_HEART_RATE_EVENT",
  "WALKING_STEADINESS_EVENT",
  "BREATHING_DISTURBANCE_EVENT",
]);

export const glucoseContextEnum = z.enum([
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
]);

export const measurementSourceEnum = z.enum([
  "MANUAL",
  "WITHINGS",
  "IMPORT",
  "APPLE_HEALTH",
  // v1.10.0 — computed scores (WX-C). Server-owned / read-only: a `COMPUTED`
  // row is minted by a nightly engine, never written by a client. It is part
  // of this enum so the read/response shapes (and the iOS decoder) can decode
  // the rows it surfaces; the client-facing write surfaces reject it — see
  // `WRITABLE_MEASUREMENT_SOURCES` and the batch route's `batchSourceEnum`.
  "COMPUTED",
  // v1.11.0 — WHOOP integration. Native WHOOP scores ingest server-side (no
  // client write path). Part of this enum so the read/response shapes (and
  // the iOS decoder) can decode the rows it surfaces.
  "WHOOP",
  // v1.12.0 — Fitbit/Pixel integration via the Google Health API. Server-owned
  // (no client write path), exactly like WHOOP. Part of this enum so the
  // read/response shapes (and the iOS decoder) can decode the rows it surfaces.
  "FITBIT",
  // v1.17.0 — Nightscout glucose integration (F1). Server-owned (no client
  // write path), exactly like WHOOP/FITBIT. Part of this enum so the
  // read/response shapes (and the iOS decoder) can decode the rows it surfaces.
  "NIGHTSCOUT",
  // v1.17.0 — Polar OAuth integration (F4). Server-owned (no client write
  // path), exactly like WHOOP/FITBIT. Part of this enum so the read/response
  // shapes (and the iOS decoder) can decode the rows it surfaces.
  "POLAR",
  // v1.17.0 — Oura OAuth integration (F4). Server-owned (no client write
  // path), exactly like WHOOP/FITBIT. Part of this enum so the read/response
  // shapes (and the iOS decoder) can decode the rows it surfaces.
  "OURA",
  // v1.19.2 — Telegram numeric-reply capture. A reply to a measurement
  // reminder is written server-side from the chat-bound webhook (not the
  // cookie/Bearer client write path), so it carries its own source label.
  // Part of this enum so the read/response shapes (and the iOS decoder) can
  // decode the rows it surfaces; the client-facing write surfaces still
  // reject it (see `WRITABLE_MEASUREMENT_SOURCES` + the batch allowlist).
  "TELEGRAM",
  // v1.22.0 — measurements logged through the confirmed remote MCP write
  // surface under a `health:write`-scoped token. Server-resolved (the row is
  // written in-process over `/mcp`, never through the cookie/Bearer client
  // write path), so it is excluded from `WRITABLE_MEASUREMENT_SOURCES`; part
  // of this enum so the read/response shapes (and the iOS decoder) can decode
  // the rows it surfaces.
  "MCP",
  // v1.26.0 — Fitbit/Pixel + Wear OS via the Google Health API. Server-owned
  // (no client write path), exactly like WHOOP/FITBIT. Part of this enum so the
  // read/response shapes (and the iOS decoder) can decode the rows it surfaces;
  // deliberately absent from `WRITABLE_MEASUREMENT_SOURCES` + the batch
  // allowlist so a client can never forge a GOOGLE_HEALTH-attributed row.
  "GOOGLE_HEALTH",
  // v1.28.x — Strava OAuth integration. Native Strava activities ingest
  // server-side as `source = STRAVA` Workout rows (no client write path),
  // exactly like WHOOP/FITBIT. Part of this enum so the read/response shapes
  // (and the iOS decoder) can decode the rows it surfaces; deliberately absent
  // from `WRITABLE_MEASUREMENT_SOURCES` + the batch allowlist so a client can
  // never forge a STRAVA-attributed row.
  "STRAVA",
  // v1.38.x — measurements pushed in under a `measurements:write` Bearer
  // token (a home-automation bridge, a scale's own uploader). Server-resolved
  // from the credential rather than named by the caller, so it is deliberately
  // absent from `WRITABLE_MEASUREMENT_SOURCES` and the batch allowlist — a
  // source a client could assert would prove nothing about where the reading
  // came from. Part of this enum so the read/response shapes (and the iOS
  // decoder) can decode the rows it surfaces. Unlike the server-owned sources
  // above these rows stay value-editable; see
  // `USER_CORRECTABLE_MEASUREMENT_SOURCES`.
  "EXTERNAL",
]);

/**
 * v1.10.0 — computed scores (WX-C). The subset of `MeasurementSource` a
 * client may attribute on a write. `COMPUTED` is server-owned (a nightly
 * engine mints it) and `WITHINGS` / `IMPORT` are owned by the Withings
 * webhook + CSV importer respectively, so all three are excluded — letting a
 * client forge a row attributed to them would pollute the per-source
 * canonical picker with rows the server never produced. The single-entry
 * POST validates `source` against this set; the batch route mirrors the same
 * exclusion with its own narrower `{APPLE_HEALTH, MANUAL}` allowlist.
 */
export const WRITABLE_MEASUREMENT_SOURCES = ["MANUAL", "APPLE_HEALTH"] as const;

/**
 * v1.10.0 QA — the Zod enum the single-entry POST validates `source` against.
 * Built from `WRITABLE_MEASUREMENT_SOURCES` so the allowlist has one source of
 * truth. A client may only attribute a row it actually owns: `MANUAL` (a
 * hand-entered reading) or `APPLE_HEALTH` (the HealthKit batch's per-row
 * source). `WITHINGS` is owned by the Withings webhook, `IMPORT` by the CSV
 * importer, and `COMPUTED` by the nightly score engines — letting a client
 * forge any of those would pollute the per-source canonical picker with rows
 * the server never produced. The batch route mirrors the same exclusion with
 * its own narrower `{APPLE_HEALTH, MANUAL}` `batchSourceEnum`.
 */
export const writableMeasurementSourceEnum = z.enum(
  WRITABLE_MEASUREMENT_SOURCES,
);

/**
 * v1.38.x — the subset of `MeasurementSource` whose VALUE the owner may still
 * edit after the fact. A strictly different question from the one
 * `WRITABLE_MEASUREMENT_SOURCES` answers, and the two are kept apart on
 * purpose:
 *
 *   - writable  = "may a client ASSERT this source on a write?"
 *   - correctable = "is the number this row carries the user's own to fix?"
 *
 * `EXTERNAL` is no on the first and yes on the second. A client naming it
 * would be forging provenance, so it stays out of the write allowlist — which
 * `/api/meta/capabilities` publishes as `ingest.writeAllowlist`, so widening
 * that constant would tell every client the source is theirs to claim. But the
 * hardware behind an ingest token is the user's own scale, not a provider's
 * reading: the 409 that protects a Withings row ("the value is the provider's,
 * editing it would forge a row the server never received") has no force here,
 * and locking these rows would contradict what the settings card and the
 * Home Assistant guide both promise.
 *
 * Read at exactly one call site — the value-edit gate in
 * `PUT /api/measurements/[id]`. Everything else keeps reading
 * `WRITABLE_MEASUREMENT_SOURCES`; folding the two back together re-conflates
 * the questions above.
 */
export const USER_CORRECTABLE_MEASUREMENT_SOURCES = [
  ...WRITABLE_MEASUREMENT_SOURCES,
  EXTERNAL_SOURCE,
] as const;

const unitMap: Record<string, string> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  // v1.4.23 — sleep duration shifted from hours to minutes so HealthKit
  // category-sample stages can be stored without precision loss. Older
  // surfaces that need hours convert at read time (`minutes / 60`).
  SLEEP_DURATION: "minutes",
  ACTIVITY_STEPS: "steps",
  BLOOD_GLUCOSE: "mg/dL",
  TOTAL_BODY_WATER: "kg",
  BONE_MASS: "kg",
  OXYGEN_SATURATION: "%",
  // ── v1.4.23 Apple Health canonical units ──
  HEART_RATE_VARIABILITY: "ms",
  RESTING_HEART_RATE: "bpm",
  ACTIVE_ENERGY_BURNED: "kcal",
  FLIGHTS_CLIMBED: "flights",
  WALKING_RUNNING_DISTANCE: "m",
  VO2_MAX: "mL/(kg·min)",
  BODY_TEMPERATURE: "celsius",
  // ── v1.4.25 W5d Withings full coverage ──
  FAT_FREE_MASS: "kg",
  FAT_MASS: "kg",
  MUSCLE_MASS: "kg",
  // Distinct from BODY_TEMPERATURE — surface temps run ~32 °C; sharing
  // the bucket would corrupt analytics. Same canonical unit (°C).
  SKIN_TEMPERATURE: "celsius",
  PULSE_WAVE_VELOCITY: "m/s",
  VASCULAR_AGE: "years",
  // Withings reports visceral fat as a 1–12 rating, not a percent. The
  // string mirrors what Withings prints in Health Mate.
  VISCERAL_FAT: "rating",
  // ── v1.4.25 W8d Apple Health server-prep ──
  // Sound-pressure level — A-weighted decibels (dBA). HealthKit reports
  // both audio-exposure metrics in dBASPL; we store the unweighted "dBA"
  // label because the A-weighting is implicit (every HealthKit audio
  // sample carries it). 30 dBA = quiet bedroom; 140 dBA = pain threshold.
  AUDIO_EXPOSURE_ENV: "dBA",
  AUDIO_EXPOSURE_HEADPHONE: "dBA",
  // Daily-rollup pattern (one sample = one day's outdoor-light minutes).
  // 0–1440 covers the 24-hour day; in practice indoor users sit near 0
  // and outdoor athletes accumulate a few hours.
  TIME_IN_DAYLIGHT: "minutes",
  // ── v1.5.5 iOS-coord additions ──
  // Respiratory rate breaths-per-minute — the HK identifier ships as
  // `count/min`; we keep the more conventional clinical label.
  RESPIRATORY_RATE: "breaths/min",
  // BMI kg/m² — HealthKit ships the unitless ratio; the canonical
  // display string mirrors clinical convention.
  BODY_MASS_INDEX: "kg/m²",
  // Lean body mass kg — body-composition partner to FAT_MASS.
  LEAN_BODY_MASS: "kg",
  // Walking heart rate average bpm — daily rollup; distinct from
  // RESTING_HEART_RATE (sleep-window minimum) and spot PULSE.
  WALKING_HEART_RATE_AVERAGE: "bpm",
  // Walking gait percent (0-100 after server-side ×100 scaling).
  // Same convention as WALKING_STEADINESS / BODY_FAT / OXYGEN_SATURATION
  // — see the project convention block in `apple-health-mapping.ts`.
  WALKING_ASYMMETRY: "%",
  WALKING_DOUBLE_SUPPORT: "%",
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  // Step length is metres; speed is metres per second. Both flow
  // raw on the wire — no server-side scaling. The unit strings
  // match HealthKit's `m` / `m/s` defaults.
  WALKING_STEP_LENGTH: "m",
  WALKING_SPEED: "m/s",
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // Cardio recovery is the bpm drop one minute after peak exercise.
  CARDIO_RECOVERY: "bpm",
  // Overnight wrist temperature in °C (absolute reading; Apple's own
  // display frames it as a baseline deviation, we store the reading).
  WRIST_TEMPERATURE: "celsius",
  // Hard-fall detections — a plain count.
  FALL_COUNT: "count",
  // Apple's estimated six-minute-walk-test distance in metres.
  SIX_MINUTE_WALK_DISTANCE: "m",
  // Stair gait speeds — raw metres-per-second (no scaling).
  STAIR_ASCENT_SPEED: "m/s",
  STAIR_DESCENT_SPEED: "m/s",
  // Per-night breathing-disturbance index — a unitless count Apple
  // classifies as NotElevated / Elevated.
  BREATHING_DISTURBANCES: "count",
  // ── v1.10.0 — categorical events (WX-B) ──
  // EVENT rows are dimensionless occurrences (value is always 1). The
  // canonical unit is the bare "event" so any accidental numeric surfacing
  // reads sensibly; the awareness timeline never displays the value.
  IRREGULAR_RHYTHM_NOTIFICATION: "event",
  HIGH_HEART_RATE_EVENT: "event",
  LOW_HEART_RATE_EVENT: "event",
  WALKING_STEADINESS_EVENT: "event",
  BREATHING_DISTURBANCE_EVENT: "event",
  // ── v1.10.0 — computed scores (WX-C) ──
  // Server-derived 0–100 wellness scores. The canonical unit is the bare
  // "score" so the value reads sensibly anywhere it surfaces.
  RECOVERY_SCORE: "score",
  STRESS_SCORE: "score",
  STRAIN_SCORE: "score",
  // ── v1.11.0 — WHOOP-native score classes ──
  // RMSSD HRV is in milliseconds, same canonical unit as the SDNN
  // HEART_RATE_VARIABILITY (different estimator, same dimension).
  HRV_RMSSD: "ms",
  // Day / workout strain ride WHOOP's bounded 0–21 scale; the bare "score"
  // unit reads sensibly wherever the value surfaces (distinct from the
  // 0–100 COMPUTED STRAIN_SCORE).
  DAY_STRAIN: "score",
  WORKOUT_STRAIN: "score",
  // Sleep quality percentages (0–100).
  SLEEP_PERFORMANCE: "%",
  SLEEP_EFFICIENCY: "%",
  SLEEP_CONSISTENCY: "%",
  // Recommended sleep duration in minutes (WHOOP reports ms; mapper ÷60000).
  SLEEP_NEED: "minutes",
  // Day energy expenditure in kilojoules (WHOOP-native; kept in kJ so the
  // device value round-trips rather than being converted to kcal).
  ENERGY_EXPENDITURE_KJ: "kJ",
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion ──
  // Daily average / max heart rate bpm — whole-cycle aggregates, distinct
  // from the spot PULSE / RESTING_HEART_RATE / WALKING_HEART_RATE_AVERAGE.
  AVERAGE_HEART_RATE: "bpm",
  MAX_HEART_RATE: "bpm",
  // Per-night sleep disturbance tally — a plain integer count.
  SLEEP_DISTURBANCE_COUNT: "count",
  // ── v1.17.1 — Polar Nightly Recharge + Training Load Pro components ──
  ANS_CHARGE: "score",
  CARDIO_LOAD: "score",
  // ── v1.17.1 — Oura coverage completion ──
  // Oura's headline 0–100 Sleep Score — bare "score" like the other 0–100 scores.
  SLEEP_SCORE: "score",
  // Signed body-temperature deviation in °C (Oura nightly baseline offset).
  BODY_TEMPERATURE_DEVIATION: "celsius",
  // ── v1.19.0 — Oura resilience ──
  // Ordinal level scale (1=limited … 5=exceptional) — the categorical band
  // encoded into the numeric value. See RESILIENCE_LEVELS in src/lib/oura/client.
  RESILIENCE: "level",
  // ── v1.25 — clinical-signals wave ──
  PHQ9_SCORE: "score",
  GAD7_SCORE: "score",
  // ── v1.27.9 — screening scores ──
  WHO5_SCORE: "score",
  SCI_SCORE: "score",
  GRIP_STRENGTH: "kg",
  PAIN_NRS: "score",
  WAIST_CIRCUMFERENCE: "cm",
  WAIST_TO_HEIGHT: "ratio",
};

export function getUnitForType(type: string): string {
  return unitMap[type] ?? "unknown";
}

// Plausible ranges per measurement type
export const VALUE_RANGES: Record<string, { min: number; max: number }> = {
  WEIGHT: { min: 1, max: 500 },
  BLOOD_PRESSURE_SYS: { min: 40, max: 300 },
  BLOOD_PRESSURE_DIA: { min: 20, max: 200 },
  PULSE: { min: 20, max: 300 },
  BODY_FAT: { min: 1, max: 80 },
  // Minutes (v1.4.23 unit change). Per-stage rows can run from a few
  // seconds (a brief awakening) to 600+ minutes (a long IN_BED block),
  // so the upper bound covers a 24-hour day.
  SLEEP_DURATION: { min: 0, max: 1440 },
  ACTIVITY_STEPS: { min: 0, max: 200000 },
  BLOOD_GLUCOSE: { min: 20, max: 800 }, // mg/dL — covers severe hypo to severe hyperglycemia
  TOTAL_BODY_WATER: { min: 5, max: 100 }, // kg of water — adults typically 30–55 kg
  BONE_MASS: { min: 0.5, max: 8 }, // kg — adult plausibility (typical 2.5–4.5 kg)
  // Pulse oximetry (SpO2). BTS Guideline 2017 + ATS clinical practice put the
  // healthy resting range at 95–100%. We accept down to 50% so a faulty-sensor
  // critically-low reading still gets logged for the doctor to see; below 50%
  // is incompatible with sustained life and almost certainly a sensor glitch.
  OXYGEN_SATURATION: { min: 50, max: 100 },
  // ── v1.4.23 Apple Health ranges ──
  // HRV SDNN ms — Apple's own "high HRV" threshold sits ~80 ms; lows can
  // reach 5–10 ms in stressed/sick samples. 200 ms is a generous upper
  // bound for unusually relaxed athletic windows.
  HEART_RATE_VARIABILITY: { min: 1, max: 200 },
  // Resting HR bpm — endurance athletes can reach the high 30s; severe
  // tachycardia caps below 220.
  RESTING_HEART_RATE: { min: 25, max: 220 },
  // Active energy kcal/sample — a daily-rollup sample tops out around
  // 6–8000 kcal even for ultra-endurance days.
  ACTIVE_ENERGY_BURNED: { min: 0, max: 10000 },
  // Flights — vertical-feet/3 ≈ flights; cap generous.
  FLIGHTS_CLIMBED: { min: 0, max: 1000 },
  // Walking/running distance per sample (metres). 200 km covers an
  // ultra-marathon or a multi-stage day.
  WALKING_RUNNING_DISTANCE: { min: 0, max: 200000 },
  // VO2 max mL/(kg·min) — elite endurance hovers ~85; sedentary floor ~10.
  VO2_MAX: { min: 5, max: 100 },
  // Body temperature °C — survivable lows ~28; severe hyperthermia ~45.
  BODY_TEMPERATURE: { min: 28, max: 45 },
  // ── v1.4.25 W5d Withings full coverage ──
  // Fat-free mass kg — adult plausibility, ~30 kg (small adult) to 120 kg
  // (large lean athlete). Same bounds as weight minus a fat-mass floor.
  FAT_FREE_MASS: { min: 10, max: 250 },
  // Fat mass kg — pairs with FAT_FREE_MASS so totals reconcile to weight.
  FAT_MASS: { min: 0, max: 250 },
  // Muscle mass kg — sub-component of fat-free mass; widest sensible bound.
  MUSCLE_MASS: { min: 5, max: 200 },
  // Skin temperature °C — surface temps run cooler than core. ScanWatch's
  // dermal sensor reports a relative offset that lands in the 25–40 °C
  // band; treat anything outside as a sensor glitch.
  SKIN_TEMPERATURE: { min: 20, max: 45 },
  // Pulse-wave velocity m/s — clinical ranges sit ~4–15 m/s. Higher
  // numbers indicate stiffer arteries (cardiovascular risk).
  PULSE_WAVE_VELOCITY: { min: 1, max: 30 },
  // Vascular age in years — Withings derives this from PWV + chronological
  // age; the value is a "biological age" not a chronological one. Hard cap
  // at 130 because that's the human longevity record.
  VASCULAR_AGE: { min: 10, max: 130 },
  // Visceral fat rating 1–12 (Withings' own scale; not a percent).
  VISCERAL_FAT: { min: 0, max: 30 },
  // ── v1.4.25 W8d Apple Health server-prep ──
  // Audio exposure dBA — Apple's "loud audio" warning sits at 80 dBA;
  // concerts run 100–115 dBA; 140 dBA is the pain threshold. The floor
  // of 30 dBA covers a quiet bedroom; anything below is silence and
  // almost certainly a sensor artefact.
  AUDIO_EXPOSURE_ENV: { min: 30, max: 140 },
  // Headphone audio caps slightly below the open-air upper edge because
  // sealed-driver listening physically cannot reach a concert PA's SPL.
  AUDIO_EXPOSURE_HEADPHONE: { min: 30, max: 140 },
  // Time in daylight (minutes/day) — full 24-hour window. Outdoor work
  // tops the range; sedentary indoor days sit near 0.
  TIME_IN_DAYLIGHT: { min: 0, max: 1440 },
  // ── v1.5.5 iOS-coord additions ──
  // Respiratory rate breaths/min — adult range ~12-20 at rest; severe
  // distress can spike past 40; bradypnea floor ~4. Generous bounds.
  RESPIRATORY_RATE: { min: 3, max: 60 },
  // BMI kg/m² — sub-12 is starvation-class, 70 covers extreme obesity.
  // Outside the band is almost certainly a height-or-weight typo.
  BODY_MASS_INDEX: { min: 8, max: 70 },
  // Lean body mass kg — adult plausibility, ~25 kg (small adult) to
  // 150 kg (extreme lean athlete). Same shape as FAT_FREE_MASS.
  LEAN_BODY_MASS: { min: 10, max: 250 },
  // Walking heart rate average bpm — endurance athletes can sit in
  // the high 70s while walking; ailing or post-stimulant readings can
  // touch 200. Same upper bound as the spot PULSE / RESTING_HEART_RATE.
  WALKING_HEART_RATE_AVERAGE: { min: 30, max: 220 },
  // Gait percent (0-100). Apple ships these as 0..1 fractions; after
  // the ×100 server-side scaling the canonical band is 0..100.
  WALKING_ASYMMETRY: { min: 0, max: 100 },
  WALKING_DOUBLE_SUPPORT: { min: 0, max: 100 },
  // Same ×100-scaled 0..100 percent as its two gait siblings above. The
  // entry was simply missing; the map is the app's plausibility domain AND
  // (via `value-domain.ts`) the answer to "can this metric be negative",
  // so an omission reads as "unknown" on both questions.
  WALKING_STEADINESS: { min: 0, max: 100 },
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  // Step length (metres) — adult walking sits around 0.5–0.8 m; the
  // 0.1 floor captures shuffling gait and the 2.0 ceiling covers
  // unusually tall sprinters without catching obvious sensor noise.
  WALKING_STEP_LENGTH: { min: 0.1, max: 2.0 },
  // Walking speed (m/s) — healthy adult casual gait ≈ 1.2–1.4 m/s;
  // brisk walking tops out near 2.2 m/s before transitioning to a
  // run. The 0.1 floor captures a very slow shuffle; 3.0 covers
  // race-walking record territory.
  WALKING_SPEED: { min: 0.1, max: 3.0 },
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // Cardio recovery (bpm) — the one-minute HR drop after peak exertion.
  // Trained athletes can drop 50+ bpm; an unfit or autonomically
  // impaired recovery sits in the single digits. 0 is a flat (poor)
  // recovery; 100 is a generous ceiling beyond any plausible reading.
  CARDIO_RECOVERY: { min: 0, max: 100 },
  // Wrist temperature (°C) — overnight skin-side reading. Runs cooler
  // than core; the 30–42 band covers the plausible nighttime range and
  // rejects obvious sensor glitches. Same shape as SKIN_TEMPERATURE.
  WRIST_TEMPERATURE: { min: 30, max: 42 },
  // Fall count — a daily tally. A handful in a bad day is plausible;
  // 50 is a generous ceiling that still catches a runaway sensor.
  FALL_COUNT: { min: 0, max: 50 },
  // Six-minute-walk distance (metres). Healthy adults walk ~400–700 m;
  // the 50 m floor captures severe impairment and the 1000 m ceiling
  // covers an unusually fit reading without admitting sensor noise.
  SIX_MINUTE_WALK_DISTANCE: { min: 50, max: 1000 },
  // Stair gait speed (m/s) — slower than level walking. Adult stair
  // ascent sits around 0.4–0.7 m/s, descent slightly faster. The 0.05
  // floor captures a very slow climb; 2.0 is well above any sustained
  // stair pace and rejects a free-fall artefact.
  STAIR_ASCENT_SPEED: { min: 0.05, max: 2.0 },
  STAIR_DESCENT_SPEED: { min: 0.05, max: 2.0 },
  // Breathing-disturbance index (count). A per-night index; 0 is an
  // undisturbed night and the 1000 ceiling is generous headroom over
  // any plausible severe-apnea night.
  BREATHING_DISTURBANCES: { min: 0, max: 1000 },
  // ── v1.10.0 — categorical events (WX-B) ──
  // EVENT rows carry a fixed `value = 1` (one fired event). The range pins
  // the value so a malformed ingest (value 0, or a stray sensor number)
  // is rejected rather than stored as a phantom event.
  IRREGULAR_RHYTHM_NOTIFICATION: { min: 1, max: 1 },
  HIGH_HEART_RATE_EVENT: { min: 1, max: 1 },
  LOW_HEART_RATE_EVENT: { min: 1, max: 1 },
  WALKING_STEADINESS_EVENT: { min: 1, max: 1 },
  BREATHING_DISTURBANCE_EVENT: { min: 1, max: 1 },
  // Loud-listening event flag (env + headphone). One fired event per row, so
  // the floor is 1 — a non-event is not stored. The entry was missing from
  // the map entirely, which let ANY number through ingest, including a
  // negative one. The ceiling stays generous rather than pinned at 1 like the
  // five events above: this type is written only by the iOS client and
  // nothing in this repo asserts the exact value, so the floor is the part
  // that is certain.
  AUDIO_EXPOSURE_EVENT: { min: 1, max: 1000 },
  // ── v1.10.0 — computed scores (WX-C) ──
  // Server-derived 0–100 scores. The plausibility band pins them to the
  // score range so a malformed store (a stray negative or > 100) is rejected.
  RECOVERY_SCORE: { min: 0, max: 100 },
  STRESS_SCORE: { min: 0, max: 100 },
  STRAIN_SCORE: { min: 0, max: 100 },
  // ── v1.11.0 — WHOOP-native score classes ──
  // RMSSD HRV (ms). Same plausibility band as the SDNN variant: lows reach
  // single digits in stressed samples, 200 ms is a generous upper bound for
  // relaxed athletic windows.
  HRV_RMSSD: { min: 1, max: 200 },
  // Day / workout strain on WHOOP's bounded 0–21 scale.
  DAY_STRAIN: { min: 0, max: 21 },
  WORKOUT_STRAIN: { min: 0, max: 21 },
  // Sleep quality percentages (0–100).
  SLEEP_PERFORMANCE: { min: 0, max: 100 },
  SLEEP_EFFICIENCY: { min: 0, max: 100 },
  SLEEP_CONSISTENCY: { min: 0, max: 100 },
  // Recommended sleep duration in minutes — 0..1440 covers the 24-hour day.
  SLEEP_NEED: { min: 0, max: 1440 },
  // Day energy expenditure in kJ — 50 000 kJ (~12 000 kcal) is a generous
  // ceiling over any plausible ultra-endurance day.
  ENERGY_EXPENDITURE_KJ: { min: 0, max: 50000 },
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion ──
  // Daily average / max heart rate bpm — same plausibility band as the
  // spot PULSE: endurance athletes touch the 30s at rest, severe
  // tachycardia caps below 300.
  AVERAGE_HEART_RATE: { min: 20, max: 300 },
  MAX_HEART_RATE: { min: 20, max: 300 },
  // Per-night sleep disturbance count — 0 is an undisturbed night; 200 is a
  // generous ceiling over any plausible severely-fragmented night.
  SLEEP_DISTURBANCE_COUNT: { min: 0, max: 200 },
  // ── v1.17.1 — Polar Nightly Recharge + Training Load Pro components ──
  // ANS charge is a baseline-relative autonomic deviation that can run
  // negative; a generous symmetric ±100 band covers any plausible reading.
  // Cardio Load is a non-negative cumulative-strain figure; 1000 is a generous
  // ceiling over any plausible single-day training load.
  ANS_CHARGE: { min: -100, max: 100 },
  CARDIO_LOAD: { min: 0, max: 1000 },
  // ── v1.17.1 — Oura coverage completion ──
  // Sleep Score (0–100), same band as the other score classes.
  SLEEP_SCORE: { min: 0, max: 100 },
  // Body-temperature deviation (°C) — a signed nightly offset centred on 0.
  // Oura clamps its own display near ±1 °C; ±5 °C is a generous band that
  // rejects an obvious sensor glitch while keeping every real illness /
  // luteal-phase swing.
  BODY_TEMPERATURE_DEVIATION: { min: -5, max: 5 },
  // ── v1.19.0 — Oura resilience ──
  // Ordinal level scale: 1 (limited) … 5 (exceptional). The closed encoding
  // never falls outside this band.
  RESILIENCE: { min: 1, max: 5 },
  // ── v1.25 — clinical-signals wave ──
  // PHQ-9 total 0–27, GAD-7 total 0–21 — server-derived from the screener.
  PHQ9_SCORE: { min: 0, max: 27 },
  GAD7_SCORE: { min: 0, max: 21 },
  // ── v1.27.9 — screening scores. WHO-5 reported percentage 0–100 (raw × 4),
  // SCI total 0–32 — both server-derived, higher = better.
  WHO5_SCORE: { min: 0, max: 100 },
  SCI_SCORE: { min: 0, max: 32 },
  // Grip strength kg — a child can read in the single digits, an elite athlete
  // tops ~90 kg; 120 is a generous ceiling that still rejects sensor noise.
  GRIP_STRENGTH: { min: 0, max: 120 },
  // Pain NRS — the validated 0–10 scale; the closed band pins the integer.
  PAIN_NRS: { min: 0, max: 10 },
  // Waist circumference cm — paediatric lows ~30, severe obesity ~250.
  WAIST_CIRCUMFERENCE: { min: 30, max: 250 },
  // Waist-to-height ratio — dimensionless; healthy ~0.4–0.5, the band is
  // generous either side to admit any plausible body habitus.
  WAIST_TO_HEIGHT: { min: 0.2, max: 1.5 },
};

export function validateMeasurementRange(
  type: string,
  value: number,
): string | null {
  const range = VALUE_RANGES[type];
  if (range && (value < range.min || value > range.max)) {
    return `Value must be between ${range.min} and ${range.max}`;
  }
  return null;
}

/**
 * v1.6.0 — notes cap raised from 25 to 200. A 25-char limit could not
 * hold a meaningful clinical note ("took after large meal, felt dizzy
 * standing up"). The DB column is unbounded `String?`; this is the
 * single source of truth the client char-counters import.
 */
export const MEASUREMENT_NOTES_MAX_LENGTH = 200;

export const createMeasurementSchema = z
  .object({
    type: measurementTypeEnum,
    value: z.number(),
    // v1.17 W1b — plausibility bound (shared `validateEntryInstant`): no
    // future instants beyond a 5-min clock-skew tolerance, no instant before
    // 1900. Closes the data-portability gap where a hand-rolled POST could
    // backdate or forward-date a reading arbitrarily.
    measuredAt: validateEntryInstant(
      z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
    ),
    notes: z.string().max(MEASUREMENT_NOTES_MAX_LENGTH).optional(),
    // v1.10.0 QA — validate against the client-writable subset, not the full
    // `MeasurementSource` enum. A client may attribute only `MANUAL` or
    // `APPLE_HEALTH`; `WITHINGS` / `IMPORT` / `COMPUTED` are server-owned and
    // forging them would pollute the per-source canonical picker.
    source: writableMeasurementSourceEnum.optional().default("MANUAL"),
    // Only applies when type === BLOOD_GLUCOSE. The "not on any other type"
    // half is mirrored by a CHECK constraint in Postgres (migrations 0021 +
    // 0274). The "required on a glucose row" half below is a rule of THIS
    // schema only — see the refine.
    glucoseContext: glucoseContextEnum.optional(),
    // v1.4.25 W10 reconcile (code-review M4): the single-entry POST
    // dropped `deviceType` silently because the column existed on
    // `Measurement` and was accepted by the batch route, but never
    // declared in this schema. iOS clients that POST one row at a
    // time (and dashboards that backfill manual rows with device
    // metadata) now persist the tag instead of seeing it disappear.
    // Accepts `null` so a client can explicitly clear the column.
    deviceType: z.string().min(1).max(32).nullable().optional(),
    // v1.18.6 — optional "I feel unwell with this reading" flag. Transient
    // (NOT persisted on the measurement row): it only lifts a confirmed
    // safety-floor escalation from the asymptomatic "contact your doctor"
    // copy to the symptom-coupled emergency copy. Defaults to false/absent —
    // every existing client keeps the asymptomatic posture. Never a diagnosis.
    symptomsPresent: z.boolean().optional(),
  })
  .refine((data) => validateMeasurementRange(data.type, data.value) === null, {
    message: "Value out of plausible range",
  })
  // Deliberately asymmetric with the bulk ingest paths. This schema backs the
  // hand-entry surface, where a person is present at the reading and knows
  // whether it was fasting, after a meal, random or at bedtime — the form
  // always offers the choice, so requiring it costs nothing and keeps the
  // per-context breakdowns meaningful. A sensor or meter export has no such
  // answer per sample, so the CSV import, the JSON import and the device sync
  // paths accept a contextless reading and store NULL rather than guessing.
  // Absence stays absence; it is never widened into a classification.
  .refine(
    (data) =>
      (data.type === "BLOOD_GLUCOSE" && data.glucoseContext !== undefined) ||
      (data.type !== "BLOOD_GLUCOSE" && data.glucoseContext === undefined),
    {
      message:
        "Blood glucose measurements require a context (fasting/postprandial/random/bedtime); other types must not set one.",
      path: ["glucoseContext"],
    },
  );

export const updateMeasurementSchema = z.object({
  // No generic magnitude bound here: the route validates the new value
  // against the row's OWN type through `validateMeasurementRange` after the
  // lookup (the schema cannot know the type — the edit body doesn't carry
  // it). The former `min(0)` also blocked legitimate edits of the signed
  // types (ANS_CHARGE, BODY_TEMPERATURE_DEVIATION).
  value: z.number().optional(),
  // v1.17 W1b — same plausibility bound on the edit path; an edit cannot
  // forward-date a reading into the future nor before 1900.
  measuredAt: validateEntryInstant(
    z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  ).optional(),
  notes: z
    .string()
    .max(
      MEASUREMENT_NOTES_MAX_LENGTH,
      `Note cannot exceed ${MEASUREMENT_NOTES_MAX_LENGTH} characters`,
    )
    .nullable()
    .optional(),
});

/**
 * Query params for `GET /api/personal-records`.
 *
 * Both fields used to be parsed defensively at the route: an unrecognised
 * `metricType` was dropped (which WIDENED the read to every metric rather
 * than narrowing it, so a typo returned more data than asked for) and a
 * garbage `limit` reverted to the default. Neither told the caller anything,
 * so a typo was indistinguishable from an omission. Both are refused now.
 *
 * The 500 ceiling matches every other paginated read on the surface, and it
 * refuses rather than clamps for the same reason: silently serving 500 rows
 * to a caller that asked for 999 999 is another difference nobody is told
 * about.
 */
export const listPersonalRecordsSchema = z.object({
  metricType: measurementTypeEnum.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

export const listMeasurementsSchema = z
  .object({
    type: measurementTypeEnum.optional(),
    from: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional(),
    to: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional(),
    // v1.4.28 FB-D2 — when the chart sends an explicit from/to window the
    // payload is already bounded; lift the per-request ceiling to 5000
    // (still cheaper than the legacy unbounded `while (true)` walk).
    // Callers that omit from/to keep the historical 500-row cap.
    limit: z.coerce.number().int().min(1).max(5000).optional().default(100),
    offset: z.coerce.number().int().min(0).optional().default(0),
    sortBy: z
      .enum(["type", "value", "measuredAt", "source"])
      .optional()
      .default("measuredAt"),
    sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
    // v1.4.28 FB-D2 — bucket hint for range-aware queries. When set the
    // GET handler runs a server-side `date_trunc` aggregation and returns
    // one row per bucket per type rather than the raw measurement rows.
    // Omitting `aggregate` keeps the raw wire shape (iOS contract); the
    // chart-data client must opt in explicitly.
    aggregate: z.enum(["raw", "daily", "weekly", "monthly"]).optional(),
    // v1.4.36 W1 — opt-in source switch for daily-aggregate reads. When
    // `source=rollup` + `aggregate=daily`, the route reads from the
    // persistent `measurement_rollups` DAY buckets instead of running a
    // live `date_trunc` GROUP BY scan over the raw `measurements` table.
    // The chart-data client opts in for the trends-row strip + every
    // sub-page chart so the three parallel daily-aggregate requests stop
    // burning a full table scan each. The route falls back to live SQL
    // when the rollup bucket set is empty for the requested window so
    // brand-new accounts still see correct data on their first chart.
    source: z.enum(["rollup"]).optional(),
    // v1.15.13 — management-list source FILTER. The `source` key above is
    // the rollup-tier opt-in (`["rollup"]`), NOT a source filter, so the
    // filter rides a distinct param. Validated against `MeasurementSource`;
    // threaded into the plain-list `where`. Backed by the `(userId, source,
    // measuredAt)` index (migration 0136).
    sourceEq: measurementSourceEnum.optional(),
    // v1.18.5 — value-range FILTER (backlog G). Narrows the plain list to
    // readings whose `value` falls within an optional `[valueMin, valueMax]`
    // band. Either bound may be omitted for an open-ended range. Coerced
    // from the query string; threaded into the plain-list `where` as a
    // `value: { gte, lte }` range. Server-authoritative; validated min<=max.
    valueMin: z.coerce.number().finite().optional(),
    valueMax: z.coerce.number().finite().optional(),
    // v1.4.37 W7c — list-view "one row per day" mode for cumulative
    // types (steps, active energy, distance, flights, daylight). When
    // `groupBy=day` is set and `type` is a cumulative HK type, the route
    // returns one synthesised row per user-TZ day with `value` = SUM
    // and `sampleCount` = number of per-sample rows behind the bucket.
    // Omitted = legacy per-sample list behaviour (iOS contract stable).
    //
    // v1.4.37 W10 — the route's groupBy=day branch hard-codes `offset:0`
    // in the meta because the collapse runs after the per-sample scan;
    // real pagination would require Postgres-side `date_trunc` grouping
    // and a separate `prisma.count({ distinct: ["dayKey"] })`. Until
    // that lands, reject any caller threading a non-zero offset so the
    // pagination contract isn't silently dropped.
    groupBy: z.enum(["day"]).optional(),
    // v1.4.37 W7c — drill-down to per-sample rows for a single day in
    // the user's IANA timezone. Format `YYYY-MM-DD`; the route resolves
    // the day boundary against the user's `User.timezone`. Used by the
    // expandable list row to reveal the chunks that contributed to the
    // collapsed daily total.
    //
    // v1.4.37 W10 — same offset restriction as `groupBy=day`; the
    // drill-down branch returns a single bounded page rather than a
    // cursor.
    dayKey: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "dayKey must be YYYY-MM-DD")
      // v1.4.37 W10 — a `YYYY-MM-DD` string can satisfy the regex while
      // still being an impossible calendar date (`2026-02-30`,
      // `2026-13-01`). `new Date("2026-02-30T00:00:00Z")` silently
      // overflows to March 2, so the drill-down would return rows from
      // a different day than the user asked for. The same helper feeds
      // the admin drain route, so a malformed CLI invocation has the
      // same blast radius. Reject the impossible shapes at the
      // validator instead.
      .refine((s) => {
        const parsed = new Date(`${s}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime())) return false;
        return s === parsed.toISOString().slice(0, 10);
      }, "dayKey must be a real calendar date (YYYY-MM-DD)")
      .optional(),
  })
  .refine(
    ({ offset, groupBy, dayKey }) =>
      !(offset > 0 && (groupBy === "day" || dayKey != null)),
    {
      message:
        "offset is not supported with groupBy=day or dayKey; use a smaller window or omit offset",
      path: ["offset"],
    },
  )
  // v1.4.38 — surface the drill-down cap on the validator so a caller
  // asking for more than 1000 rows on a per-day branch sees a 422
  // instead of a silent `Math.min(limit, 1000)` clamp inside the
  // route. The drill-down returns at most one phone-only stepCount
  // day's worth of per-sample chunks; 1000 covers the pathological
  // case with room to spare. Callers that want a wider window should
  // omit `dayKey` and use `from` / `to` instead.
  .refine(({ limit, dayKey }) => !(dayKey != null && limit > 1000), {
    message:
      "limit must be <= 1000 when dayKey is set; drill-down responses are capped at 1000 rows",
    path: ["limit"],
  })
  // v1.18.5 — an inverted value range (`valueMin > valueMax`) is a client
  // bug, not an empty result set; reject it at the validator with a 422 so
  // the filter UI can surface the mismatch instead of silently returning
  // zero rows. Open-ended ranges (one bound omitted) pass through.
  .refine(
    ({ valueMin, valueMax }) =>
      valueMin == null || valueMax == null || valueMin <= valueMax,
    {
      message: "valueMin must be <= valueMax",
      path: ["valueMin"],
    },
  );

export const createBatchMeasurementSchema = z.object({
  measurements: z.array(createMeasurementSchema).min(1).max(5),
});

export type CreateMeasurementInput = z.infer<typeof createMeasurementSchema>;
export type CreateBatchMeasurementInput = z.infer<
  typeof createBatchMeasurementSchema
>;
export type UpdateMeasurementInput = z.infer<typeof updateMeasurementSchema>;
export type ListMeasurementsInput = z.infer<typeof listMeasurementsSchema>;
