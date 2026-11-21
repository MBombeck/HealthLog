/**
 * Retire the `WALKING_RUNNING_DISTANCE` rows earlier Oura syncs wrote from
 * `equivalent_walking_distance`.
 *
 * That field is an activity equivalent (the distance a walk of the day's
 * effort would have covered), not distance travelled, so the rows were wrong
 * from the start and the sync no longer writes them (`mapDailyActivity`).
 * What is already stored is soft-deleted here, in bounded batches, and the
 * touched days are refolded through the shared mutation tail so the rollups
 * stop counting them, the same way `retireOuraSleepRecords` retires a
 * rejected sleep period.
 *
 * Only rows the activity mapper keyed (`activity:<day>:distance`) of source
 * OURA match; another source's distance, and any OURA row of another shape,
 * stay. Idempotent: a second run finds nothing live and returns 0. The Oura
 * backfill runs it before anything else on every connected account, and the
 * backfill's discovery also offers an account that still holds such rows
 * after its Oura connection was removed.
 */
import { prisma } from "@/lib/db";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import type { Prisma } from "@/generated/prisma/client";

/** Rows per batch: one bounded read, one update, one refold. */
export const OURA_DISTANCE_RETIRE_BATCH = 500;

/** The rows the activity mapper wrote from the equivalent distance. */
export const OURA_EQUIVALENT_DISTANCE_WHERE = {
  source: "OURA",
  type: "WALKING_RUNNING_DISTANCE",
  deletedAt: null,
  externalId: { startsWith: "activity:", endsWith: ":distance" },
} as const satisfies Prisma.MeasurementWhereInput;

/**
 * Soft-delete every live equivalent-distance row of one account. Returns how
 * many rows were retired. Throws on a database failure: the caller decides
 * whether that holds its own progress back.
 */
export async function retireOuraEquivalentDistance(
  userId: string,
): Promise<number> {
  let retired = 0;
  for (;;) {
    const rows = await prisma.measurement.findMany({
      where: { userId, ...OURA_EQUIVALENT_DISTANCE_WHERE },
      select: { id: true, type: true, measuredAt: true },
      orderBy: { measuredAt: "asc" },
      take: OURA_DISTANCE_RETIRE_BATCH,
    });
    if (rows.length === 0) break;
    const res = await prisma.measurement.updateMany({
      where: { userId, id: { in: rows.map((r) => r.id) }, deletedAt: null },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });
    retired += res.count;
    await afterMeasurementMutation(userId, rows, {
      source: "sync",
      label: "oura",
    });
    // A batch the update found already retired (a concurrent run) still
    // leaves the read empty next time round, so the loop ends.
    if (rows.length < OURA_DISTANCE_RETIRE_BATCH) break;
  }
  if (retired > 0) {
    invalidateUserMeasurements(userId);
    annotate({ meta: { oura_equivalent_distance_retired: retired } });
  }
  return retired;
}
