/**
 * The silent pushes a device is owed, and how long the relay holds them back.
 *
 * Intake sync. A device is owed one `MEDICATION_INTAKE_SYNC`, however many
 * changes arrived meanwhile, in `push_data_changes.intake_sync_owed_at`. The
 * first time it is owed stays. The minute pass (`flushOwedIntakeSyncs`,
 * `medication-pushes.ts`) sends a fresh one once the device has silent budget
 * and a route again, and clears it.
 *
 * `DATA_CHANGED`. Its domains wait on the same row (`domains`) until a wake
 * goes out; a wake the relay refused or dropped puts them back.
 *
 * The relay's hold. When the relay refuses a silent push for a budget
 * (`429`: the device's six silent pushes an hour, a binding, instance or
 * relay-wide limit), no silent push to that device goes before the time it
 * named (`retryAfter`). Without a hint the hold runs until the oldest silent
 * push of the device's last hour in this server's own ledger (`push_wakes`)
 * leaves the window, which is when the relay's rolling hour frees a slot; or
 * an hour, when the ledger has none (the relay counted pushes this server no
 * longer knows of). The hold is the refused push's outbox row: dropped, with
 * the time in `next_attempt_at`. A final row has no next attempt otherwise.
 *
 * Writers: the silent budget holds a sync back (`medication-pushes.ts`), and
 * the relay outbox refuses one for a budget or drops one at its deadline
 * (`relay-send.ts`). A leaf, so the outbox can use it without closing an
 * import cycle.
 */
import { prisma } from "@/lib/db";

const HOUR_MS = 3600_000;

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

/** Merge `domains` into the device's pending `DATA_CHANGED` wake. */
export async function owePendingDomains(
  deviceId: string,
  domains: readonly string[],
  now: Date,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "push_data_changes" ("device_id", "domains", "updated_at")
    VALUES (${deviceId}, ${[...domains]}::text[], ${now.toISOString()}::timestamp(3))
    ON CONFLICT ("device_id") DO UPDATE SET
      "domains" = ARRAY(
        SELECT DISTINCT d
          FROM unnest("push_data_changes"."domains" || EXCLUDED."domains") AS d
         ORDER BY d
      ),
      "updated_at" = EXCLUDED."updated_at"`;
}

/**
 * Until when the relay holds the device's silent pushes after a budget
 * refusal: its signed hint, else the ledger's next free slot (module doc).
 */
export async function relayHoldUntil(
  deviceId: string,
  now: Date,
  hintSeconds: number | null,
): Promise<Date> {
  if (hintSeconds !== null && hintSeconds > 0) {
    return new Date(now.getTime() + hintSeconds * 1000);
  }
  const oldest = await prisma.pushWake.findFirst({
    where: { deviceId, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return new Date((oldest?.createdAt.getTime() ?? now.getTime()) + HOUR_MS);
}

/**
 * The end of the relay's current hold on the device's silent pushes, or
 * null when none holds them now.
 */
export async function relaySilentHold(
  deviceId: string,
  now: Date,
): Promise<Date | null> {
  const row = await prisma.pushRelayDelivery.findFirst({
    where: {
      deviceId,
      pushClass: "silent",
      status: "dropped",
      nextAttemptAt: { gt: now },
    },
    orderBy: { nextAttemptAt: "desc" },
    select: { nextAttemptAt: true },
  });
  return row?.nextAttemptAt ?? null;
}
