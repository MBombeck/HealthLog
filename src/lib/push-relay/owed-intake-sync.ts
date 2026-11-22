/**
 * The intake sync a device is owed: the silent `MEDICATION_INTAKE_SYNC` that
 * could not go out, or went out and never reached Apple.
 *
 * A device is owed one sync, however many changes arrived meanwhile, in
 * `push_data_changes.intake_sync_owed_at`. The first time it is owed stays.
 * The minute pass (`flushOwedIntakeSyncs`, `medication-pushes.ts`) sends it
 * once the device has silent budget and a route again, and clears it.
 *
 * Two writers: the silent budget holds a sync back (`medication-pushes.ts`),
 * and the relay outbox drops one at its deadline (`relay-send.ts`): a relay
 * outage past the push's lifetime, or a refusal whose retry hint lies beyond
 * it. A leaf, so the outbox can use it without closing an import cycle.
 */
import { prisma } from "@/lib/db";

/** Mark the sync owed to these devices (the first time it is owed stays). */
export async function oweIntakeSync(
  deviceIds: readonly string[],
  now: Date,
): Promise<void> {
  for (const deviceId of deviceIds) {
    await prisma.$executeRaw`
      INSERT INTO "push_data_changes" ("device_id", "intake_sync_owed_at", "updated_at")
      VALUES (${deviceId}, ${now.toISOString()}::timestamp(3), ${now.toISOString()}::timestamp(3))
      ON CONFLICT ("device_id") DO UPDATE SET
        "intake_sync_owed_at" = COALESCE("push_data_changes"."intake_sync_owed_at", EXCLUDED."intake_sync_owed_at")`;
  }
}

/** The sync is settled, or the device takes none any more. */
export async function clearOwedIntakeSync(deviceId: string): Promise<void> {
  await prisma.pushDataChange.updateMany({
    where: { deviceId },
    data: { intakeSyncOwedAt: null },
  });
}
