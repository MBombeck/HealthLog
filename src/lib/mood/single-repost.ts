/**
 * What `POST /api/mood-entries` does with an `externalId` whose row is
 * deleted: the rule the bulk route applies (`tombstone-repost.ts`), for one
 * entry.
 *
 * The upsert on `(userId, source, externalId)` matches a tombstone like a
 * live row, so before this a re-post rewrote the hidden row, left it deleted
 * and answered `201` with it: the client believed the entry was back, and
 * nobody saw it. Now a row deleted in HealthLog refuses the re-post (`410`,
 * nothing written) and a row the phone reported deleted in Apple Health is
 * written back, live again.
 */
import { prisma } from "@/lib/db";
import { deletedInHealthLog } from "@/lib/sync/tombstone-repost";

export type MoodRepost =
  { kind: "refused"; id: string } | { kind: "write"; revive: boolean };

export async function moodRepostFor(
  userId: string,
  source: string,
  externalId: string | undefined,
): Promise<MoodRepost> {
  if (!externalId) return { kind: "write", revive: false };
  const existing = await prisma.moodEntry.findUnique({
    where: { userId_source_externalId: { userId, source, externalId } },
    select: { id: true, deletedAt: true, appleHealthDeletedAt: true },
  });
  if (existing && deletedInHealthLog(existing)) {
    return { kind: "refused", id: existing.id };
  }
  return { kind: "write", revive: existing?.deletedAt != null };
}

/** The upsert's update-arm fields that bring a reported tombstone back. */
export function moodReviveFields(revive: boolean) {
  return revive
    ? {
        deletedAt: null,
        appleHealthDeletedAt: null,
        syncVersion: { increment: 1 },
      }
    : {};
}
