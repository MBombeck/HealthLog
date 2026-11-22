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
  | Pick<PrismaClient, "refreshToken" | "apiToken">
  | Pick<Prisma.TransactionClient, "refreshToken" | "apiToken">;

/** A refresh token that still signs its device in at `now`. */
export function liveRefreshTokenWhere(now: Date) {
  return {
    revokedAt: null,
    usedAt: null,
    expiresAt: { gt: now },
  } satisfies Prisma.RefreshTokenWhereInput;
}

/** How many consumed refresh tokens the access-token check looks at. */
const SUNSET_PAIRS = 20;

/**
 * True while the device row's account still has a live sign-in that is, or
 * may be, on this device. A sign-in that names no device (one made before
 * the app sent `X-Device-Id`) cannot be told apart from one on this device,
 * so it counts: the takeover fails closed.
 */
export async function deviceHasLiveSignIn(
  db: Db,
  device: { userId: string; token: string },
  now: Date = new Date(),
): Promise<boolean> {
  const onDevice = {
    userId: device.userId,
    OR: [{ deviceId: device.token }, { deviceId: null }],
  } satisfies Prisma.RefreshTokenWhereInput;
  const live = await db.refreshToken.findFirst({
    where: { ...onDevice, ...liveRefreshTokenWhere(now) },
    select: { id: true },
  });
  if (live) return true;
  // The pairs a rotation consumed: their access tokens run out a few seconds
  // after the rotation, unless the family was revoked with them.
  const consumed = await db.refreshToken.findMany({
    where: {
      ...onDevice,
      revokedAt: null,
      usedAt: { not: null },
      accessTokenHash: { not: null },
      expiresAt: { gt: now },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SUNSET_PAIRS,
    select: { accessTokenHash: true },
  });
  const hashes = consumed.flatMap((r) =>
    r.accessTokenHash ? [r.accessTokenHash] : [],
  );
  if (hashes.length === 0) return false;
  const access = await db.apiToken.findFirst({
    where: {
      userId: device.userId,
      tokenHash: { in: hashes },
      revoked: false,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true },
  });
  return access !== null;
}
