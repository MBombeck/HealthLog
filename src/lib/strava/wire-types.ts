/**
 * The Strava API v3 wire shapes HealthLog reads: the list endpoint's
 * `SummaryActivity` and the per-activity `DetailedActivity`. Shared by the
 * endpoints (`./client.ts`) and the mapper (`./map.ts`).
 */
/** Strava `SummaryActivity` — the list-endpoint shape. Distances are metres,
 * durations seconds, `start_date` a UTC ISO-8601 instant. HR / power fields are
 * present when the activity recorded them; `calories` is NOT (detail only). */
export interface StravaSummaryActivity {
  id: number;
  name?: string | null;
  distance?: number | null;
  moving_time?: number | null;
  elapsed_time?: number | null;
  total_elevation_gain?: number | null;
  type?: string | null;
  sport_type?: string | null;
  start_date?: string | null;
  start_date_local?: string | null;
  average_heartrate?: number | null;
  max_heartrate?: number | null;
  has_heartrate?: boolean | null;
  average_watts?: number | null;
  weighted_average_watts?: number | null;
  device_watts?: boolean | null;
  average_cadence?: number | null;
  trainer?: boolean | null;
  commute?: boolean | null;
  gear_id?: string | null;
}

/** Strava `DetailedActivity` — the per-activity shape. Superset of the summary
 * that additionally carries `calories` (kcal). */
export interface StravaDetailedActivity extends StravaSummaryActivity {
  calories?: number | null;
  description?: string | null;
}
