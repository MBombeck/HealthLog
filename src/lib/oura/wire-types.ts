/**
 * The Oura Cloud API v2 wire shapes HealthLog reads: the collection
 * envelope and one interface per collection record. Shared by the endpoint
 * fetchers (`./client.ts`) and the mappers (`./map.ts`).
 */
/** v2 paginated envelope: `{ data, next_token }`. */
export interface OuraCollection<T> {
  data: T[];
  next_token?: string | null;
}

export interface OuraSleep {
  id: string;
  day: string;
  /**
   * `long_sleep` | `sleep` | `late_nap` | `rest` | `deleted`. `rest` is a
   * detected period the person rejected and `deleted` one they removed; see
   * `isRetiredOuraSleepPeriod`.
   */
  type?: string | null;
  bedtime_start?: string;
  bedtime_end?: string;
  total_sleep_duration?: number | null;
  time_in_bed?: number | null;
  efficiency?: number | null;
  rem_sleep_duration?: number | null;
  deep_sleep_duration?: number | null;
  light_sleep_duration?: number | null;
  awake_time?: number | null;
  average_heart_rate?: number | null;
  lowest_heart_rate?: number | null;
  average_hrv?: number | null;
  average_breath?: number | null;
  /**
   * 5-minute hypnogram: one digit per 5-min interval from `bedtime_start`.
   * Oura's measured per-stage timeline — `1`=deep, `2`=light, `3`=rem,
   * `4`=awake. Re-verify the digit→stage mapping against
   * `cloud.ouraring.com/v2/docs` at build time (the encoding is published in
   * the `Sleep` model; cross-checked against the `oura-api`/`@pinta365/oura-api`
   * client libraries). Unlike WHOOP — which exposes only stage totals and must
   * synthesise an order — Oura gives the real onsets, so we emit timed
   * per-segment rows (`reconstructed: false`).
   */
  sleep_phase_5_min?: string | null;
}

/**
 * Oura `daily_readiness` contributors — each a 1–100 sub-score that explains
 * the headline readiness number. All optional (a record may predate a
 * contributor or carry a null for a missing input).
 */
export interface OuraReadinessContributors {
  activity_balance?: number | null;
  body_temperature?: number | null;
  hrv_balance?: number | null;
  previous_day_activity?: number | null;
  previous_night?: number | null;
  recovery_index?: number | null;
  resting_heart_rate?: number | null;
  sleep_balance?: number | null;
}

export interface OuraReadiness {
  id: string;
  day: string;
  timestamp?: string;
  score?: number | null;
  contributors?: OuraReadinessContributors | null;
  /** Nightly body-temperature deviation from the personal baseline, °C (signed). */
  temperature_deviation?: number | null;
  /** Long-term body-temperature trend deviation, °C (signed). */
  temperature_trend_deviation?: number | null;
}

/** Oura `daily_sleep` — the headline Sleep Score (distinct from `sleep` detail). */
export interface OuraDailySleep {
  id: string;
  day: string;
  timestamp?: string;
  score?: number | null;
}

/** Oura `daily_spo2` — average overnight blood-oxygen saturation. */
export interface OuraDailySpo2 {
  id: string;
  day: string;
  spo2_percentage?: { average?: number | null } | null;
}

/** Oura `vO2_max` — the dedicated cardio-fitness collection, mL/(kg·min). */
export interface OuraVo2Max {
  id: string;
  day: string;
  timestamp?: string;
  vo2_max?: number | null;
}

/**
 * Oura `daily_cardiovascular_age` — Oura's estimate of how the user's
 * cardiovascular system is ageing relative to chronological age, in years.
 * Maps cleanly onto the existing `VASCULAR_AGE` enum (the same years-unit
 * arterial-age concept Withings' Body Scan reports under meastype 155).
 */
export interface OuraCardiovascularAge {
  id?: string;
  day: string;
  /** Estimated vascular age in years. */
  vascular_age?: number | null;
}

/**
 * Oura `daily_resilience` — the daily resilience LEVEL, a categorical band
 * describing how well the body copes with cumulative load. The headline is the
 * `level` string (limited / adequate / solid / strong / exceptional); the
 * collection also carries `contributors` (sleep_recovery / daytime_recovery /
 * stress) which we do NOT ingest — we capture only the headline level.
 * Re-verify the `level` field name + value set against
 * `cloud.ouraring.com/v2/docs` at build time.
 */
export interface OuraResilience {
  id?: string;
  day: string;
  /** limited | adequate | solid | strong | exceptional */
  level?: string | null;
}

/**
 * Oura `daily_cycle_phases` — the per-day Cycle Insights phase estimate
 * (temperature-deviation-derived). UNDOCUMENTED in the published OpenAPI
 * spec at `cloud.ouraring.com/v2/docs` as of this writing — the route was
 * confirmed live against the production API (`GET
 * /v2/usercollection/daily_cycle_phases` 400s "Token is missing" identically
 * to every documented `daily_*` collection when called unauthenticated, vs a
 * genuine 404 for an unknown path) but sits outside the spec dump alongside
 * every other Oura reproductive-health resource (`period_start`,
 * `pregnancy`, `fertile_window`, `ovulation_confirmed`, `blood_glucose` — all
 * listed as valid webhook subscription data types, none with a documented
 * read schema). These look gated behind an approval Oura does not extend to
 * a self-registered OAuth app by default, so a 403/404 here is the EXPECTED
 * outcome for most connections, not an anomaly — see `syncUserOuraCyclePhases`
 * in `./cycle-sync` for how that is swallowed without touching the rest of
 * the Oura connection's health status. Re-verify the `phase` field name +
 * value set against `cloud.ouraring.com/v2/docs` once Oura documents it.
 */
export interface OuraCyclePhase {
  id?: string;
  day: string;
  /**
   * Oura's public Cycle Insights copy describes exactly two ring-observable
   * phases (`follicular` / `luteal`, temperature-derived); some algorithm
   * versions may additionally emit `menstrual` directly. Kept as a loose
   * string — an unrecognised / missing value is skipped, never guessed (see
   * `derivePeriodDaysFromCyclePhases`).
   */
  phase?: string | null;
}

export interface OuraDailyActivity {
  id: string;
  day: string;
  timestamp?: string;
  steps?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
  /**
   * Oura's activity-equivalent distance, metres: what a walk of the day's
   * effort would have covered. Not distance travelled; never imported (see
   * `mapDailyActivity`).
   */
  equivalent_walking_distance?: number | null;
}

/**
 * Oura `workout` — one activity session, auto-detected or entered. `activity`
 * is Oura's own lowercase label (`walking`, `cycling`, `strength_training`,
 * ...); `distance` is metres actually covered (a GPS or step-derived figure,
 * unlike the daily activity-equivalent distance); `calories` is kcal.
 */
export interface OuraWorkout {
  id: string;
  day?: string;
  activity?: string | null;
  calories?: number | null;
  distance?: number | null;
  start_datetime: string;
  end_datetime: string;
  /** `easy` | `moderate` | `hard` */
  intensity?: string | null;
  /** `manual` | `autodetected` | `confirmed` | `workout_heart_rate` */
  source?: string | null;
  /** A name the person gave the workout. Free text; never imported. */
  label?: string | null;
}

/** One `heartrate` sample: a reading at an instant, tagged with its context. */
export interface OuraHeartRateSample {
  bpm?: number | null;
  /** `awake` | `rest` | `sleep` | `session` | `live` | `workout` */
  source?: string | null;
  timestamp?: string | null;
}
