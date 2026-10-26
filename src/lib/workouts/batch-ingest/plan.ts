/**
 * What each surviving entry of a workout batch does to the store: insert a
 * new workout, hand a stored one its heart-rate series, correct a
 * hand-entered one in place, or nothing (a duplicate).
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

import type { EntryResult, PreparedWorkout } from "./entries";

/** The workout columns a hand-entered workout's resubmit may overwrite. */
export const MANUAL_OVERWRITE_FIELDS = [
  "sportType",
  "startedAt",
  "endedAt",
  "durationSec",
  "totalEnergyKcal",
  "totalDistanceM",
  "avgHeartRate",
  "maxHeartRate",
  "minHeartRate",
  "stepCount",
  "elevationM",
  "pauseDurationSec",
] as const;
type ManualOverwriteField = (typeof MANUAL_OVERWRITE_FIELDS)[number];
export type ManualOverwriteValues = {
  [K in ManualOverwriteField]: string | number | Date | null;
};

/**
 * A workout entered by hand carries one id per form opening, and the form
 * resends it with the edited values when the person corrects a submit. Such a
 * resubmit is an edit of the stored row, the way a `stats:` measurement
 * re-post is. Every other id stays first-write-wins.
 */
function isManualOverwrite(source: unknown, externalId: string | null) {
  return (
    source === "MANUAL" &&
    externalId !== null &&
    externalId.startsWith("manual:")
  );
}

/** The changed columns of a manual resubmit, or null when nothing differs. */
function manualOverwriteChanges(
  stored: ManualOverwriteValues,
  sent: Prisma.WorkoutCreateManyInput,
): Partial<ManualOverwriteValues> | null {
  const changes: Partial<ManualOverwriteValues> = {};
  for (const field of MANUAL_OVERWRITE_FIELDS) {
    const next = (sent[field] ?? null) as string | number | Date | null;
    const prev = stored[field];
    const same =
      next instanceof Date && prev instanceof Date
        ? next.getTime() === prev.getTime()
        : next === prev;
    if (!same) changes[field] = next;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

export interface WritePlan {
  toInsert: PreparedWorkout[];
  /** Stored workouts this batch hands a heart-rate series to. */
  toEnrich: Array<{
    index: number;
    workoutId: string;
    samples: NonNullable<PreparedWorkout["samples"]>;
  }>;
  /** Hand-entered workouts this batch edits in place. */
  toOverwrite: Array<{
    index: number;
    workoutId: string;
    externalId: string;
    changes: Partial<ManualOverwriteValues>;
  }>;
  /** Survivors already settled as duplicates by the probe. */
  duplicates: number;
}

type StoredWorkout = {
  id: string;
  hasSeries: boolean;
  values: ManualOverwriteValues;
};

/**
 * Only the write-time dedup survivors are probed against existing rows; the
 * dropped twins already carry a `duplicate` status and never reach the DB.
 *
 * The same probe answers both questions: does the row exist, and does it
 * already carry a series. `id` comes along so an enrichment can address the
 * stored workout without a second round trip.
 */
async function readStoredWorkouts(
  userId: string,
  survivors: PreparedWorkout[],
): Promise<Map<string, StoredWorkout>> {
  const dedupCandidates = survivors
    .map((p) => p.dedupKey)
    .filter((k): k is { source: string; externalId: string } => k !== null);

  const existing = dedupCandidates.length
    ? await prisma.workout.findMany({
        where: {
          userId,
          OR: dedupCandidates.map((k) => ({
            source: k.source as Prisma.WorkoutCreateManyInput["source"],
            externalId: k.externalId,
          })),
        },
        select: {
          id: true,
          source: true,
          externalId: true,
          samples: { select: { workoutId: true } },
          sportType: true,
          startedAt: true,
          endedAt: true,
          durationSec: true,
          totalEnergyKcal: true,
          totalDistanceM: true,
          avgHeartRate: true,
          maxHeartRate: true,
          minHeartRate: true,
          stepCount: true,
          elevationM: true,
          pauseDurationSec: true,
        },
      })
    : [];

  const existingByKey = new Map<string, StoredWorkout>();
  for (const row of existing) {
    if (row.externalId === null) continue;
    existingByKey.set(`${row.source}::${row.externalId}`, {
      id: row.id,
      hasSeries: row.samples !== null,
      values: {
        sportType: row.sportType,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationSec: row.durationSec,
        totalEnergyKcal: row.totalEnergyKcal,
        totalDistanceM: row.totalDistanceM,
        avgHeartRate: row.avgHeartRate,
        maxHeartRate: row.maxHeartRate,
        minHeartRate: row.minHeartRate,
        stepCount: row.stepCount,
        elevationM: row.elevationM,
        pauseDurationSec: row.pauseDurationSec,
      },
    });
  }
  return existingByKey;
}

/** Decide every survivor's write, settling the duplicates on the way. */
export async function planWorkoutWrites(
  userId: string,
  survivors: PreparedWorkout[],
  results: EntryResult[],
): Promise<WritePlan> {
  const existingByKey = await readStoredWorkouts(userId, survivors);
  const plan: WritePlan = {
    toInsert: [],
    toEnrich: [],
    toOverwrite: [],
    duplicates: 0,
  };
  /** Workouts already claimed by an earlier entry of THIS batch. */
  const enrichClaimed = new Set<string>();
  for (const p of survivors) {
    const keyTuple = p.dedupKey
      ? `${p.dedupKey.source}::${p.dedupKey.externalId}`
      : null;
    const known = keyTuple !== null ? existingByKey.get(keyTuple) : undefined;
    if (
      known &&
      p.dedupKey &&
      isManualOverwrite(p.dedupKey.source, p.dedupKey.externalId)
    ) {
      const changes = enrichClaimed.has(known.id)
        ? null
        : manualOverwriteChanges(known.values, p.row);
      if (changes) {
        enrichClaimed.add(known.id);
        plan.toOverwrite.push({
          index: p.index,
          workoutId: known.id,
          externalId: p.dedupKey.externalId,
          changes,
        });
      } else {
        results[p.index] = { index: p.index, status: "duplicate" };
        plan.duplicates += 1;
      }
    } else if (known) {
      if (p.samples && !known.hasSeries && !enrichClaimed.has(known.id)) {
        enrichClaimed.add(known.id);
        // Enrichment. The status is assigned after the write, because
        // a concurrent writer may get the series in first — in which
        // case this entry is the plain duplicate it always was. A
        // second entry of this batch naming the same workout takes the
        // duplicate arm above: one workout, one series, one `enriched`.
        plan.toEnrich.push({
          index: p.index,
          workoutId: known.id,
          samples: p.samples,
        });
      } else {
        results[p.index] = { index: p.index, status: "duplicate" };
        plan.duplicates += 1;
      }
    } else {
      results[p.index] = { index: p.index, status: "inserted" };
      plan.toInsert.push(p);
    }
  }
  return plan;
}
