import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";

/**
 * Get WHOOP connection status for the current user (v1.11.0).
 *
 * Mirrors the Withings status route: `configured` checks the per-user BYO-key
 * credentials, the connection row reports last-sync + token expiry +
 * backfill progress. The token-refresh-in-status dance Withings does is not
 * needed here — WHOOP `tokenExpired` is reported straight off the row and the
 * sync path refreshes lazily via `getValidToken`.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      whoopClientIdEncrypted: true,
      whoopClientSecretEncrypted: true,
    },
  });

  const configured =
    !!dbUser?.whoopClientIdEncrypted && !!dbUser?.whoopClientSecretEncrypted;

  const connection = await prisma.whoopConnection.findUnique({
    where: { userId: user.id },
    select: {
      whoopUserId: true,
      lastSyncedAt: true,
      tokenExpiresAt: true,
      backfillCompletedAt: true,
      createdAt: true,
      scope: true,
    },
  });

  if (!connection?.whoopUserId) {
    return apiSuccess({ connected: false, configured });
  }

  const tokenExpired = connection.tokenExpiresAt.getTime() <= Date.now();

  return apiSuccess({
    connected: true,
    configured,
    lastSyncedAt: connection.lastSyncedAt,
    connectedAt: connection.createdAt,
    tokenExpired,
    tokenExpiresAt: connection.tokenExpiresAt,
    backfillCompleted: !!connection.backfillCompletedAt,
    scope: connection.scope,
  });
});
