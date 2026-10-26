/**
 * One-time backfill: metres climbed for workouts stored before v1.44.
 *
 * Since v1.44 a kept GPS track fills `Workout.elevationM` when the workout is
 * written (`route-climb.ts`), and the workout insight reads only that column.
 * Workouts stored earlier with a track but no elevation used to get their
 * climb from the track when the insight was built; this pass writes it into
 * the column once so they keep it.
 *
 * Bounded and resumable: workouts are taken in id order, `BATCH` ids at a
 * time, and each track is opened, reduced to one number and dropped before
 * the next is read, so memory holds one track at most. The last id is stored
 * in `AppSettings.workoutClimbBackfillCursor` after every batch; a restart
 * continues from there, and `done` ends it for good. A track without an
 * altitude channel leaves the column NULL, as before; the cursor has moved
 * past it, so it is never read again. Workouts written after the upgrade
 * already carry their climb, so one pass in id order is complete.
 *
 * Not an AI path: the number lands on the workout row, nothing else.
 */
// account-deletion(file): a one-time column fill behind a cursor; it derives elevation from the route already stored and adds nothing the record did not hold, and a row skipped while its account is pending would stay empty after an undo.
import type { PrismaClient } from "@/generated/prisma/client";
import { readRouteGeometry } from "@/lib/workouts/route-geometry-cipher";
import { routeClimbM } from "@/lib/workouts/route-climb";

export const CLIMB_BACKFILL_DONE = "done";
const BATCH = 100;
const SETTINGS_ID = "singleton";

export interface ClimbBackfillResult {
  scanned: number;
  filled: number;
  done: boolean;
}

type Client = Pick<PrismaClient, "appSettings" | "workout" | "workoutRoute">;

export async function runWorkoutClimbBackfill(input: {
  prisma: Client;
  /** Pause between batches so the pass never crowds out request traffic. */
  pauseMs?: number;
  /** Upper bound on batches in one run; the next run resumes. */
  maxBatches?: number;
}): Promise<ClimbBackfillResult> {
  const {
    prisma,
    pauseMs = 250,
    maxBatches = Number.POSITIVE_INFINITY,
  } = input;
  const settings = await prisma.appSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { workoutClimbBackfillCursor: true },
  });
  let cursor = settings?.workoutClimbBackfillCursor ?? null;
  const result: ClimbBackfillResult = { scanned: 0, filled: 0, done: false };
  if (cursor === CLIMB_BACKFILL_DONE) return { ...result, done: true };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const ids = await prisma.workout.findMany({
      where: {
        elevationM: null,
        route: { isNot: null },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true },
    });
    for (const { id } of ids) {
      result.scanned += 1;
      const route = await prisma.workoutRoute.findUnique({
        where: { workoutId: id },
        select: { geometry: true, geometryEncrypted: true },
      });
      const climb = route ? routeClimbM(readRouteGeometry(route)) : null;
      if (climb !== null) {
        // Only where the column is still empty: a sync that wrote an
        // elevation in the meantime wins.
        const { count } = await prisma.workout.updateMany({
          where: { id, elevationM: null },
          data: { elevationM: climb },
        });
        result.filled += count;
      }
    }
    const finished = ids.length < BATCH;
    cursor = finished ? CLIMB_BACKFILL_DONE : ids[ids.length - 1].id;
    await prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, workoutClimbBackfillCursor: cursor },
      update: { workoutClimbBackfillCursor: cursor },
    });
    if (finished) {
      result.done = true;
      return result;
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return result;
}
