/**
 * `DELETE /api/workouts/{id}`: remove a workout that was entered by hand.
 *
 * - Ownership: another user's row reads as missing, like the detail read.
 * - `MANUAL` only. Every other source is a sync, and the next sync would
 *   write the row back, so it is refused instead of pretending.
 *
 * The workout table carries no tombstone, so the row is removed outright;
 * route, samples and insight rows cascade with it. The insight's generation
 * claim stays behind with a null workout id: it is the day's cap ledger, and
 * a delete must not hand the slot back. A personal record the workout set
 * would otherwise outlive it (the detector only ever raises a stored best),
 * so the records keyed on this workout go in the same transaction and a
 * silent detection pass re-derives the honest best.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import {
  lockPersonalRecordsForUser,
  workoutPrSlotsForSport,
} from "@/lib/personal-records/pr-detection-worker";

export type DeleteManualWorkoutOutcome =
  { kind: "not_found" } | { kind: "synced_source" } | { kind: "deleted" };

export async function deleteManualWorkout(args: {
  userId: string;
  id: string;
  ipAddress: string | null;
}): Promise<DeleteManualWorkoutOutcome> {
  const { userId, id } = args;
  const row = await prisma.workout.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      source: true,
      externalId: true,
      startedAt: true,
      sportType: true,
    },
  });
  if (!row || row.userId !== userId) {
    return { kind: "not_found" };
  }
  if (row.source !== "MANUAL") {
    annotate({
      action: {
        name: "workout.delete",
        entity_type: "workout",
        entity_id: id,
      },
      meta: { outcome: "synced_source", source: row.source },
    });
    return { kind: "synced_source" };
  }

  const removedRecords = await prisma.$transaction(async (tx) => {
    // The detector reads the best workout and writes its record under this
    // same lock, so it either wrote before this delete (and the record goes
    // below) or reads after it (and never sees the workout).
    await lockPersonalRecordsForUser(tx, userId);
    const records = await tx.personalRecord.deleteMany({
      where: {
        userId: userId,
        source: "MANUAL",
        ...(row.externalId !== null
          ? { metricSlot: { not: null }, externalId: row.externalId }
          : {
              // A legacy record carries no external id, so the start time
              // is all that ties it to this workout. Scope it to the slots
              // of this workout's sport so a record another sport set at
              // the same instant stays.
              metricSlot: { in: workoutPrSlotsForSport(row.sportType) },
              externalId: null,
              achievedAt: row.startedAt,
            }),
      },
    });
    await tx.workout.delete({ where: { id: row.id } });
    return records.count;
  });

  await auditLog("workout.delete", {
    userId: userId,
    ipAddress: args.ipAddress,
    details: {
      workoutId: id,
      sportType: row.sportType,
      personalRecordsRemoved: removedRecords,
    },
  });
  annotate({
    action: { name: "workout.delete", entity_type: "workout", entity_id: id },
    meta: { outcome: "deleted", personalRecordsRemoved: removedRecords },
  });

  invalidateUserMeasurements(userId, { evict: true });

  if (removedRecords > 0) {
    try {
      await enqueuePrDetection(userId, { silent: true });
    } catch (err) {
      annotate({
        action: { name: "personal_records.detection_enqueue_failed" },
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return { kind: "deleted" };
}
