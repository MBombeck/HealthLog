/**
 * A device signed out of an account stops receiving that account's pushes.
 *
 * A native sign-in stores the device it was made on with its refresh token
 * (`RefreshToken.deviceId` is the `Device.token` the app sent as
 * `X-Device-Id`). Revoking the sign-in used to leave the `Device` row with
 * its APNs token, push key and relay binding in place, so the reminders and
 * confirmations of an account the phone had left kept reaching its lock
 * screen, sealed for keys the app no longer held.
 *
 * The rule: a device with at least one refresh token of the account and no
 * live one left (not revoked, not consumed by a rotation, not expired) loses
 * its push credentials: the APNs token, the push key, the relay consent and
 * binding (whose unbind is queued, `unbind-queue.ts`), the Live Activity
 * tokens and the push-to-start state; relay pushes still waiting for it are
 * dropped. Its running Activities get their end push first, where the
 * revocation has no transaction of its own (`afterRefreshRevocation`, the
 * nightly sweep), so none is left on the lock screen. The row itself stays, so its per-device
 * delivery choice survives, and the next sign-in's `POST /api/devices` puts
 * the credentials back. A device that never had a refresh token (a row older
 * than per-device sign-in) is not touched: "no live sign-in" cannot be told
 * from "never had one" there.
 *
 * Every path that revokes refresh tokens calls this after the revoke, in the
 * same transaction where it has one (`src/__tests__/signed-out-device-push-guard.test.ts`
 * holds the list). Expiry has no writer to hook, so the nightly ledger
 * cleanup runs the same sweep across accounts before it deletes the expired
 * rows (`auth-ledger-cleanup.ts`).
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { liveRefreshTokenWhere } from "@/lib/devices/live-sign-in";
import { endDeviceLiveActivities } from "@/lib/notifications/live-activity-end";
import { clearedRelayFields } from "@/lib/push-relay/binding";
import { relayConfig } from "@/lib/push-relay/config";
import { drainRelayUnbinds } from "@/lib/push-relay/unbind-queue";
import { mayHoldRelayBinding } from "@/lib/push-relay/unbind-rows";

type DbModels =
  | "device"
  | "refreshToken"
  | "liveActivityToken"
  | "pushRelayUnbind"
  | "pushRelayDelivery";
type Db =
  Pick<PrismaClient, DbModels> | Pick<Prisma.TransactionClient, DbModels>;

/** Every push credential a device row can hold, cleared. */
export function clearedPushCredentials() {
  return {
    apnsToken: null,
    apnsEnvironment: null,
    liveActivityPushToken: null,
    laStartedMedicationId: null,
    laStartedSlot: null,
    laStartedAt: null,
    laStartRef: null,
    ...clearedRelayFields({ pushKey: true }),
  };
}

/**
 * Strip the push credentials of the given device rows and queue the relay
 * unbind of each token the relay may hold. Returns the queued tokens, for the
 * caller to try once its transaction committed (`drainQueuedUnbinds`).
 */
export async function stripDevicePush(
  db: Db,
  devices: ReadonlyArray<{
    id: string;
    apnsToken: string | null;
    relayState: string;
    relayConsentAt: Date | null;
  }>,
): Promise<string[]> {
  if (devices.length === 0) return [];
  const tokens = devices
    .filter(mayHoldRelayBinding)
    .map((d) => d.apnsToken!.toLowerCase());
  if (tokens.length > 0) {
    await db.pushRelayUnbind.createMany({
      data: tokens.map((token) => ({ token })),
      skipDuplicates: true,
    });
  }
  const ids = devices.map((d) => d.id);
  await db.liveActivityToken.deleteMany({ where: { deviceId: { in: ids } } });
  // A relay push still waiting was sealed for the keys the device just gave
  // up; it must not go out once the device signs in again.
  await db.pushRelayDelivery.deleteMany({
    where: { deviceId: { in: ids }, status: "pending" },
  });
  await db.device.updateMany({
    where: { id: { in: ids } },
    data: clearedPushCredentials(),
  });
  return tokens;
}

/**
 * The devices of `userId` that hold a push credential, had a native sign-in
 * and have no live one left. Exported for the nightly sweep's tests.
 */
