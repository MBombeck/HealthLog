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
 * Persist the key's expiry a token revealed, when it differs from what is
 * stored. A learned expiry is Garmin's own figure and replaces the estimate
 * made from the validity picked at connect.
 */
export async function rememberGarminKeyExpiry(
  userId: string,
  learned: number | null,
  stored: Date | null,
): Promise<void> {
  if (learned === null) return;
  if (stored && Math.abs(stored.getTime() - learned) < 60_000) return;
  await prisma.user.updateMany({
    where: { id: userId, garminApiKeyEncrypted: { not: null } },
    data: { garminKeyExpiresAt: new Date(learned) },
  });
}
