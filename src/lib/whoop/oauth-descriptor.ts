/**
 * Where a WHOOP grant lives and how its token endpoint is called, for the
 * shared token lifecycle (`src/lib/integrations/oauth-kit/token.ts`).
 *
 * WHOOP keeps an expiry on `WhoopConnection`, so the token is refreshed ahead
 * of it, and rotates the refresh token on every use. A connection without a
 * WHOOP user id is a connect still in flight and has no usable grant yet.
 */
import type { OAuthTokenDescriptor } from "@/lib/integrations/oauth-kit/token";
import { type WhoopCredentials, whoopOAuth } from "./oauth";
import { getUserWhoopCredentials } from "./credentials";

/** Refresh this long before the stored expiry. */
export const WHOOP_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const whoopTokenDescriptor: OAuthTokenDescriptor<WhoopCredentials> = {
  provider: "whoop",
  tracksExpiry: true,
  expiryBufferMs: WHOOP_TOKEN_REFRESH_BUFFER_MS,
  async readGrant(db, userId) {
    const row = await db.whoopConnection.findUnique({
      where: { userId },
      select: {
        whoopUserId: true,
        accessToken: true,
        refreshToken: true,
        tokenExpiresAt: true,
      },
    });
    if (!row?.whoopUserId) return null;
    return {
      accessCiphertext: row.accessToken,
      refreshCiphertext: row.refreshToken,
      expiresAt: row.tokenExpiresAt,
    };
  },
  async writeGrant(db, userId, spent, next) {
    const { count } = await db.whoopConnection.updateMany({
      where: { userId, refreshToken: spent },
      data: {
        accessToken: next.accessCiphertext,
        refreshToken: next.refreshCiphertext,
        ...(next.expiresAt ? { tokenExpiresAt: next.expiresAt } : {}),
      },
    });
    return count;
  },
  loadCredentials: (userId) => getUserWhoopCredentials(userId),
  refresh: (refreshToken, credentials) =>
    whoopOAuth.refresh(refreshToken, credentials),
};
