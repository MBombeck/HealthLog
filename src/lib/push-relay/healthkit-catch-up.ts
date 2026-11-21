/**
 * `HEALTHKIT_CATCH_UP`: a silent sealed wake that asks an iOS device to run
 * its Apple Health upload when the server sees the upload fell behind while
 * the app is still in use. The app runs its normal incremental pass within
 * the background time iOS gives it and posts it with `syncTrigger: "push"`,
 * so a pass that finds nothing new still moves `lastSeenDuplicateAt` and the
 * account stops counting as behind.
 *
 * Envelope plaintext: `t: "HEALTHKIT_CATCH_UP"`, silent, one hour,
 * `d: { requestedAt }`. No type list, no reading.
 *
 * When. The hourly job `healthkit-catch-up` looks at accounts whose newest
 * Apple Health batch of any kind (new rows or duplicates only; a `backfill`
 * batch does not count) is older than {@link STALE_AFTER_MS} but not older
 * than {@link GIVE_UP_AFTER_MS}: an account silent for longer has stopped
 * using the upload, and waking it would only spend budget. Of such an
 * account it asks the devices with a push key whose app last registered
 * within {@link RECENT_FOREGROUND_MS} (`Device.lastSeen`, written by every
 * `POST /api/devices`, which the app sends when it comes to the foreground).
 *
 * Limits, per device: at most {@link PER_DEVICE_DAY} catch-ups in 24 hours,
 * at least {@link MIN_SPACING_MS} apart, and inside the shared silent budget
 * of every wake (`wakes.ts`).
 */
import { prisma } from "@/lib/db";
import { sendWake, wakeableDevices } from "@/lib/push-relay/wakes";

const HOUR_MS = 3600_000;
/** An upload older than this is behind. */
export const STALE_AFTER_MS = 6 * HOUR_MS;
/** An upload older than this has stopped; no wake. */
export const GIVE_UP_AFTER_MS = 14 * 24 * HOUR_MS;
/** A device whose app registered within this counts as in use. */
export const RECENT_FOREGROUND_MS = 3 * 24 * HOUR_MS;
/** Catch-ups per device in 24 hours. */
export const PER_DEVICE_DAY = 3;
/** The least spacing between two catch-ups to one device. */
export const MIN_SPACING_MS = 4 * HOUR_MS;
/** Accounts looked at per pass. */
const PASS_LIMIT = 500;

export interface CatchUpFacts {
  candidates: number;
  sent: number;
  limited: number;
}

/** The accounts whose live Apple Health upload is behind, oldest first. */
async function staleAccounts(
  now: Date,
): Promise<Array<{ user_id: string; last_upload: Date }>> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const floor = new Date(now.getTime() - GIVE_UP_AFTER_MS).toISOString();
  return prisma.$queryRaw<Array<{ user_id: string; last_upload: Date }>>`
    SELECT "user_id",
           max(greatest("last_received_at",
                        coalesce("last_seen_duplicate_at", "last_received_at")))
             AS "last_upload"
      FROM "healthkit_type_syncs"
     WHERE "type" NOT LIKE 'backfill:%'
     GROUP BY "user_id"
    HAVING max(greatest("last_received_at",
                        coalesce("last_seen_duplicate_at", "last_received_at")))
             < ${staleBefore}::timestamp(3)
       AND max(greatest("last_received_at",
                        coalesce("last_seen_duplicate_at", "last_received_at")))
             > ${floor}::timestamp(3)
     ORDER BY 2 ASC
     LIMIT ${PASS_LIMIT}`;
}

/** Whether `deviceId` may get one more catch-up now. */
export async function catchUpAllowed(
  deviceId: string,
  now: Date,
): Promise<boolean> {
  const recent = await prisma.pushWake.findMany({
    where: {
      deviceId,
      kind: "HEALTHKIT_CATCH_UP",
      createdAt: { gte: new Date(now.getTime() - 24 * HOUR_MS) },
    },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (recent.length >= PER_DEVICE_DAY) return false;
  const last = recent[0]?.createdAt;
  return !last || now.getTime() - last.getTime() >= MIN_SPACING_MS;
}

/** Ask one account's in-use devices for a pass. Returns how many it asked. */
export async function requestCatchUp(
  userId: string,
  now: Date = new Date(),
): Promise<{ sent: number; limited: number }> {
  const recentSince = new Date(now.getTime() - RECENT_FOREGROUND_MS);
  const inUse = new Set(
    (
      await prisma.device.findMany({
        where: { userId, platform: "ios", lastSeen: { gte: recentSince } },
        select: { id: true },
      })
    ).map((d) => d.id),
  );
  const devices = [];
  let limited = 0;
  for (const device of await wakeableDevices(userId)) {
    if (!inUse.has(device.id)) continue;
    if (!(await catchUpAllowed(device.id, now))) {
      limited += 1;
      continue;
    }
    devices.push(device);
  }
  const result = await sendWake(
    "HEALTHKIT_CATCH_UP",
    devices,
    { requestedAt: now.toISOString() },
    { now, collapseKey: "healthkit-catch-up" },
  );
  return {
    sent: result.sent.length,
    limited: limited + result.overBudget.length,
  };
}

/** The hourly pass over every account whose upload is behind. */
export async function runHealthKitCatchUp(
  now: Date = new Date(),
): Promise<CatchUpFacts> {
  const accounts = await staleAccounts(now);
  const facts: CatchUpFacts = {
    candidates: accounts.length,
    sent: 0,
    limited: 0,
  };
  for (const account of accounts) {
    const result = await requestCatchUp(account.user_id, now);
    facts.sent += result.sent;
    facts.limited += result.limited;
  }
  return facts;
}
