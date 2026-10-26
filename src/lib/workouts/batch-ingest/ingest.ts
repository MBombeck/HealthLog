/**
 * The workout batch ingest behind `POST /api/workouts/batch`, from a parsed
 * and admitted batch to the per-entry answer: the first pass, the write-time
 * cross-source dedup, the duplicate probe and plan, the write, then the
 * audit row, the record detection, the wide event, the cache and the
 * arrivals. The route owns authentication, the rate limit, the body caps and
 * the response envelope.
 */
import type { Prisma } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { unstableExternalIdMeta } from "@/lib/validations/external-id";
import { batchWorkoutIndicesToKeep } from "@/lib/workouts/batch-dedup";

import {
  prepareWorkouts,
  type EntryResult,
  type WorkoutEntry,
} from "./entries";
import { planWorkoutWrites } from "./plan";
import { writeWorkoutPlan, type WriteOutcome } from "./write";

// Push-suppression threshold for workout PRs. A batch larger than this fires
// the detection job with `silent: true` so a multi-year HKWorkout backfill
// doesn't spam the user with hundreds of pushes. Matches the
// measurements-batch threshold so behaviour stays uniform across both ingest
// paths.
const PR_DETECTION_SILENT_THRESHOLD = 50;

export interface WorkoutBatchInput {
  userId: string;
  scoped: boolean;
  /** The account's opt-in: a GPS track is kept only when it is on. */
  keepRoutes: boolean;
  /** `User.sourcePriorityJson`, the ladder the write-time picker walks. */
  sourcePriorityJson: unknown;
  workouts: WorkoutEntry[];
  refusedSampleIndices: ReadonlySet<number>;
  ipAddress: string | null;
}

/** The response body of the workout batch route. */
export interface WorkoutBatchResult {
  processed: number;
  inserted: number;
  duplicates: number;
  skipped: Array<{ index: number; reason: string }>;
  entries: EntryResult[];
}

const NOTHING_WRITTEN: WriteOutcome = {
  insertedCount: 0,
  enrichedCount: 0,
  updatedCount: 0,
  duplicates: 0,
  insertedIdByIndex: new Map(),
  overwrittenIdByIndex: new Map(),
};

