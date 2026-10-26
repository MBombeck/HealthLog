/**
 * Helper to retrieve per-user Google Health OAuth credentials from the database.
 * Mirrors `src/lib/whoop/credentials.ts`.
 *
 * Google Health ships per-user BYO-keys: each self-hoster registers their own
 * Google Cloud OAuth client and pastes the client id/secret into Settings,
 * stored encrypted on `User` (the Restricted-scope verification + annual CASA
 * assessment is per-OAuth-client, so a single shared app is unworkable for a
 * multi-operator product).
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import type { GoogleHealthCredentials } from "./oauth";

/**
 * Fetch and decrypt the user's Google Health API credentials.
 * Returns null if the user has not configured credentials.
 */
export async function getUserGoogleHealthCredentials(
  userId: string,
): Promise<GoogleHealthCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      googleHealthClientIdEncrypted: true,
      googleHealthClientSecretEncrypted: true,
    },
  });

  if (
    !user?.googleHealthClientIdEncrypted ||
    !user?.googleHealthClientSecretEncrypted
  ) {
    return null;
  }

  return {
    clientId: decrypt(user.googleHealthClientIdEncrypted),
    clientSecret: decrypt(user.googleHealthClientSecretEncrypted),
  };
}
