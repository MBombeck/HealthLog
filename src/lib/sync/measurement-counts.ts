/**
 * The measurement counts of the iOS sync handshake (`GET /api/sync/state`),
 * exact and bounded by days and tombstones rather than by readings.
 */
import { prisma } from "@/lib/db";
import { MeasurementType } from "@/generated/prisma/enums";
import { countLiveReadings } from "@/lib/rollups/live-counts";

/**
 * Every live measurement of the account, exact. A count of the rows was every
 * reading of a watch's heart rate on each handshake; the DAY rollup tier holds
 * each day's count and is summed where it matches the record
 * (`countLiveReadings`), the rows older than its window come from a cached
 * closed block, and a type it does not cover is counted live.
 */
export async function countLiveMeasurements(userId: string): Promise<number> {
  const counts = await countLiveReadings(
    userId,
    Object.values(MeasurementType),
    null,
  );
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

/**
 * The account's soft-deleted measurements, exact, read through the partial
 * tombstone index (`measurements_tombstone_purge_idx`, `WHERE deleted_at IS
 * NOT NULL`), so the count walks the tombstones the retention keeps (75 days
 * of them, every account's), not the account's live history. The inner read
 * names no account and is ordered on `deleted_at`, which only that index
 * returns, under a limit the planner cannot see and that never binds: with
 * no statistics the planner takes nearly every row for a tombstone, and an
 * account filter inside let it read the account's every row and sort them.
 */
export async function countTombstonedMeasurements(
  userId: string,
): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT COUNT(*) FILTER (WHERE x."user_id" = ${userId}) AS n FROM (
      SELECT m."user_id"
      FROM measurements m
      WHERE m."deleted_at" IS NOT NULL
      ORDER BY m."deleted_at"
      LIMIT (SELECT 2147483647::int)
    ) x
  `;
  return Number(row?.n ?? 0);
}
