/**
 * The Polar AccessLink v3 wire shapes HealthLog reads, one interface per
 * collection record. Shared by the endpoint fetchers (`./client.ts`) and the
 * mappers (`./map.ts`).
 */
/** One Polar Nightly Recharge record. */
export interface PolarNightlyRecharge {
  date: string;
  nightly_recharge_status?: number | null;
  ans_charge?: number | null;
  ans_charge_status?: number | null;
  heart_rate_avg?: number | null;
  heart_rate_variability_avg?: number | null;
  breathing_rate_avg?: number | null;
}

/** One Polar Sleep record. Durations are seconds. */
export interface PolarSleep {
  date: string;
  sleep_start_time?: string;
  sleep_end_time?: string;
  light_sleep?: number | null;
  deep_sleep?: number | null;
  rem_sleep?: number | null;
  total_interruption_duration?: number | null;
  sleep_charge?: number | null;
  sleep_score?: number | null;
  heart_rate_samples?: Record<string, number>;
}

/** One current AccessLink daily-activity summary. */
export interface PolarActivity {
  start_time?: string;
  active_calories?: number | null;
  steps?: number | null;
  calories?: number | null;
  /** Estimated walking/running distance derived from steps, in METRES. */
  distance_from_steps?: number | null;
}

/**
 * One Polar Training Load Pro record (cardio-load collection). `cardio_load` is
 * the session/day cardiovascular load figure — Polar's WHOOP-day-strain
 * analogue. `strain` / `tolerance` / `cardio_load_ratio` describe the
 * acute-vs-chronic balance; only `cardio_load` is mapped today (the others are
 * derived ratios we don't surface yet).
 */
export interface PolarCardioLoad {
  date: string;
  cardio_load?: number | null;
  strain?: number | null;
  tolerance?: number | null;
  cardio_load_ratio?: number | null;
}

/** One Polar SpO2 (Elixir pulse-ox) test result. `test_time` is a Unix
 * timestamp in seconds; `blood_oxygen_percent` is the recorded percentage. */
export interface PolarSpo2 {
  source_device_id?: string;
  test_time?: number;
  blood_oxygen_percent?: number | null;
}

// ─── Exercises (workouts) ──────────────────────────────────────

/**
 * One Polar AccessLink exercise (`GET /v3/exercises`) — the stateless list of
 * the last 30 days of uploads. The transaction model is DEPRECATED; this GET
 * carries NO userId in the path (the user is identified by the Bearer token),
 * exactly the shape the v1.31.2 vitals-endpoint fix established.
 *
 * Field types are conservative on purpose — the live payload's exact per-field
 * nullability and the `id` type are not machine-verified, so `id` accepts
 * string OR number (coerced to a stable string externalId) and every optional
 * numeric is guarded before use.
 */
export interface PolarExercise {
  /** Opaque exercise id. Polar's docs leave the type ambiguous; accept either
   *  and coerce to a stable string externalId (never parsed). */
  id?: string | number | null;
  /** ISO-8601 local start time, e.g. `"2026-06-10T07:00:00"`. May or may not
   *  carry a zone suffix — handled defensively at map time. */
  start_time?: string | null;
  /** Minutes east of UTC for `start_time`. Combined with `start_time` to
   *  recover the true UTC instant. */
  start_time_utc_offset?: number | null;
  /** ISO-8601 duration, e.g. `"PT2H44M30S"`. */
  duration?: string | null;
  /** Coarse sport enum, e.g. `"RUNNING"`. */
  sport?: string | null;
  /** Granular sport enum, e.g. `"TRAIL_RUNNING"`. */
  detailed_sport_info?: string | null;
  calories?: number | null;
  /** Distance in METRES. */
  distance?: number | null;
  heart_rate?: {
    average?: number | null;
    maximum?: number | null;
  } | null;
  training_load?: number | null;
  device?: string | null;
  device_id?: string | null;
}
