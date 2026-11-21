/**
 * v1.4.23 (HIGH 6 / S-01) — shared device-revoke cascade.
 *
 * Both `DELETE /api/auth/me/devices/[id]` and `DELETE /api/devices/[id]`
 * historically performed the same four-write cascade (refresh-token
 * lookup → refresh revoke → access-token revoke → device delete) as
 * separate Prisma calls. Without a transaction, a partial failure
 * (Postgres connection blip, app crash) left the device row alive
 * with all its tokens revoked — the user's iPad showed in the device
 * list as "still registered" but every request returned 401, and the
 * only fix was admin intervention.
 *
 * `revokeDeviceCascade` wraps the four writes in `prisma.$transaction`
 * so the cascade is atomic. Both routes call this helper and only
 * differ in the audit-log `details.via` slot + the wide-event action
 * name they emit afterwards (those stay route-local because they
 * carry surface-specific context).
 *
 * Returns `null` when the device doesn't exist or belongs to another
 * user (the route turns this into a 404 — leaking "this id exists but
 * isn't yours" would let an attacker enumerate device ids).
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { unbindToken } from "@/lib/push-relay/binding";

export interface RevokeDeviceCascadeResult {
  id: string;
  label: string | null;
  refreshTokensRevoked: number;
  accessTokensRevoked: number;
}

export async function revokeDeviceCascade(
  userId: string,
  deviceId: string,
): Promise<RevokeDeviceCascadeResult | null> {
  // Ownership lookup outside the transaction — the cascade only runs
  // for an owned, existing device, so resolving the row first keeps
  // the transactional window tight.
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      userId: true,
      model: true,
      bundleId: true,
      apnsToken: true,
      relayState: true,
    },
  });

  if (!device || device.userId !== userId) {
    return null;
  }

  const liveRefreshTokens = await prisma.refreshToken.findMany({
    where: { userId, deviceId: device.id, revokedAt: null },
    select: { accessTokenHash: true },
  });
  const accessHashes = liveRefreshTokens
    .map((r) => r.accessTokenHash)
    .filter((v): v is string => Boolean(v));
  const revokedAt = new Date();

  // Build the write set as a `$transaction` array so all writes
  // commit together or none of them do. Avoids the "tokens revoked
  // but device row alive" half-state the W6 review flagged.
  // The array uses `unknown` because Prisma's overloaded
  // $transaction type narrows on the literal array shape; the
  // operations are still strongly typed at construction.
  const writes: unknown[] = [
    prisma.refreshToken.updateMany({
      where: { userId, deviceId: device.id, revokedAt: null },
      data: { revokedAt },
    }),
  ];
  if (accessHashes.length > 0) {
    writes.push(
      prisma.apiToken.updateMany({
        where: { tokenHash: { in: accessHashes }, revoked: false },
        data: { revoked: true },
      }),
    );
  }
  writes.push(prisma.device.delete({ where: { id: device.id } }));

  await prisma.$transaction(writes as never);

  // A revoked device leaves the push relay too, so its token is not bound to
  // this instance until the relay's own idle expiry. Best effort: the relay
  // answers 204 whether or not the token was bound.
  if (device.relayState !== "none") {
    await unbindToken(device.apnsToken).catch((err: unknown) => {
      getEvent()?.addWarning(
        `push_relay_unbind_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  return {
    id: device.id,
    label: device.model ?? device.bundleId ?? null,
    refreshTokensRevoked: liveRefreshTokens.length,
    accessTokensRevoked: accessHashes.length,
  };
}
