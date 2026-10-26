/**
 * Oura workouts → `Workout` rows (`source = OURA`).
 *
 * Each Oura workout becomes one row keyed on `(userId, source, externalId)`
 * with the Oura id as `externalId`, so a re-read (the hourly window, a
 * backfill slice, a workout Oura revised) overwrites in place. The write is
 * the same `createManyAndReturn` + `skipDuplicates`, update-on-conflict shape
 * the Polar, WHOOP and Strava ingests use; the arrival event fires only for a
 * fresh insert.
 *
 * Cross-source dedup is not done here: an Oura-detected walk and the same walk
 * from Apple Health stay two rows, and the read-time `pickCanonicalWorkoutRows`
 * collapses the twin by the user's source ladder, like every other provider.
 *
 * `sportType` is the canonical bucket from `mapOuraSportType`; the raw label
 * travels in `metadata.ouraActivity`, with Oura's intensity grade and how the
 * workout was recorded (`manual`, `autodetected`, ...). The person's own name
 * for the workout (`label`) is free text and is not imported.
 */
import { prisma } from "@/lib/db";
import { emitInsertedWorkoutArrival } from "@/lib/arrivals/workout-emit";
import { annotate, getEvent } from "@/lib/logging/context";
import type { Prisma } from "@/generated/prisma/client";
import type { WorkoutSportType } from "@/lib/validations/workout";
import type { OuraWorkout } from "./wire-types";
import { mapOuraSportType } from "./sport-map";

export interface OuraWorkoutRow {
  externalId: string;
  sportType: WorkoutSportType;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  metadata: Prisma.InputJsonValue;
}

function finiteNonNegative(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Map one Oura workout to a row, or null when it has no id or no usable time
 * range (an end before its start included).
 */
export function mapOuraWorkout(w: OuraWorkout): OuraWorkoutRow | null {
  if (typeof w.id !== "string" || w.id === "") return null;
  const startedAt = new Date(w.start_datetime);
  const endedAt = new Date(w.end_datetime);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return null;
  }
  if (endedAt.getTime() < startedAt.getTime()) return null;
  const activity = typeof w.activity === "string" ? w.activity : null;
  const metadata: Prisma.InputJsonValue = {
    ...(activity ? { ouraActivity: activity } : {}),
    ...(typeof w.intensity === "string" ? { ouraIntensity: w.intensity } : {}),
    ...(typeof w.source === "string" ? { ouraSource: w.source } : {}),
  };
  const kcal = finiteNonNegative(w.calories);
  return {
    externalId: w.id,
    sportType: mapOuraSportType(activity),
    startedAt,
    endedAt,
    durationSec: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    totalEnergyKcal: kcal === null ? null : Math.round(kcal),
    totalDistanceM: finiteNonNegative(w.distance),
    metadata,
  };
}

/**
 * Upsert mapped Oura workouts. Every row is attempted; the first failure is
 * rethrown afterwards so a partially written batch is never reported clean.
 * `emitArrivals: false` (the history backfill) writes without arrival events:
 * a workout from three years ago is not news.
 */
export async function upsertOuraWorkouts(
  userId: string,
  rows: readonly OuraWorkoutRow[],
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
      metadata: r.metadata,
    };
    try {
      const [inserted] = await prisma.workout.createManyAndReturn({
        data: { userId, source: "OURA", externalId: r.externalId, ...data },
        skipDuplicates: true,
        select: { id: true, startedAt: true },
      });
      if (inserted) {
        if (emitArrivals) {
          void emitInsertedWorkoutArrival(userId, inserted, "oura").catch(
            () => {},
          );
        }
      } else {
        await prisma.workout.update({
          where: {
            userId_source_externalId: {
              userId,
              source: "OURA",
              externalId: r.externalId,
            },
          },
          data,
        });
      }
      imported += 1;
    } catch (err) {
      getEvent()?.addWarning(`oura: failed to upsert workout: ${err}`);
      if (!hadError) {
        firstError = err;
        hadError = true;
      }
    }
  }
  if (hadError) throw firstError;
  annotate({ action: { name: "oura.workout.ingest", details: { imported } } });
  return imported;
}

/** Map and write one window's workouts; unmappable records are skipped. */
export async function writeOuraWorkouts(
  userId: string,
  workouts: readonly OuraWorkout[],
  opts: { emitArrivals?: boolean } = {},
): Promise<number> {
  const rows: OuraWorkoutRow[] = [];
  for (const w of workouts) {
    const row = mapOuraWorkout(w);
    if (row) rows.push(row);
  }
  return upsertOuraWorkouts(userId, rows, opts);
}