export async function ingestWorkoutBatch(
  input: WorkoutBatchInput,
): Promise<WorkoutBatchResult> {
  const { userId, workouts, keepRoutes } = input;
  const { prepared, results, unstableShapes } = prepareWorkouts(input);

  if (unstableShapes.length > 0) {
    annotate({
      meta: unstableExternalIdMeta("workout.batch", unstableShapes),
    });
  }

  // Write-time cross-source dedup through the one workout clustering the
  // reads use (see `batchWorkoutIndicesToKeep`): one logical workout from two
  // sources in one batch, or one HealthKit session re-sent under a new id,
  // lands once. Rows hidden here surface to the client as `duplicate`, so the
  // sync cursor advances past them like the externalId case below.
  const survivingIndices = await batchWorkoutIndicesToKeep(
    userId,
    prepared,
    input.sourcePriorityJson ?? null,
  );
  let duplicateCount = 0;
  for (const p of prepared) {
    if (!survivingIndices.has(p.index)) {
      results[p.index] = { index: p.index, status: "duplicate" };
      duplicateCount += 1;
    }
  }
  const survivors = prepared.filter((p) => survivingIndices.has(p.index));

  let written = NOTHING_WRITTEN;
  if (survivors.length > 0) {
    const plan = await planWorkoutWrites(userId, survivors, results);
    duplicateCount += plan.duplicates;
    written = await writeWorkoutPlan(userId, plan, results);
    duplicateCount += written.duplicates;
  }
  const { insertedCount, enrichedCount, updatedCount } = written;

  const skipped = results
    .filter((r) => r.status === "skipped")
    .map((r) => ({ index: r.index, reason: r.reason ?? "unknown" }));

  await auditLog("workout.batch.ingest", {
    userId,
    ipAddress: input.ipAddress,
    details: {
      processed: workouts.length,
      inserted: insertedCount,
      duplicates: duplicateCount,
      enriched: enrichedCount,
      updated: updatedCount,
      skipped: skipped.length,
    },
  });

  // Kick off PR detection for this user. Suppress push notifications for
  // historical-backfill batches so a multi-year HKWorkout import doesn't
  // fire hundreds of pushes during initial sync. The detector also scans
  // Measurement history on the same pass, so a workout-only batch still
  // surfaces measurement-side PRs the user may have racked up since the
  // last detection.
  if (insertedCount > 0 || duplicateCount > 0) {
    const silent = workouts.length > PR_DETECTION_SILENT_THRESHOLD;
    try {
      await enqueuePrDetection(userId, { silent });
      // Telemetry, not an audit event: it rides the wide event.
      annotate({
        meta: { pr_detection_enqueued: true, pr_detection_silent: silent },
      });
    } catch (err) {
      annotate({
        action: { name: "personal_records.detection_enqueue_failed" },
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Counts only. The series itself never reaches a wide event.
  annotate({
    action: { name: "workout.batch.ingest" },
    meta: {
      processed: workouts.length,
      inserted: insertedCount,
      duplicates: duplicateCount,
      enriched: enrichedCount,
      updated: updatedCount,
      skipped: skipped.length,
      // Tracks the body carried but the opt-in told us not to keep.
      routes_dropped: keepRoutes
        ? 0
        : workouts.filter((w) => w.route != null).length,
    },
  });

  // Bust per-user analytics + achievements + workouts caches when at least
  // one row landed. Workouts ride on the measurements bucket because
  // achievements / analytics also touch workout-derived metrics. An
  // enrichment changes what the workout reads as — the detail seam gains
  // its curve, the list gains its glyph — so it busts the cache too, even
  // though no workout row was written.
  if (insertedCount > 0 || enrichedCount > 0 || updatedCount > 0) {
    invalidateUserMeasurements(userId);
  }

  if (insertedCount > 0 || written.overwrittenIdByIndex.size > 0) {
    // One arrival per exact INSERT ... RETURNING winner. Historical rows still
    // stop at the shared salience classifier before any queue work.
    // An enrichment raises none: the workout arrived when it was stored.
    // A hand-entered workout whose edit landed raises one again, so its
    // paragraph (dropped with the old values) is written from the new ones.
    void emitWorkoutArrivals(
      userId,
      prepared,
      new Map([...written.insertedIdByIndex, ...written.overwrittenIdByIndex]),
    ).catch(() => {});
  }

  return {
    processed: workouts.length,
    inserted: insertedCount,
    duplicates: duplicateCount,
    skipped,
    entries: results,
  };
}

/**
 * Emit one data arrival per workout this batch actually inserted, and per
 * hand-entered workout whose edit it actually wrote.
 *
 * `createManyAndReturn` gives the transaction the exact inserted ids. The
 * index-keyed map avoids a second lookup and keeps equal external ids from
 * different sources attached to their own workout.
 *
 * Fully best-effort — every failure path returns quietly. A reaction is never
 * worth failing an ingest that already succeeded.
 */
async function emitWorkoutArrivals(
  userId: string,
  prepared: ReadonlyArray<{
    index: number;
    row: Prisma.WorkoutCreateManyInput;
  }>,
  insertedIdByIndex: ReadonlyMap<number, string>,
): Promise<void> {
  for (const p of prepared) {
    const refId = insertedIdByIndex.get(p.index);
    if (!refId) continue;
    const startedAt =
      p.row.startedAt instanceof Date
        ? p.row.startedAt
        : new Date(p.row.startedAt as string);
    if (Number.isNaN(startedAt.getTime())) continue;
    await emitDataArrival({
      userId,
      kind: "workout",
      newestSampleAt: startedAt,
      insertedCount: 1,
      refId,
      source: "batch",
    });
  }
}
