/**
 * FIT `session.sport` / `session.sub_sport` → HealthLog's canonical
 * `WorkoutSportType`.
 *
 * The decoder hands both over as profile names (`running`, `training`,
 * `strength_training`) or, for a value newer than its profile, as the bare
 * number. The buckets follow the Garmin table (`src/lib/garmin/sport-map.ts`)
 * exactly, because the cross-source duplicate cluster is keyed on the sport:
 * a ride imported from its FIT file has to land in the same bucket as the
 * same ride synced from Garmin Connect, Apple Health or Strava, or the two
 * would not be recognised as one workout.
 *
 * The sub-sport decides first where it names the activity better than the
 * sport does (`training` + `strength_training` is strength, `fitness_equipment`
 * + `elliptical` is the elliptical); otherwise the sport decides; anything
 * unknown lands on `"other"`.
 */
import type { WorkoutSportType } from "@/lib/validations/workout";

const BY_SUB_SPORT: ReadonlyMap<string, WorkoutSportType> = new Map([
  ["strength_training", "strength"],
  ["cardio_training", "mixedCardio"],
  ["hiit", "hiit"],
  ["amrap", "hiit"],
  ["emom", "hiit"],
  ["tabata", "hiit"],
  ["yoga", "yoga"],
  ["pilates", "mindAndBody"],
  ["breathing", "mindAndBody"],
  ["flexibility_training", "mindAndBody"],
  ["elliptical", "elliptical"],
  ["stair_climbing", "stairClimber"],
  ["indoor_rowing", "rowing"],
  ["indoor_climbing", "crossTraining"],
  ["bouldering", "crossTraining"],
  ["badminton", "badminton"],
  ["squash", "tennis"],
  ["padel", "tennis"],
  ["pickleball", "tennis"],
  ["racquetball", "tennis"],
  ["table_tennis", "tennis"],
]);

const BY_SPORT: ReadonlyMap<string, WorkoutSportType> = new Map([
  ["running", "running"],
  ["cycling", "cycling"],
  ["e_biking", "cycling"],
  ["walking", "walking"],
  ["hiking", "hiking"],
  ["mountaineering", "hiking"],
  ["swimming", "swimming"],
  ["rowing", "rowing"],
  ["paddling", "rowing"],
  ["kayaking", "rowing"],
  ["canoeing", "rowing"],
  ["stand_up_paddleboarding", "rowing"],
  ["floor_climbing", "stairClimber"],
  ["fitness_equipment", "crossTraining"],
  ["training", "crossTraining"],
  ["rock_climbing", "crossTraining"],
  ["hiit", "hiit"],
  ["meditation", "mindAndBody"],
  ["mobility", "mindAndBody"],
  ["dance", "dance"],
  ["golf", "golf"],
  ["tennis", "tennis"],
  ["racket", "tennis"],
  ["basketball", "basketball"],
  ["soccer", "soccer"],
]);

export function mapFitSportType(
  sport: unknown,
  subSport: unknown,
): WorkoutSportType {
  if (typeof subSport === "string") {
    const bySub = BY_SUB_SPORT.get(subSport);
    if (bySub) return bySub;
  }
  if (typeof sport === "string") {
    return BY_SPORT.get(sport) ?? "other";
  }
  return "other";
}
