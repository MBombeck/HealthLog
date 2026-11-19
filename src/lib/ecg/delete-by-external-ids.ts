/**
 * Remove the Apple Watch ECG recordings the iPhone app reports as deleted
 * (`DELETE /api/insights/ecg/by-external-ids`), matched on the recording id
 * the live ingest stored (`externalRecordingId`, the HealthKit sample UUID).
 *
 * The recording table carries no tombstone column, so the rows go outright,
 * the encrypted waveform with them. A paired rhythm notification is a
 * measurement of its own and stays. Every reported id is remembered in the
 * Apple Health tombstone ledger in the same transaction, so a later re-post
 * of the same id answers `duplicate` and writes nothing
 * (`src/lib/sync/apple-health-tombstones.ts`).
 */
import { prisma } from "@/lib/db";
import { recordAppleHealthTombstones } from "@/lib/sync/apple-health-tombstones";
import { APP_MINTED_SOURCE } from "@/lib/sync/external-id-delete";

export async function deleteAppleHealthEcgRecordings(
  userId: string,
  externalIds: readonly string[],
): Promise<number> {
  if (externalIds.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    await recordAppleHealthTombstones(tx, userId, "ecg", externalIds);
    const { count } = await tx.ecgRecording.deleteMany({
      where: {
        userId,
        source: APP_MINTED_SOURCE,
        externalRecordingId: { in: [...externalIds] },
      },
    });
    return count;
  });
}
