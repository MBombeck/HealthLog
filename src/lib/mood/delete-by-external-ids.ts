/**
 * Tombstone the State of Mind entries imported from Apple Health that the
 * iPhone app reports as deleted (`DELETE /api/mood-entries/by-external-ids`).
 *
 * Only entries posted with `source = APPLE_HEALTH` and the sample UUID as
 * `externalId` qualify; a mood logged in HealthLog itself never does. Each
 * goes the way `DELETE /api/mood-entries/{id}` takes one: a soft delete
 * (`deletedAt` + `syncVersion`), the mood caches evicted and each touched
 * day's rollup recomputed. A later re-post of a deleted externalId stays
 * deleted: the bulk route answers `duplicate`, and the single POST updates
 * the hidden row without bringing it back.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import { APP_MINTED_SOURCE } from "@/lib/sync/external-id-delete";

export async function deleteAppleHealthMoodEntries(
  userId: string,
  externalIds: readonly string[],
): Promise<number> {
  if (externalIds.length === 0) return 0;
  const where = {
    userId,
    source: APP_MINTED_SOURCE,
    externalId: { in: [...externalIds] },
    deletedAt: null,
  };
  const days = await prisma.moodEntry.findMany({
    where,
    select: { date: true },
    distinct: ["date"],
  });
  const { count } = await prisma.moodEntry.updateMany({
    where,
    data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
  });
  if (count === 0) return 0;

  invalidateUserMood(userId);
  for (const { date } of days) {
    try {
      await recomputeMoodBucketsForEntry(userId, date);
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }
  }
  return count;
}
