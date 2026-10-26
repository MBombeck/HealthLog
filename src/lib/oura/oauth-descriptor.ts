/**
 * Where an Oura grant lives and how its token endpoint is called, for the
 * shared token lifecycle (`src/lib/integrations/oauth-kit/token.ts`).
 *
 * Oura's tokens sit on `User`, with no expiry column: the sync refreshes after
 * a refused read, and Oura rotates the refresh token on every use.
 */
import {
  obtainAccessToken,
  type OAuthTokenDescriptor,
} from "@/lib/integrations/oauth-kit/token";
import { type OuraCredentials, ouraOAuth } from "./oauth";
import { getOuraClientCredentials } from "./credentials";

export const ouraTokenDescriptor: OAuthTokenDescriptor<OuraCredentials> = {
  provider: "oura",
  tracksExpiry: false,
  expiryBufferMs: 0,
  async readGrant(db, userId) {
    const row = await db.user.findUnique({
      where: { id: userId },
      select: {
        ouraAccessTokenEncrypted: true,
        ouraRefreshTokenEncrypted: true,
      },
    });
    if (!row?.ouraAccessTokenEncrypted || !row.ouraRefreshTokenEncrypted) {
      return null;
    }
    return {
      accessCiphertext: row.ouraAccessTokenEncrypted,
      refreshCiphertext: row.ouraRefreshTokenEncrypted,
      expiresAt: null,
    };
  },
  async writeGrant(db, userId, spent, next) {
    const { count } = await db.user.updateMany({
      where: { id: userId, ouraRefreshTokenEncrypted: spent },
      data: {
        ouraAccessTokenEncrypted: next.accessCiphertext,
        ouraRefreshTokenEncrypted: next.refreshCiphertext,
      },
    });
    return count;
  },
  loadCredentials: (userId) => getOuraClientCredentials(userId),
  refresh: (refreshToken, credentials) =>
    ouraOAuth.refresh(refreshToken, credentials),
};

/**
 * Refresh after Oura refused the token read with `spentRefreshCiphertext`,
 * once however many syncs ask at the same moment. Returns the access token to
 * retry with, or null when there is nothing to retry with (no connection, or
 * no OAuth client to refresh as). A refused refresh throws for the caller to
 * classify.
 */
export async function refreshOuraAfterRefusal(
  userId: string,
  spentRefreshCiphertext: string,
): Promise<string | null> {
  const result = await obtainAccessToken(ouraTokenDescriptor, userId, {
    afterRefusalOf: spentRefreshCiphertext,
  });
  return result.kind === "token" ? result.accessToken : null;
}
