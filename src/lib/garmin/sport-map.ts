/**
 * Garmin activity `activityType.typeKey` → HealthLog canonical
 * `WorkoutSportType`.
 *
 * Garmin's keys are lowercase snake_case (`running`, `trail_running`,
 * `road_biking`, `lap_swimming`, `strength_training`, ...), and some carry a
 * version suffix (`kayaking_v2`). The bucket choices follow the Oura, Polar
 * and Strava tables (paddle sports → rowing, racket sports → tennis,
 * functional training → crossTraining, mobility and breath work →
 * mindAndBody, snow sports → other), so one real session lands in one bucket
 * whichever source reported it. An unknown key lands on `"other"`; the row
 * still persists and the raw key travels in `Workout.metadata.garminActivity`.
 */
import type { WorkoutSportType } from "@/lib/validations/workout";

const GARMIN_SPORT_TABLE: ReadonlyArray<readonly [string, WorkoutSportType]> = [
  // running
  ["running", "running"],
  ["trail_running", "running"],
  ["treadmill_running", "running"],
  ["track_running", "running"],
  ["indoor_running", "running"],
  ["street_running", "running"],
  ["virtual_run", "running"],
  ["ultra_run", "running"],
  // cycling
  ["cycling", "cycling"],
  ["road_biking", "cycling"],
  ["mountain_biking", "cycling"],
  ["gravel_cycling", "cycling"],
  ["indoor_cycling", "cycling"],
  ["virtual_ride", "cycling"],
  ["cyclocross", "cycling"],
  ["e_bike_fitness", "cycling"],
  ["e_bike_mountain", "cycling"],
  ["bmx", "cycling"],
  ["track_cycling", "cycling"],
  // walking / hiking
  ["walking", "walking"],
  ["casual_walking", "walking"],
  ["speed_walking", "walking"],
  ["indoor_walking", "walking"],
  ["hiking", "hiking"],
  ["mountaineering", "hiking"],
  // water
  ["swimming", "swimming"],
  ["lap_swimming", "swimming"],
  ["open_water_swimming", "swimming"],
  ["rowing", "rowing"],
  ["indoor_rowing", "rowing"],
  ["kayaking", "rowing"],
  ["paddling", "rowing"],
  ["stand_up_paddleboarding", "rowing"],
  // machines
  ["elliptical", "elliptical"],
  ["stair_climbing", "stairClimber"],
  ["floor_climbing", "stairClimber"],
  // strength / intervals / functional
  ["strength_training", "strength"],
  ["hiit", "hiit"],
  ["indoor_cardio", "mixedCardio"],
  ["cardio", "mixedCardio"],
  ["fitness_equipment", "crossTraining"],
  ["bouldering", "crossTraining"],
  ["rock_climbing", "crossTraining"],
  ["indoor_climbing", "crossTraining"],
  // mind and body
  ["yoga", "yoga"],
  ["pilates", "mindAndBody"],
  ["breathwork", "mindAndBody"],
  ["meditation", "mindAndBody"],
  ["mobility", "mindAndBody"],
  // dance
  ["dance", "dance"],
  // ball and racket sports
  ["golf", "golf"],
  ["tennis", "tennis"],
  ["table_tennis", "tennis"],
  ["squash", "tennis"],
  ["padel", "tennis"],
  ["pickleball", "tennis"],
  ["racquetball", "tennis"],
  ["badminton", "badminton"],
  ["basketball", "basketball"],
  ["soccer", "soccer"],
  // persisted outside a bucket
  ["resort_skiing", "other"],
  ["backcountry_skiing", "other"],
  ["cross_country_classic_skiing", "other"],
  ["cross_country_skate_skiing", "other"],
  ["resort_snowboarding", "other"],
  ["inline_skating", "other"],
  ["surfing", "other"],
  ["boxing", "other"],
  ["multi_sport", "other"],
  ["triathlon", "other"],
  ["other", "other"],
];

/** Fold case, drop a `_v2`-style suffix and separators. */
function normaliseGarminTypeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/_v\d+$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

const GARMIN_SPORT_MAP: ReadonlyMap<string, WorkoutSportType> = new Map(
  GARMIN_SPORT_TABLE.map(([key, canonical]) => [
    normaliseGarminTypeKey(key),
    canonical,
  ]),
);

/**
 * Resolve a Garmin `typeKey` to a canonical `WorkoutSportType`; `"other"` for
 * an absent, blank or unknown key. Never returns the raw key.
 */
export function mapGarminSportType(
  typeKey: string | null | undefined,
): WorkoutSportType {
  if (typeof typeKey !== "string" || typeKey.trim() === "") return "other";
  return GARMIN_SPORT_MAP.get(normaliseGarminTypeKey(typeKey)) ?? "other";
}
