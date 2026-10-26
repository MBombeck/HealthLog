/**
 * Helper to retrieve per-user Fitbit / Google Health OAuth credentials from the
 * database. Mirrors `src/lib/whoop/credentials.ts`.
 *
 * Fitbit ships per-user BYO-keys: each self-hoster registers their own Google
 * Cloud OAuth client and pastes the client id/secret into Settings, stored
 * encrypted on `User` (the Restricted-scope brand verification + annual CASA
 * assessment is per-OAuth-client, so a single shared app is unworkable for a
 * multi-operator product).
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import type { FitbitCredentials } from "./oauth";

/**
 * Fetch and decrypt the user's Fitbit API credentials.
 * Returns null if the user has not configured credentials.
 */
export async function getUserFitbitCredentials(
  userId: string,
): Promise<FitbitCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      fitbitClientIdEncrypted: true,
      fitbitClientSecretEncrypted: true,
    },
  });

  if (!user?.fitbitClientIdEncrypted || !user?.fitbitClientSecretEncrypted) {
    return null;
  }

  return {
    clientId: decrypt(user.fitbitClientIdEncrypted),
    clientSecret: decrypt(user.fitbitClientSecretEncrypted),
  };
}