export async function signedOutDevices(
  db: Db,
  userId: string,
  now: Date = new Date(),
) {
  const devices = await db.device.findMany({
    where: {
      userId,
      OR: [
        { apnsToken: { not: null } },
        { pushKeyPublic: { not: null } },
        { relayState: { not: "none" } },
        { relayConsentAt: { not: null } },
        { liveActivityPushToken: { not: null } },
        { laStartToken: { not: null } },
        { liveActivities: { some: {} } },
      ],
    },
    select: {
      id: true,
      token: true,
      apnsToken: true,
      relayState: true,
      relayConsentAt: true,
    },
  });
  if (devices.length === 0) return [];
  const deviceTokens = devices.map((d) => d.token);
  const [any, live] = await Promise.all([
    db.refreshToken.findMany({
      where: { userId, deviceId: { in: deviceTokens } },
      distinct: ["deviceId"],
      select: { deviceId: true },
    }),
    db.refreshToken.findMany({
      where: {
        userId,
        deviceId: { in: deviceTokens },
        ...liveRefreshTokenWhere(now),
      },
      distinct: ["deviceId"],
      select: { deviceId: true },
    }),
  ]);
  const signedIn = new Set(any.map((r) => r.deviceId));
  const stillLive = new Set(live.map((r) => r.deviceId));
  return devices.filter(
    (d) => signedIn.has(d.token) && !stillLive.has(d.token),
  );
}

/**
 * Run after a revocation of `userId`'s refresh tokens, inside its
 * transaction when it has one: strip every device of the account that has no
 * live sign-in left. Returns the relay tokens queued for unbinding.
 */
export async function stripSignedOutDevicePush(
  db: Db,
  userId: string,
): Promise<string[]> {
  const devices = await signedOutDevices(db, userId);
  const tokens = await stripDevicePush(db, devices);
  if (devices.length > 0) {
    getEvent()?.addMeta("signed_out_devices_stripped", devices.length);
  }
  return tokens;
}

/**
 * Try the queued unbinds at once; the relay's minute pass retries what does
 * not go through. Never throws: the revocation it follows has committed.
 */
export async function drainQueuedUnbinds(
  tokens: readonly string[],
): Promise<void> {
  if (tokens.length === 0) return;
  try {
    await drainRelayUnbinds(new Date(), relayConfig(), tokens);
  } catch (err) {
    getEvent()?.addWarning(
      `push_relay_unbind_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * `stripSignedOutDevicePush` for a revocation that ran without a transaction
 * of its own, followed by the immediate unbind attempt. Best effort: a
 * failure is reported on the wide event and left to the nightly sweep.
 */
export async function afterRefreshRevocation(userId: string): Promise<void> {
  try {
    // The running Activities end while the device still holds the tokens
    // and the relay binding that reach them (`live-activity-end.ts`).
    const devices = await signedOutDevices(prisma, userId);
    await endDeviceLiveActivities(devices.map((d) => d.id));
    await drainQueuedUnbinds(await stripSignedOutDevicePush(prisma, userId));
  } catch (err) {
    getEvent()?.addWarning(
      `signed_out_device_strip_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Accounts one nightly sweep strips at most; the rest wait a night. */
const SWEEP_ACCOUNTS = 500;

/**
 * The nightly net for the sign-ins nothing revoked: a family that simply
 * expired (the app was not opened for the refresh lifetime) leaves its device
 * signed out without any writer to hook. Strips every such device across
 * accounts and returns how many accounts it touched.
 */
export async function sweepSignedOutDevices(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const at = now.toISOString();
  const rows = await db.$queryRaw<Array<{ userId: string }>>`
    SELECT DISTINCT d.user_id AS "userId"
      FROM devices AS d
     WHERE (d.apns_token IS NOT NULL
            OR d.push_key_public IS NOT NULL
            OR d.relay_state <> 'none'
            OR d.relay_consent_at IS NOT NULL
            OR d.live_activity_push_token IS NOT NULL
            OR d.la_start_token IS NOT NULL
            OR EXISTS (SELECT 1 FROM live_activity_tokens AS l
                        WHERE l.device_id = d.id))
       AND EXISTS (SELECT 1 FROM refresh_tokens AS r
                    WHERE r.user_id = d.user_id AND r.device_id = d.token)
       AND NOT EXISTS (
             SELECT 1 FROM refresh_tokens AS r
              WHERE r.user_id = d.user_id
                AND r.device_id = d.token
                AND r.revoked_at IS NULL
                AND r.used_at IS NULL
                AND r.expires_at > (${at}::timestamptz AT TIME ZONE 'UTC'))
     LIMIT ${SWEEP_ACCOUNTS}
  `;
  for (const { userId } of rows) {
    const devices = await signedOutDevices(db, userId, now);
    await endDeviceLiveActivities(devices.map((d) => d.id));
    await drainQueuedUnbinds(await stripDevicePush(db, devices));
  }
  return rows.length;
}
