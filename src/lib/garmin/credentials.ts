/**
 * The per-account Garmin connection: one Personal API key the person pasted,
 * sealed at rest under the fail-closed `*Encrypted` convention, beside the
 * host region it was accepted on and what is known about when it expires.
 * This helper is the single read+decrypt path the sync, the backfill and the
 * routes share; nothing else decrypts the key.
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

import { isGarminRegion, type GarminRegion } from "./client";

export interface GarminCredentials {
  apiKey: string;
  region: GarminRegion;
  keyExpiresAt: Date | null;
  connectedAt: Date | null;
}

/** Fetch and decrypt the account's Garmin key; null when none is stored. */
export async function getGarminCredentials(
  userId: string,
): Promise<GarminCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      garminApiKeyEncrypted: true,
      garminRegion: true,
      garminKeyExpiresAt: true,
      garminConnectedAt: true,
    },
  });
  if (!user?.garminApiKeyEncrypted) return null;
  return {
    apiKey: decrypt(user.garminApiKeyEncrypted),
    region: isGarminRegion(user.garminRegion) ? user.garminRegion : "global",
    keyExpiresAt: user.garminKeyExpiresAt,
    connectedAt: user.garminConnectedAt,
  };
}

/**
 * Keep the stored expiry honest after a run.
 *
 * - A token that revealed the key's end (`learned`) is Garmin's own figure
 *   and replaces whatever is stored, the estimate from the picked validity
 *   included.
 * - A key that just bought a token has not expired, whatever the estimate
 *   says: an estimate already in the past is wrong (the key was created
 *   later than assumed, or with a longer validity) and is cleared, so the
 *   card stops calling a working key expired.
 */
export async function rememberGarminKeyExpiry(
  userId: string,
  learned: number | null,
  stored: Date | null,
  opts: { exchanged?: boolean; now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  let next: Date | null | undefined;
  if (learned !== null) {
    if (!stored || Math.abs(stored.getTime() - learned) >= 60_000) {
      next = new Date(learned);
    }
  } else if (opts.exchanged && stored && stored.getTime() <= now.getTime()) {
    next = null;
  }
  if (next === undefined) return;
  await prisma.user.updateMany({
    where: { id: userId, garminApiKeyEncrypted: { not: null } },
    data: { garminKeyExpiresAt: next },
  });
}
