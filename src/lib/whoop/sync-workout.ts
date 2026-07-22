/**
 * WHOOP workout sync. Fetches workout activities since the incremental cursor
 * and upserts each into the `Workout` table as `source = WHOOP`, keyed on
 * `(userId, source, externalId)` so a re-score overwrites in place.
 *
 * Per-workout strain (`WORKOUT_STRAIN`), HR-zone durations, `percent_recorded`,
 * and altitude live in `Workout.metadata` (tied to the workout row) rather than
 * as free-floating Measurements — a phantom strain Measurement would survive
 * if the workout were later de-duped away by the read-time picker. Energy is
 * converted kJ→kcal via `KJ_TO_KCAL` for `totalEnergyKcal`.
 *
 * A WHOOP run and the same run via Apple Health remain two distinct `Workout`
 * rows (different `source`); the read-time `pickCanonicalWorkoutRows` picker
 * (E-slice, W6) collapses the cross-source twin at read time.
 *
 * `sportType` writes the canonical `WorkoutSportType` bucket via
 * `mapWhoopSportType()` (`./sport-map.ts`) — mirroring the Fitbit / Google
 * Health mappers — so a WHOOP row clusters and icons the same as any other
 * source's. Raw `sport_id` / `sport_name` still live in `Workout.metadata`
 * for traceability.
 */
import {
  fetchWorkouts,
  fetchWorkoutById,
  KJ_TO_KCAL,
  type WhoopWorkout,
} from "./client";
import {
  getValidToken,
  incrementalStart,
  handleCollectionFetchError,
  markResourceSynced,
  resolveResourceCursor,
  WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
} from "./sync-core";
import { mapWhoopSportType } from "./sport-map";
import { prisma } from "@/lib/db";
import { emitInsertedWorkoutArrival } from "@/lib/arrivals/workout-emit";
import { getEvent } from "@/lib/logging/context";
import type { Prisma } from "@/generated/prisma/client";

export async function syncUserWorkout(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  const connection = await prisma.whoopConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true, resourceCursors: true },
  });
  if (!connection) return 0;

  // iOS #17 — the WHOOP `/activity/workout` collection filters on the
  // workout's OWN time range, not on when it reached the cloud. A workout
  // whose phone sync lands more than the overlap late then falls permanently
  // before the cursor and is never ingested (operator-visible data loss). A
  // 1 h overlap was far too tight for opportunistic phone sync; widen it to
  // the same window recovery/sleep already use for their late re-scores. The
  // `(userId, WHOOP, externalId)` upsert keeps the re-fetch idempotent and a
  // handful of workouts/day keeps the page count down.
  const start = incrementalStart(resolveResourceCursor(connection, "workout"), {
    fullSync: opts.fullSync,
    overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
  });

  let records: Awaited<ReturnType<typeof fetchWorkouts>>;
  try {
    records = await fetchWorkouts(tokenInfo.accessToken, { start });
  } catch (err) {
    return handleCollectionFetchError("workout", userId, err);
  }

  let imported = 0;
  for (const w of records) {
    imported += await upsertWhoopWorkout(userId, w);
  }

  await markResourceSynced(userId, "workout");
  return imported;
}

/**
 * Webhook-driven targeted refresh: resolve ONE workout by its uuid and upsert
 * it, instead of re-walking the whole collection. This is the direct fix for
 * iOS #17 — a `workout.updated` webhook lands the exact workout immediately,
 * with no dependence on the overlap window catching it. An unscored /
 * since-deleted record yields nothing. Does NOT advance the resource cursor.
 */
export async function syncWhoopWorkoutById(
  userId: string,
  workoutId: string,
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  let record: WhoopWorkout;
  try {
    record = await fetchWorkoutById(tokenInfo.accessToken, workoutId);
  } catch (err) {
    return handleCollectionFetchError("workout", userId, err);
  }

  return upsertWhoopWorkout(userId, record);
}

/**
 * Upsert one WHOOP workout into the `Workout` table keyed on
 * `(userId, source = WHOOP, externalId)`. Returns 1 when a row was written, 0
 * for an unscored record (nothing to store yet) or an upsert failure (logged,
 * never thrown — a single bad record must not fail the surrounding sync).
 * Shared by the collection walk and the webhook-driven fetch-by-id refresh so
 * both write an identical row shape.
 */
export async function upsertWhoopWorkout(
  userId: string,
  w: WhoopWorkout,
): Promise<number> {
  if (!w.score) return 0; // unscored workout — nothing to store yet
  const startedAt = new Date(w.start);
  const endedAt = new Date(w.end);
  const durationSec = Math.max(
    0,
    Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
  );
  const energyKcal =
    typeof w.score.kilojoule === "number"
      ? Math.round(w.score.kilojoule * KJ_TO_KCAL)
      : null;

  const metadata: Prisma.InputJsonValue = {
    whoopWorkoutStrain: w.score.strain,
    percentRecorded: w.score.percent_recorded,
    ...(w.score.altitude_gain_meter != null
      ? { altitudeGainMeter: w.score.altitude_gain_meter }
      : {}),
    ...(w.score.altitude_change_meter != null
      ? { altitudeChangeMeter: w.score.altitude_change_meter }
      : {}),
    ...(w.score.zone_durations
      ? { zoneDurations: w.score.zone_durations }
      : {}),
    // Raw WHOOP sport fields, kept for traceability once mapWhoopSportType()
    // has resolved `Workout.sportType` to a canonical bucket — a support
    // request about a misclassified sport can trace back to exactly what
    // WHOOP sent without re-fetching the workout.
    ...(w.sport_id != null ? { whoopSportId: w.sport_id } : {}),
    ...(w.sport_name ? { whoopSportName: w.sport_name } : {}),
  };

  const row = {
    sportType: mapWhoopSportType(w.sport_id, w.sport_name),
    startedAt,
    endedAt,
    durationSec,
    totalEnergyKcal: energyKcal,
    totalDistanceM: w.score.distance_meter ?? null,
    avgHeartRate: w.score.average_heart_rate ?? null,
    maxHeartRate: w.score.max_heart_rate ?? null,
    elevationM: w.score.altitude_gain_meter ?? null,
    metadata,
  };

  try {
    const [inserted] = await prisma.workout.createManyAndReturn({
      data: {
        userId,
        source: "WHOOP",
        externalId: w.id,
        ...row,
      },
      skipDuplicates: true,
      select: { id: true, startedAt: true },
    });
    if (inserted) {
      void emitInsertedWorkoutArrival(userId, inserted, "whoop").catch(
        () => {},
      );
    } else {
      await prisma.workout.update({
        where: {
          userId_source_externalId: {
            userId,
            source: "WHOOP",
            externalId: w.id,
          },
        },
        data: row,
      });
    }
    return 1;
  } catch (err) {
    getEvent()?.addWarning(`WHOOP: failed to upsert workout: ${err}`);
    return 0;
  }
}
