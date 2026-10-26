/**
 * Where a Strava grant lives and how its token endpoint is called, for the
 * shared token lifecycle (`src/lib/integrations/oauth-kit/token.ts`).
 *
 * Strava's tokens sit on `User`, with no expiry column: the sync refreshes
 * after a refused read, and Strava rotates the refresh token on every use.
 */
import {
  obtainAccessToken,
  type OAuthTokenDescriptor,
} from "@/lib/integrations/oauth-kit/token";
import { type StravaCredentials, stravaOAuth } from "./oauth";
import { getStravaClientCredentials } from "./credentials";

export const stravaTokenDescriptor: OAuthTokenDescriptor<StravaCredentials> = {
  provider: "strava",
  tracksExpiry: false,
  expiryBufferMs: 0,
  async readGrant(db, userId) {
    const row = await db.user.findUnique({
      where: { id: userId },
      select: {
        stravaAccessTokenEncrypted: true,
        stravaRefreshTokenEncrypted: true,
      },
    });
    if (!row?.stravaAccessTokenEncrypted || !row.stravaRefreshTokenEncrypted) {
      return null;
    }
    return {
      accessCiphertext: row.stravaAccessTokenEncrypted,
      refreshCiphertext: row.stravaRefreshTokenEncrypted,
      expiresAt: null,
    };
  },
  async writeGrant(db, userId, spent, next) {
    const { count } = await db.user.updateMany({
      where: { id: userId, stravaRefreshTokenEncrypted: spent },
      data: {
        stravaAccessTokenEncrypted: next.accessCiphertext,
        stravaRefreshTokenEncrypted: next.refreshCiphertext,
      },
    });
    return count;
  },
  loadCredentials: (userId) => getStravaClientCredentials(userId),
  refresh: (refreshToken, credentials) =>
    stravaOAuth.refresh(refreshToken, credentials),
};

/**
 * Refresh after Strava refused the token read with `spentRefreshCiphertext`,
 * once however many syncs ask together. Returns the access token to retry
 * with, or null when there is nothing to retry with. A refused refresh throws.
 */
export async function refreshStravaAfterRefusal(
  userId: string,
  spentRefreshCiphertext: string,
): Promise<string | null> {
  const result = await obtainAccessToken(stravaTokenDescriptor, userId, {
    afterRefusalOf: spentRefreshCiphertext,
  });
  return result.kind === "token" ? result.accessToken : null;
}
