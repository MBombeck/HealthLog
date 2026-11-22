/**
 * Tombstone the Apple Health dose records the iPhone app reports as deleted
 * (`DELETE /api/medications/intake/by-external-ids`), matched on the
 * HealthKit dose-event UUID the bulk intake route stored as `externalId`.
 *
 * Each event goes the way `DELETE /api/medications/{id}/intake/{eventId}`
 * (`deleteIntakeEvent`) takes one: its inventory stamp is refunded, the row
 * is soft-deleted (`deletedAt` + `syncVersion`, so the sync feed carries the
 * tombstone), the derived rows of its day are refreshed, and a one-shot
 * medication whose only dose this was becomes active again. The caches are
 * evicted and the other devices told once for the whole batch rather than
 * per event.
 *
 * The tombstone is stamped as Apple Health's deletion, so a later re-post of
 * the dose event (it came back in HealthKit) lands as a new dose and takes
 * its stock again. A dose deleted in HealthLog (`deleteIntakeEvent`) is the
 * other case: its re-post is refused per entry (`duplicate`, reason
 * `tombstoned`). That is decided at the ingest, not by the index: the unique
 * on `(user_id, external_id)` (migration 0239) stays partial over live rows,
 * so the tombstone never blocks the ledger itself (an undo or a restore of
 * the deleted row still lands), only the re-import of the same Apple Health
 * dose event (`tombstone-repost.ts`).
 */
import { prisma } from "@/lib/db";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { restoreForIntake } from "@/lib/medications/inventory/consumption";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import { refreshDoseSlot } from "@/lib/medications/dose-day-refresh";
import { afterDoseChange } from "@/lib/medications/after-dose-change";
import { APP_MINTED_SOURCE } from "@/lib/sync/external-id-delete";
import { appleHealthDeletion } from "@/lib/sync/tombstone-repost";

export async function deleteAppleHealthIntakes(
  user: { id: string; timezone: string | null },
  externalIds: readonly string[],
  /** The calling device (`x-device-id`), which needs no push about itself. */
  originDeviceToken: string | null,
): Promise<number> {
  if (externalIds.length === 0) return 0;
  const events = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId: user.id,
      source: APP_MINTED_SOURCE,
      externalId: { in: [...externalIds] },
      deletedAt: null,
    },
    select: { id: true, medicationId: true, scheduledFor: true },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
  });

  let deleted = 0;
  const medications = new Set<string>();
  for (const event of events) {
    await restoreForIntake({
      client: prisma,
      userId: user.id,
      eventId: event.id,
    });
    const { count } = await prisma.medicationIntakeEvent.updateMany({
      where: { id: event.id, deletedAt: null },
      data: { ...appleHealthDeletion(), syncVersion: { increment: 1 } },
    });
    if (count === 0) continue;
    deleted += count;
    medications.add(event.medicationId);
    await refreshDoseSlot({
      userId: user.id,
      medicationId: event.medicationId,
      scheduledFor: event.scheduledFor,
      tz: user.timezone,
    });
  }
  if (deleted === 0) return 0;

  for (const medicationId of medications) {
    await reconcileOneShotState(prisma, medicationId, user.id);
  }
  invalidateUserMedications(user.id, { evict: true });
  // The widget count and a pending Live Activity on the other devices change.
  afterDoseChange({
    scope: "intakes",
    userId: user.id,
    originDeviceToken,
  });
  return deleted;
}
