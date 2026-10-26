/**
 * Where a Google Health grant lives and how its token endpoint is called, for
 * the shared token lifecycle (`src/lib/integrations/oauth-kit/token.ts`).
 *
 * Google keeps an expiry on `GoogleHealthConnection`, so the token is refreshed
 * ahead of it. Google does not rotate refresh tokens: a refresh usually comes
 * back without one, and the kit then keeps the stored refresh token.
 */
import type { OAuthTokenDescriptor } from "@/lib/integrations/oauth-kit/token";
import { type GoogleHealthCredentials, googleHealthOAuth } from "./oauth";
import { getUserGoogleHealthCredentials } from "./credentials";

/** Refresh this long before the stored expiry. */
export const GOOGLE_HEALTH_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const googleHealthTokenDescriptor: OAuthTokenDescriptor<GoogleHealthCredentials> =
  {
    provider: "google-health",
    tracksExpiry: true,
    expiryBufferMs: GOOGLE_HEALTH_TOKEN_REFRESH_BUFFER_MS,
    async readGrant(db, userId) {
      const row = await db.googleHealthConnection.findUnique({
        where: { userId },
        select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
      });
      if (!row) return null;
      return {
        accessCiphertext: row.accessToken,
        refreshCiphertext: row.refreshToken,
        expiresAt: row.tokenExpiresAt,
      };
    },
    async writeGrant(db, userId, spent, next) {
      const { count } = await db.googleHealthConnection.updateMany({
        where: { userId, refreshToken: spent },
        data: {
          accessToken: next.accessCiphertext,
          refreshToken: next.refreshCiphertext,
          ...(next.expiresAt ? { tokenExpiresAt: next.expiresAt } : {}),
        },
      });
      return count;
    },
    loadCredentials: (userId) => getUserGoogleHealthCredentials(userId),
    refresh: (refreshToken, credentials) =>
      googleHealthOAuth.refresh(refreshToken, credentials),
  };
