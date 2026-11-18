/**
 * Remove the Apple Watch ECG recordings the iPhone app reports as deleted
 * (`DELETE /api/insights/ecg/by-external-ids`), matched on the recording id
 * the live ingest stored (`externalRecordingId`, the HealthKit sample UUID).
 *
 * The recording table carries no tombstone, so the rows go outright, the
 * encrypted waveform with them. A paired rhythm notification is a measurement
 * of its own and stays. A later re-post of the same id inserts the recording
 * again; the app drops the outbox entry of a sample it reported deleted.
 */
import { prisma } from "@/lib/db";
import { APP_MINTED_SOURCE } from "@/lib/sync/external-id-delete";

export async function deleteAppleHealthEcgRecordings(
  userId: string,
  externalIds: readonly string[],
): Promise<number> {
  if (externalIds.length === 0) return 0;
  const { count } = await prisma.ecgRecording.deleteMany({
    where: {
      userId,
      source: APP_MINTED_SOURCE,
      externalRecordingId: { in: [...externalIds] },
    },
  });
  return count;
}
