/**
 * The first pass of the workout batch ingest (`POST /api/workouts/batch`):
 * what the ingest answers per entry, and the row, track and series each
 * accepted entry becomes.
 */
import { Prisma } from "@/generated/prisma/client";
import { EXTERNAL_SOURCE } from "@/lib/measurements/external-source";
import type { CreateBatchWorkoutInput } from "@/lib/validations/workout";
import {
  classifyExternalId,
  UNSTABLE_EXTERNAL_ID_REASON,
  type UnstableExternalIdShape,
} from "@/lib/validations/external-id";
import { routeClimbM } from "@/lib/workouts/route-climb";
import { INVALID_SAMPLES_REASON } from "@/lib/workouts/batch-ingest-parse";

export type WorkoutEntry = CreateBatchWorkoutInput["workouts"][number];

/**
 * Per-entry outcome the iOS client uses to advance its sync cursor.
 * `inserted`, `duplicate` and `enriched` all indicate the row landed (or
 * was already present); the client can checkpoint past them identically.
 * `enriched` additionally says the entry's heart-rate series was attached
 * to a workout that had none, which is what lets a history sweep count
 * its own progress. `skipped` covers entries the server refused: an
 * unusable external id, or a `samples` array that failed validation.
 * `updated` says a hand-entered workout (`manual:` id, source MANUAL) was
 * sent again with different values and the stored row now carries them.
 */
export type EntryStatus =
  "inserted" | "duplicate" | "enriched" | "updated" | "skipped";

export interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
}

/** An accepted entry, ready for the duplicate probe and the write. */
export type PreparedWorkout = {
  index: number;
  row: Prisma.WorkoutCreateManyInput;
  route: {
    geometry: unknown;
    sampleTimestamps: unknown;
  } | null;
  /** Route-independent per-workout HR series. NULL when the entry
   *  ships no `samples` array. Persisted to the `WorkoutSamples`
   *  child by FK after the workout row lands. */
  samples: {
    samples: unknown;
    sampleCount: number;
  } | null;
  /** Composite-key probe for the pre-flight findMany. NULL when
   *  the entry has no externalId — those rows always pass through
   *  as "inserted" because the NULL-distinct unique index can never
   *  collide them. */
  dedupKey: { source: string; externalId: string } | null;
};

/**
 * Pre-flight duplicate detection needs per-entry status. The composite
 * unique index is `(userId, source, externalId)` — entries without an
 * `externalId` cannot collide on the key (NULL-distinct semantics), so they
 * always insert as new rows.
 */
export function prepareWorkouts(args: {
  userId: string;
  scoped: boolean;
  keepRoutes: boolean;
  workouts: WorkoutEntry[];
  refusedSampleIndices: ReadonlySet<number>;
}): {
  prepared: PreparedWorkout[];
  results: EntryResult[];
  unstableShapes: UnstableExternalIdShape[];
} {
  const { userId, scoped, keepRoutes, workouts, refusedSampleIndices } = args;
  const results: EntryResult[] = new Array(workouts.length);
  const unstableShapes: UnstableExternalIdShape[] = [];
  const prepared: PreparedWorkout[] = workouts.flatMap((w, index) => {
    // An entry whose series failed validation is refused whole. Storing
    // the workout without the curve the caller asked us to keep would be
    // a silent loss, and the row may well already exist anyway.
    if (refusedSampleIndices.has(index)) {
      results[index] = {
        index,
        status: "skipped",
        reason: INVALID_SAMPLES_REASON,
      };
      return [];
    }

    // The `(userId, source, externalId)` dedup key is only idempotent
    // while the id is STABLE across client launches. An id that rotates
    // per process (an object description carrying a memory address)
    // never matches its own earlier row, so every re-sync mints another
    // workout. Refused per entry — one bad row must not stop the rest of
    // the batch landing.
    const unstable =
      w.externalId === undefined ? null : classifyExternalId(w.externalId);
    if (unstable) {
      unstableShapes.push(unstable);
      results[index] = {
        index,
        status: "skipped",
        reason: UNSTABLE_EXTERNAL_ID_REASON,
      };
      return [];
    }

    return [preparedFor(userId, scoped, keepRoutes, w, index)];
  });
  return { prepared, results, unstableShapes };
}

function preparedFor(
  userId: string,
  scoped: boolean,
  keepRoutes: boolean,
  w: WorkoutEntry,
  index: number,
): PreparedWorkout {
  const durationSec = Math.max(
    0,
    Math.round((w.endedAt.getTime() - w.startedAt.getTime()) / 1000),
  );
  const route =
    w.route && keepRoutes
      ? {
          geometry: w.route.geometry as unknown,
          sampleTimestamps: (w.route.sampleTimestamps ?? null) as unknown,
        }
      : null;
  const samples = w.samples
    ? {
        samples: w.samples as unknown,
        sampleCount: w.samples.length,
      }
    : null;
  const row: Prisma.WorkoutCreateManyInput = {
    userId,
    sportType: w.sportType,
    startedAt: w.startedAt,
    endedAt: w.endedAt,
    durationSec,
    totalEnergyKcal: w.totalEnergyKcal ?? null,
    totalDistanceM: w.totalDistanceM ?? null,
    avgHeartRate: w.avgHeartRate ?? null,
    maxHeartRate: w.maxHeartRate ?? null,
    minHeartRate: w.minHeartRate ?? null,
    stepCount: w.stepCount ?? null,
    // A kept track fills the climb when the source sent none, so the figure
    // lives on the workout row and no reader has to open the track for it.
    elevationM: w.elevationM ?? (route ? routeClimbM(route.geometry) : null),
    pauseDurationSec: w.pauseDurationSec ?? null,
    // `EXTERNAL` under a scoped credential, and nothing else: the route
    // refused any body that named a source, so nothing asserted is
    // discarded here. It also moves the dedup key into its own namespace,
    // so a bridge's ids can never collide with the phone's.
    source: scoped ? EXTERNAL_SOURCE : w.source,
    externalId: w.externalId ?? null,
    externalSourceVersion: w.externalSourceVersion ?? null,
    metadata: w.metadata
      ? (w.metadata as Prisma.InputJsonValue)
      : Prisma.JsonNull,
  };
  return {
    index,
    row,
    route,
    samples,
    dedupKey: w.externalId
      ? {
          source: scoped ? EXTERNAL_SOURCE : w.source,
          externalId: w.externalId,
        }
      : null,
  };
}
