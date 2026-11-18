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
 * index `measurements_user_id_deleted_at_tombstone_idx` (`(user_id,
 * deleted_at) WHERE deleted_at IS NOT NULL`, migration 0505): the count reads
 * this account's tombstones and no other account's. The instance-wide purge
 * index leads on `deleted_at` alone, and reading through it walked every
 * account's tombstones on each handshake.
 */
export async function countTombstonedMeasurements(
  userId: string,
): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT COUNT(*) AS n
    FROM measurements m
    WHERE m."user_id" = ${userId}
      AND m."deleted_at" IS NOT NULL
  `;
  return Number(row?.n ?? 0);
}
