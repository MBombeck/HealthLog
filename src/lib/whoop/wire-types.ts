/**
 * The WHOOP API v2 wire shapes HealthLog reads: the collection envelope and
 * one interface per record. Shared by the endpoint fetchers (`./client.ts`)
 * and the mappers (`./map.ts`).
 */
/** WHOOP paginated collection envelope: `{ records, next_token }`. */
export interface WhoopCollection<T> {
  records: T[];
  next_token?: string | null;
}

/** Recovery record. `score` is null until WHOOP finishes scoring. */
export interface WhoopRecovery {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: string;
  score: {
    user_calibrating: boolean;
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  } | null;
}

/** Sleep activity record. */
export interface WhoopSleep {
  id: string;
  /**
   * The cycle this sleep belongs to. A v2 recovery is read through its cycle,
   * and the recovery webhook carries the SLEEP id, so the targeted recovery
   * refresh resolves sleep -> cycle -> recovery through this field.
   */
  cycle_id?: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  nap: boolean;
  score_state: string;
  score: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      // Per-night sleep disturbance tally. Optional: older or still-scoring
      // records may omit it.
      disturbance_count?: number;
    };
    sleep_needed: {
      baseline_milli: number;
      need_from_sleep_debt_milli: number;
      need_from_recent_strain_milli: number;
      need_from_recent_nap_milli: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  } | null;
}

/** Physiological cycle (day) record. `id` is an int64. */
export interface WhoopCycle {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end?: string | null;
  score_state: string;
  score: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  } | null;
}

/** Workout activity record. */
export interface WhoopWorkout {
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  sport_id?: number;
  sport_name?: string;
  score_state: string;
  score: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    distance_meter?: number;
    altitude_gain_meter?: number;
    altitude_change_meter?: number;
    zone_durations?: Record<string, number>;
  } | null;
}

/** Body-measurement object (single, not paginated). */
export interface WhoopBodyMeasurement {
  height_meter?: number;
  weight_kilogram?: number;
  max_heart_rate?: number;
}

/** Basic profile object (single, not paginated). */
export interface WhoopProfile {
  user_id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
}
