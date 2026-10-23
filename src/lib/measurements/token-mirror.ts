/**
 * Switching a measurement token's Apple Health write-back (#1272), for
 * `PATCH /api/tokens/{id}`.
 *
 * One statement on the token row. The readings the token carried are not
 * touched: their `updatedAt` and `syncVersion` stay as they are, so nothing
 * keyed on them (the rollup freshness probe, personal-record detection, the
 * status re-warm) sees a change that is not one. The rows reach a paired
 * client again through the `measurementMirror` domain of `/api/sync/changes`,
 * keyed on the `mirrorChangedAt` this stamps.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

/** A token minted by `POST /api/tokens/measurements`, and nothing else. */
export function isMeasurementToken(permissions: readonly string[]): boolean {
  return (
    permissions.length === 1 && permissions[0] === MEASUREMENTS_WRITE_SCOPE
  );
}

export type TokenMirrorOutcome =
  | { kind: "not_found" }
  | { kind: "not_measurement_token" }
  | { kind: "set"; mirrorToAppleHealth: boolean };

export async function setMeasurementTokenMirror(input: {
  userId: string;
  tokenId: string;
  mirrorToAppleHealth: boolean;
  ipAddress: string | null;
}): Promise<TokenMirrorOutcome> {
  const { userId, tokenId, mirrorToAppleHealth } = input;
  const token = await prisma.apiToken.findUnique({
    where: { id: tokenId },
    select: { userId: true, permissions: true, mirrorToAppleHealth: true },
  });
  // Another account's token is answered as missing, like the revoke.
  if (!token || token.userId !== userId) return { kind: "not_found" };
  // A revoked token is accepted: its readings stay in the record, and
  // whether they are mirrored is still the person's choice.
  if (!isMeasurementToken(token.permissions)) {
    return { kind: "not_measurement_token" };
  }

  const changed = token.mirrorToAppleHealth !== mirrorToAppleHealth;
  if (changed) {
    await prisma.apiToken.update({
      where: { id: tokenId },
      data: { mirrorToAppleHealth, mirrorChangedAt: new Date() },
    });
    await auditLog("tokens.measurements.mirror.update", {
      userId,
      ipAddress: input.ipAddress,
      details: { tokenId, mirrorToAppleHealth },
    });
  }
  annotate({ meta: { mirror_to_apple_health: mirrorToAppleHealth, changed } });
  return { kind: "set", mirrorToAppleHealth };
}
