/**
 * Garmin activities → `Workout` rows (`source = GARMIN`).
 *
 * Each activity becomes one row keyed on `(userId, source, externalId)` with
 * Garmin's `activityId` as `externalId`, so a re-read (the hourly window, a
 * backfill slice, an activity edited in Garmin Connect) overwrites in place.
 * The write is the `createManyAndReturn` + `skipDuplicates`, update on
 * conflict shape the Oura, Polar, WHOOP and Strava ingests use; the arrival
 * event fires only for a fresh insert.
 *
 * Cross-source dedup is not done here: a Garmin run and the same run relayed
 * through Apple Health stay two rows, and the read-time
 * `pickCanonicalWorkoutRows` collapses the twin by the source ladder.
 *
 * The activity's name and description are the person's own free text and are
 * not imported; neither are its start coordinates.
 */
import { prisma } from "@/lib/db";
import { emitInsertedWorkoutArrival } from "@/lib/arrivals/workout-emit";
import { annotate, getEvent } from "@/lib/logging/context";
import type { Prisma } from "@/generated/prisma/client";
import type { WorkoutSportType } from "@/lib/validations/workout";

import { parseGarminInstant } from "./map";
import { mapGarminSportType } from "./sport-map";
import type { GarminActivity } from "./wire-types";

export interface GarminWorkoutRow {
  externalId: string;
  sportType: WorkoutSportType;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  stepCount: number | null;
  elevationM: number | null;
  metadata: Prisma.InputJsonValue;
}

function nonNegative(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function wholeOrNull(v: unknown): number | null {
  const n = nonNegative(v);
  return n === null ? null : Math.round(n);
}

/**
 * Map one activity, or null when it has no id, no start, or no positive
 * duration.
 */
export function mapGarminActivity(a: GarminActivity): GarminWorkoutRow | null {
  const id =
    typeof a.activityId === "number" || typeof a.activityId === "string"
      ? String(a.activityId)
      : "";
  if (id === "") return null;
  const startedAt =
    parseGarminInstant(a.beginTimestamp) ?? parseGarminInstant(a.startTimeGMT);
  if (!startedAt) return null;
  // The timer duration is the workout; the elapsed one includes pauses.
  const duration = nonNegative(a.duration) ?? nonNegative(a.elapsedDuration);
  if (duration === null || duration <= 0) return null;
  const elapsed = nonNegative(a.elapsedDuration);
  const span = elapsed !== null && elapsed >= duration ? elapsed : duration;
  const endedAt = new Date(startedAt.getTime() + Math.round(span * 1000));
  const typeKey =
    typeof a.activityType?.typeKey === "string" ? a.activityType.typeKey : null;
  const metadata: Prisma.InputJsonValue = {
    ...(typeKey ? { garminActivity: typeKey } : {}),
    ...(nonNegative(a.aerobicTrainingEffect) !== null
      ? { garminAerobicEffect: a.aerobicTrainingEffect as number }
      : {}),
    ...(nonNegative(a.anaerobicTrainingEffect) !== null
      ? { garminAnaerobicEffect: a.anaerobicTrainingEffect as number }
      : {}),
    ...(nonNegative(a.activityTrainingLoad) !== null
      ? { garminTrainingLoad: a.activityTrainingLoad as number }
      : {}),
  };
  const kcal = nonNegative(a.calories);
  const avgHr = wholeOrNull(a.averageHR);
  const maxHr = wholeOrNull(a.maxHR);
  return {
    externalId: id,
    sportType: mapGarminSportType(typeKey),
    startedAt,
    endedAt,
    durationSec: Math.round(duration),
    totalEnergyKcal: kcal === null ? null : Math.round(kcal),
    totalDistanceM: nonNegative(a.distance),
    avgHeartRate: avgHr && avgHr > 0 ? avgHr : null,
    maxHeartRate: maxHr && maxHr > 0 ? maxHr : null,
    stepCount: wholeOrNull(a.steps),
    elevationM: nonNegative(a.elevationGain),
    metadata,
  };
}

/**
 * Upsert mapped Garmin workouts. Every row is attempted; the first failure is
 * rethrown afterwards so a partly written batch is never reported clean.
 * `emitArrivals: false` (the history backfill) writes without arrival events.
 */
export async function upsertGarminWorkouts(
  userId: string,
  rows: readonly GarminWorkoutRow[],
  opts: { emitArrivals?: boolean } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const emitArrivals = opts.emitArrivals ?? true;
  let imported = 0;
  let firstError: unknown;
  let hadError = false;
  for (const r of rows) {
    const data = {
      sportType: r.sportType,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationSec: r.durationSec,
      totalEnergyKcal: r.totalEnergyKcal,
      totalDistanceM: r.totalDistanceM,
      avgHeartRate: r.avgHeartRate,
      maxHeartRate: r.maxHeartRate,
      stepCount: r.stepCount,
      elevationM: r.elevationM,
      metadata: r.metadata,
    };
    try {
      const [inserted] = await prisma.workout.createManyAndReturn({
        data: { userId, source: "GARMIN", externalId: r.externalId, ...data },
        skipDuplicates: true,
        select: { id: true, startedAt: true },
      });
      if (inserted) {
        if (emitArrivals) {
          void emitInsertedWorkoutArrival(userId, inserted, "garmin").catch(
            () => {},
          );
        }
      } else {
        await prisma.workout.update({
          where: {
            userId_source_externalId: {
              userId,
              source: "GARMIN",
              externalId: r.externalId,
            },
          },
          data,
        });
      }
      imported += 1;
    } catch (err) {
      getEvent()?.addWarning(`garmin: failed to upsert workout: ${err}`);
      if (!hadError) {
        firstError = err;
        hadError = true;
      }
    }
  }
  if (hadError) throw firstError;
  annotate({
    action: { name: "garmin.workout.ingest", details: { imported } },
  });
  return imported;
}
