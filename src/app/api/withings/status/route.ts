import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";

/**
 * Get Withings connection status for the current user.
 */
export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

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
    return apiSuccess({ connected: false });
  }

  return apiSuccess({
    connected: true,
    lastSyncedAt: connection.lastSyncedAt,
    connectedAt: connection.createdAt,
    tokenExpired: connection.tokenExpiresAt < new Date(),
  });
}
