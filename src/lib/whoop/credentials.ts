/**
 * Helper to retrieve per-user WHOOP OAuth credentials from the database.
 * Mirrors `src/lib/withings/credentials.ts`.
 *
 * WHOOP ships per-user BYO-keys: each self-hoster registers their own WHOOP
 * dev app and pastes the client id/secret into Settings, stored encrypted on
 * `User` (the per-app authorized-user cap makes a single shared app
 * unworkable for a multi-operator product).
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import type { WhoopCredentials } from "./oauth";

/**
 * Fetch and decrypt the user's WHOOP API credentials.
 * Returns null if the user has not configured credentials.
 */
export async function getUserWhoopCredentials(
  userId: string,
): Promise<WhoopCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      whoopClientIdEncrypted: true,
      whoopClientSecretEncrypted: true,
    },
  });

  if (!user?.whoopClientIdEncrypted || !user?.whoopClientSecretEncrypted) {
    return null;
  }

  return {
    clientId: decrypt(user.whoopClientIdEncrypted),
    clientSecret: decrypt(user.whoopClientSecretEncrypted),
  };
}
