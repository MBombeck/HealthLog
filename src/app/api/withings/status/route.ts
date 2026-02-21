import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt, encrypt } from "@/lib/crypto";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import { refreshAccessToken } from "@/lib/withings/client";

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
      accessToken: true,
      refreshToken: true,
      lastSyncedAt: true,
      tokenExpiresAt: true,
      createdAt: true,
    },
  });

  if (!connection) {
    return apiSuccess({ connected: false, configured });
  }

  let tokenExpiresAt = connection.tokenExpiresAt;
  const now = Date.now();
  let tokenExpired = tokenExpiresAt.getTime() <= now;
  let tokenRefreshFailed = false;

  // Keep status reliable: if token is expired (or about to expire), refresh it
  // before reporting "abgelaufen" in the UI.
  const shouldRefresh = tokenExpiresAt.getTime() - 60_000 <= now;
  if (shouldRefresh) {
    try {
      const creds = await getUserWithingsCredentials(sessionData.user.id);
      if (creds) {
        const refreshToken = decrypt(connection.refreshToken);
        const refreshed = await refreshAccessToken(refreshToken, creds);
        tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
        tokenExpired = tokenExpiresAt.getTime() <= Date.now();

        await prisma.withingsConnection.update({
          where: { userId: sessionData.user.id },
          data: {
            accessToken: encrypt(refreshed.access_token),
            refreshToken: encrypt(refreshed.refresh_token),
            tokenExpiresAt,
          },
        });
      } else if (tokenExpired) {
        tokenRefreshFailed = true;
      }
    } catch (error) {
      if (tokenExpired) {
        tokenRefreshFailed = true;
      }
      console.error("[withings] Status token refresh failed:", error);
    }
  }

  return apiSuccess({
    connected: true,
    configured,
    lastSyncedAt: connection.lastSyncedAt,
    connectedAt: connection.createdAt,
    tokenExpired,
    tokenRefreshFailed,
    tokenExpiresAt,
  });
}
