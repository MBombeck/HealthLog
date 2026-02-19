import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";

/**
 * Get Withings connection status for the current user.
 * "configured" now checks per-user credentials instead of env vars.
 */
export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const user = await prisma.user.findUnique({
    where: { id: sessionData.user.id },
    select: {
      withingsClientIdEncrypted: true,
      withingsClientSecretEncrypted: true,
    },
  });

  const configured =
    !!user?.withingsClientIdEncrypted && !!user?.withingsClientSecretEncrypted;

  const connection = await prisma.withingsConnection.findUnique({
    where: { userId: sessionData.user.id },
    select: {
      withingsUserId: true,
      lastSyncedAt: true,
      tokenExpiresAt: true,
      createdAt: true,
    },
  });

  if (!connection) {
    return apiSuccess({ connected: false, configured });
  }

  return apiSuccess({
    connected: true,
    configured,
    lastSyncedAt: connection.lastSyncedAt,
    connectedAt: connection.createdAt,
    tokenExpired: connection.tokenExpiresAt < new Date(),
  });
}
