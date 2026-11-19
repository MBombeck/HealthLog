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
 * Every reported id is also remembered in the Apple Health tombstone ledger
 * (`src/lib/sync/apple-health-tombstones.ts`), in the same transaction, so a
 * later re-post of a deleted workout's externalId answers `duplicate` instead
 * of inserting it again. An id that matched nothing is remembered too: the
 * phone says the sample is gone, so a post of it still in flight must not
 * land after the delete.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { lockPersonalRecordsForUser } from "@/lib/personal-records/pr-detection-worker";
import { recordAppleHealthTombstones } from "@/lib/sync/apple-health-tombstones";
import { APP_MINTED_SOURCE } from "@/lib/sync/external-id-delete";

export async function deleteAppleHealthWorkouts(
  userId: string,
  externalIds: readonly string[],
): Promise<{ deleted: number; personalRecordsRemoved: number }> {
  if (externalIds.length === 0)
    return { deleted: 0, personalRecordsRemoved: 0 };

  const { deleted, personalRecordsRemoved } = await prisma.$transaction(
    async (tx) => {
      // The detector reads the best workout and writes its record under this
      // same lock, so it either wrote before this delete (and the record goes
      // below) or reads after it (and never sees the workout).
      await lockPersonalRecordsForUser(tx, userId);
      await recordAppleHealthTombstones(tx, userId, "workout", externalIds);
      const rows = await tx.workout.findMany({
        where: {
          userId,
          source: APP_MINTED_SOURCE,
          externalId: { in: [...externalIds] },
        },
        select: { id: true, externalId: true },
      });
      if (rows.length === 0) return { deleted: 0, personalRecordsRemoved: 0 };
      const records = await tx.personalRecord.deleteMany({
        where: {
          userId,
          source: APP_MINTED_SOURCE,
          metricSlot: { not: null },
          externalId: { in: rows.map((r) => r.externalId as string) },
        },
      });
      const removed = await tx.workout.deleteMany({
        where: { userId, id: { in: rows.map((r) => r.id) } },
      });
      return { deleted: removed.count, personalRecordsRemoved: records.count };
    },
  );

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
  return { deleted, personalRecordsRemoved };
}
