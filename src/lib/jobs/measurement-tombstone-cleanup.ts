/**
 * Daily prune for soft-deleted rows across the sync domains (v1.7.0):
 * `measurements`, `mood_entries`, and `medication_intake_events`.
 *
 * The user-facing DELETE routes on all three domains soft-delete (set
 * `deletedAt`) so the `/api/sync/changes` delta feed can surface deletions
 * as tombstones to paired clients that were offline at delete time. A
 * tombstone only needs to outlive the device's refresh-token lifetime plus
 * a margin: a device offline longer than that has lost its refresh token
 * and re-pairs with a full backfill (not an incremental delta), so it
 * never relies on the tombstone. Past the retention horizon the row is
 * hard-deleted to reclaim storage; the `/api/sync/changes` route emits
 * `cursorExpired` for any cursor that predates the same horizon so a
 * long-offline client re-inits cleanly rather than silently missing the
 * pruned deletion.
 *
 * Retention is keyed to `TOMBSTONE_RETENTION_DAYS`
 * (`NATIVE_REFRESH_TOKEN_DAYS` + margin) so it moves automatically if the
 * refresh-token lifetime changes — the two never drift.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";

const DAY_MS = 86_400_000;

/**
 * Hard-delete soft-deleted measurement rows whose `deletedAt` is older
 * than the retention horizon. Returns the number of rows pruned.
 */
export async function cleanupExpiredMeasurementTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS);
  const { count } = await prisma.measurement.deleteMany({
    where: { deletedAt: { not: null, lt: cutoff } },
  });
  return count;
}

/**
 * Hard-delete soft-deleted mood-entry rows past the retention horizon.
 * Returns the number of rows pruned.
 */
export async function cleanupExpiredMoodTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS);
  const { count } = await prisma.moodEntry.deleteMany({
    where: { deletedAt: { not: null, lt: cutoff } },
  });
  return count;
}

/**
 * Hard-delete soft-deleted medication-intake-event rows past the retention
 * horizon. Returns the number of rows pruned.
 */
export async function cleanupExpiredIntakeTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS);
  const { count } = await prisma.medicationIntakeEvent.deleteMany({
    where: { deletedAt: { not: null, lt: cutoff } },
  });
  return count;
}
