/**
 * Helper to retrieve per-user Withings OAuth credentials from the database.
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import type { WithingsCredentials } from "./client";

/**
 * Fetch and decrypt the user's Withings API credentials.
 * Returns null if the user has not configured credentials.
 */
export async function getUserWithingsCredentials(
  userId: string,
): Promise<WithingsCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      withingsClientIdEncrypted: true,
      withingsClientSecretEncrypted: true,
    },
  });

  if (
    !user?.withingsClientIdEncrypted ||
    !user?.withingsClientSecretEncrypted
  ) {
    return null;
  }

  return {
    clientId: decrypt(user.withingsClientIdEncrypted),
    clientSecret: decrypt(user.withingsClientSecretEncrypted),
  };
}
