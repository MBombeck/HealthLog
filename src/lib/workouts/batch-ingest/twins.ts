/**
 * Hand a would-be new workout's series and track to the stored workout it
 * duplicates, instead of storing a second copy.
 *
 * The batch route keeps a row that loses to a stored twin (the reads hide
 * it). That is right for a phone that re-sends its own sessions, and wrong
 * for a file import: the activity file of a ride that Garmin Connect or
 * Apple Health already synced would land as a hidden row, and the one place
 * the file's heart-rate curve is worth anything, the workout the list shows,
 * would never get it.
 *
 * So an importer that asks for it (`twins: "adopt"`) gets this pass after the
 * plan: an entry the plan would insert is looked up against the stored
 * workouts of its sport around its start, clustered exactly as every read
 * clusters them (`readWorkoutsAroundRange` + `workoutDuplicateClusterKeys`).
 * When it shares a cluster with a stored workout, the canonical one of those
 * (`storedTwinOf`: the source ladder, nearest start first) takes the entry's series and
 * track where it has none, and nothing new is inserted. When the twin
 * already has both, the entry is a plain duplicate.
 */
import type { MeasurementSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { WorkoutPickerRow } from "@/lib/measurements/pick-canonical-workout-rows";
import {
  readWorkoutsAroundRange,
  storedTwinOf,
  WORKOUT_PICK_SELECT,
} from "@/lib/workouts/canonical-read";

import type { EntryResult, PreparedWorkout } from "./entries";
import type { WritePlan } from "./plan";

type StoredRow = WorkoutPickerRow & {
  id: string;
  userId: string;
  samples: { workoutId: string } | null;
  route: { workoutId: string } | null;
};

/** The stored workout an incoming one duplicates, or null. */
async function readStoredTwin(
  userId: string,
  p: PreparedWorkout,
  priorityJson: unknown,
): Promise<StoredRow | null> {
  const startedAt = p.row.startedAt as Date;
  const windowed = await readWorkoutsAroundRange<StoredRow>(
    { from: startedAt, to: startedAt, inclusiveEnd: true },
    (bounds) =>
      prisma.workout.findMany({
        where: { userId, sportType: p.row.sportType, startedAt: bounds },
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
        select: {
          ...WORKOUT_PICK_SELECT,
          userId: true,
          samples: { select: { workoutId: true } },
          route: { select: { workoutId: true } },
        },
      }),
  );
  return storedTwinOf(
    windowed,
    {
      userId,
      sportType: p.row.sportType,
      startedAt,
      durationSec: p.row.durationSec,
      source: (p.row.source ?? "MANUAL") as MeasurementSource,
    },
    priorityJson,
  );
}

/**
 * Move every planned insert that duplicates a stored workout onto that
 * workout: an enrichment when it lacks the series or the track the entry
 * carries, a duplicate otherwise. Mutates `plan` and `results`.
 */
export async function adoptStoredTwins(
  userId: string,
  plan: WritePlan,
  results: EntryResult[],
  priorityJson: unknown,
): Promise<void> {
  const keep: PreparedWorkout[] = [];
  const claimed = new Set(plan.toEnrich.map((e) => e.workoutId));
  for (const p of plan.toInsert) {
    const twin = await readStoredTwin(userId, p, priorityJson);
    if (!twin) {
      keep.push(p);
      continue;
    }
    const samples = p.samples && twin.samples === null ? p.samples : null;
    const route = p.route && twin.route === null ? p.route : null;
    if ((samples || route) && !claimed.has(twin.id)) {
      claimed.add(twin.id);
      plan.toEnrich.push({
        index: p.index,
        workoutId: twin.id,
        samples,
        route,
      });
    } else {
      results[p.index] = { index: p.index, status: "duplicate" };
      plan.duplicates += 1;
    }
  }
  plan.toInsert = keep;
}
