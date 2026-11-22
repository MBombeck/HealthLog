/**
 * Whether a device is still signed in to the account its row belongs to.
 *
 * A native sign-in stores the device it was made on with its refresh token
 * (`RefreshToken.deviceId` is the `Device.token` the app sent as
 * `X-Device-Id`). The device is signed in while one of those tokens is live:
 * not revoked, not consumed by a rotation, not expired. The access token a
 * rotation consumed stays usable for its short sunset (`refresh-token.ts`),
 * so a live access token paired with one of the device's refresh tokens
 * counts as well.
 *
 * Two readers, one rule: the signed-out push strip (`signed-out-push.ts`),
 * which takes the push credentials off a device with no live sign-in left,
 * and the device takeover in `POST /api/devices`, which refuses to move a
 * row to another account while the device is still signed in to its own.
 * A cookie session is not tied to a device and never counts.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

type Db =
  Pick<PrismaClient, "$queryRaw"> | Pick<Prisma.TransactionClient, "$queryRaw">;

/** A refresh token that still signs its device in at `now`. */
export function liveRefreshTokenWhere(now: Date) {
  return {
    revokedAt: null,
    usedAt: null,
    expiresAt: { gt: now },
  } satisfies Prisma.RefreshTokenWhereInput;
}

/**
 * True while the device row's account still has a live sign-in that is, or
 * may be, on this device: a refresh token by {@link liveRefreshTokenWhere},
 * or a live access token paired with one of the device's unrevoked refresh
 * tokens (a rotation's sunset). A sign-in that names no device (one made
 * before the app sent `X-Device-Id`) cannot be told apart from one on this
 * device, so it counts: the takeover fails closed. One statement; it reads
 * stored rows only and authenticates nothing.
 */
export async function deviceHasLiveSignIn(
  db: Db,
  device: { userId: string; token: string },
  now: Date = new Date(),
): Promise<boolean> {
  const at = now.toISOString();
  const rows = await db.$queryRaw<Array<{ live: boolean }>>`
    SELECT EXISTS (
      SELECT 1
        FROM refresh_tokens AS r
        LEFT JOIN api_tokens AS t
          ON t.token_hash = r.access_token_hash
         AND t.user_id = r.user_id
         AND t.revoked = false
         AND (t.expires_at IS NULL
              OR t.expires_at > (${at}::timestamptz AT TIME ZONE 'UTC'))
       WHERE r.user_id = ${device.userId}
         AND (r.device_id = ${device.token} OR r.device_id IS NULL)
         AND r.revoked_at IS NULL
         AND r.expires_at > (${at}::timestamptz AT TIME ZONE 'UTC')
         AND (r.used_at IS NULL OR t.id IS NOT NULL)
    ) AS live
  `;
  return rows[0]?.live === true;
}
