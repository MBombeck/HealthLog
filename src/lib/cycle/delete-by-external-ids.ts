/**
 * Tombstone the Apple Health cycle day-logs the iPhone app reports as deleted
 * (`DELETE /api/cycle/day-logs/by-external-ids`).
 *
 * Each row goes the way `DELETE /api/cycle/day-logs/{id}` takes one: a soft
 * delete (`deletedAt` + `syncVersion`, so the sync feed carries the
 * tombstone), and in the same transaction the cycle that day opened, with the
 * preceding cycle re-anchored. Days are taken oldest first so each cycle
 * repair sees the days after it still in place, as a person deleting them one
 * by one would.
 *
 * A later re-post of a deleted externalId through the day-log bulk route
 * writes the day again, since many samples feed one day, but from empty
 * fields: nothing the deleted day held comes back (`day-log-write.ts`,
 * `tombstone-repost.ts`).
 */
import { prisma } from "@/lib/db";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { removeCycleStartedOn } from "@/lib/cycle/cycle-boundaries";
import { APP_MINTED_SOURCE } from "@/lib/sync/external-id-delete";
import { appleHealthDeletion } from "@/lib/sync/tombstone-repost";

export async function deleteAppleHealthCycleDayLogs(
  userId: string,
  externalIds: readonly string[],
): Promise<{ deleted: number; removedCycles: number }> {
  if (externalIds.length === 0) return { deleted: 0, removedCycles: 0 };
  const rows = await prisma.cycleDayLog.findMany({
    where: {
      userId,
      source: APP_MINTED_SOURCE,
      externalId: { in: [...externalIds] },
      deletedAt: null,
    },
    select: { id: true, date: true },
    orderBy: { date: "asc" },
  });

  let deleted = 0;
  let removedCycles = 0;
  for (const row of rows) {
    const removed = await prisma.$transaction(async (db) => {
      const { count } = await db.cycleDayLog.updateMany({
        where: { id: row.id, deletedAt: null },
        data: { ...appleHealthDeletion(), syncVersion: { increment: 1 } },
      });
      if (count === 0) return { count, cycle: null };
      return { count, cycle: await removeCycleStartedOn(db, userId, row.date) };
    });
    deleted += removed.count;
    if (removed.cycle) removedCycles += 1;
  }

  // A removed day (possibly with its cycle) changes the cycle context the
  // cached analytics / snapshot / digest cells carry.
  if (deleted > 0) invalidateUserHealthContext(userId);
  return { deleted, removedCycles };
}
