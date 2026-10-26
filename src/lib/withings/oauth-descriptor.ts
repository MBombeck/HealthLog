/**
 * Where a Withings grant lives and how its token endpoint is called, for the
 * shared token lifecycle (`src/lib/integrations/oauth-kit/token.ts`).
 *
 * Withings keeps an expiry on `WithingsConnection`, so the token is refreshed
 * ahead of it, and rotates the refresh token on every use.
 */
import type { OAuthTokenDescriptor } from "@/lib/integrations/oauth-kit/token";
import { type WithingsCredentials, withingsOAuth } from "./oauth";
import { getUserWithingsCredentials } from "./credentials";

/** Refresh this long before the stored expiry. */
export const WITHINGS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const withingsTokenDescriptor: OAuthTokenDescriptor<WithingsCredentials> =
  {
    provider: "withings",
    tracksExpiry: true,
    expiryBufferMs: WITHINGS_TOKEN_REFRESH_BUFFER_MS,
    async readGrant(db, userId) {
      const row = await db.withingsConnection.findUnique({
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
      const { count } = await db.withingsConnection.updateMany({
        where: { userId, refreshToken: spent },
        data: {
          accessToken: next.accessCiphertext,
          refreshToken: next.refreshCiphertext,
          ...(next.expiresAt ? { tokenExpiresAt: next.expiresAt } : {}),
        },
      });
      return count;
    },
    loadCredentials: (userId) => getUserWithingsCredentials(userId),
    refresh: (refreshToken, credentials) =>
      withingsOAuth.refresh(refreshToken, credentials),
  };
