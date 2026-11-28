/**
 * Remove the Apple Health workouts the iPhone app reports as deleted
 * (`DELETE /api/workouts/by-external-ids`).
 *
 * The same delete `deleteManualWorkout` performs for one hand-entered
 * workout, for the app's own rows: the workout table carries no tombstone, so
 * the rows go outright (route, samples and insight rows cascade), and the
 * personal records keyed on them go in the same transaction under the record
 * lock, after which a silent detection pass re-derives the honest best.
 *
 * Nothing remembers the ids: a person cannot delete an Apple Health workout
 * in HealthLog, so every deletion of one is Apple Health's, and a later
 * re-post of the same sample (it came back in HealthKit) writes it again
 * (`src/lib/sync/tombstone-repost.ts`).
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { lockPersonalRecordsForUser } from "@/lib/personal-records/pr-detection-worker";
import { APP_MINTED_SOURCE } from "@/lib/sync/external-id-delete";

export async function deleteAppleHealthWorkouts(
  userId: string,
  externalIds: readonly string[],
): Promise<{ deleted: number; personalRecordsRemoved: number }> {
  const { deleted, personalRecordsRemoved } = await deleteSourceWorkouts(
    userId,
    externalIds,
    APP_MINTED_SOURCE,
  );
  return { deleted, personalRecordsRemoved };
}

/**
 * The same delete for the workouts one app-minted source wrote: Apple Health
 * above, and the Android sync's Health Connect sessions
 * (`POST /api/health-connect/batch` `deletes`). Answers the externalIds it
 * removed.
 */
export async function deleteSourceWorkouts(
  userId: string,
  externalIds: readonly string[],
  source: typeof APP_MINTED_SOURCE | "HEALTH_CONNECT",
): Promise<{
  deleted: number;
  personalRecordsRemoved: number;
  deletedExternalIds: string[];
}> {
  if (externalIds.length === 0)
    return { deleted: 0, personalRecordsRemoved: 0, deletedExternalIds: [] };

  const { deleted, personalRecordsRemoved, deletedExternalIds } =
    await prisma.$transaction(async (tx) => {
      // The detector reads the best workout and writes its record under this
      // same lock, so it either wrote before this delete (and the record goes
      // below) or reads after it (and never sees the workout).
      await lockPersonalRecordsForUser(tx, userId);
      const rows = await tx.workout.findMany({
        where: {
          userId,
          source,
          externalId: { in: [...externalIds] },
        },
        select: { id: true, externalId: true },
      });
      if (rows.length === 0) {
        return {
          deleted: 0,
          personalRecordsRemoved: 0,
          deletedExternalIds: [] as string[],
        };
      }
      const records = await tx.personalRecord.deleteMany({
        where: {
          userId,
          source,
          metricSlot: { not: null },
          externalId: { in: rows.map((r) => r.externalId as string) },
        },
      });
      const removed = await tx.workout.deleteMany({
        where: { userId, id: { in: rows.map((r) => r.id) } },
      });
      return {
        deleted: removed.count,
        personalRecordsRemoved: records.count,
        deletedExternalIds: rows.map((r) => r.externalId as string),
      };
    });

  if (deleted > 0) invalidateUserMeasurements(userId, { evict: true });
  if (personalRecordsRemoved > 0) {
    try {
      await enqueuePrDetection(userId, { silent: true });
    } catch (err) {
      annotate({
        action: { name: "personal_records.detection_enqueue_failed" },
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return { deleted, personalRecordsRemoved, deletedExternalIds };
}
