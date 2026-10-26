/**
 * v1.28.x — per-user Strava token + BYO-key accessors.
 *
 * Like WHOOP / Oura / Polar, Strava is a per-user BYO-key integration: each
 * user registers their own Strava app and stores the client id/secret encrypted
 * on `User`, with a fall-back to the shared env app for single-app deploys.
 * Also per-user is the granted access + refresh token. The schema carries NO
 * token-expiry column, so the sync layer refreshes REACTIVELY on a 401 rather
 * than proactively on an expiry timestamp — and because Strava ROTATES its
 * refresh token on every refresh, both rotated tokens are persisted with a
 * compare-and-set on the stored refresh ciphertext (Oura's model verbatim).
 */
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { getStravaCredentials, type StravaCredentials } from "./oauth";

/**
 * Resolve the user's Strava OAuth client id/secret, DB-first then env. A
 * self-hoster's own BYO pair wins; when none is stored we fall back to the
 * shared env app (`STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET`). Returns null
 * when neither source is configured.
 */
export async function getStravaClientCredentials(
  userId: string,
): Promise<StravaCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      stravaClientIdEncrypted: true,
      stravaClientSecretEncrypted: true,
    },
  });

  if (user?.stravaClientIdEncrypted && user?.stravaClientSecretEncrypted) {
    return {
      clientId: decrypt(user.stravaClientIdEncrypted),
      clientSecret: decrypt(user.stravaClientSecretEncrypted),
    };
  }

  return getStravaCredentials();
}

/** Persist the user's Strava OAuth client id/secret, encrypted at rest. */
export async function storeStravaClientCredentials(
  userId: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      stravaClientIdEncrypted: encrypt(clientId),
      stravaClientSecretEncrypted: encrypt(clientSecret),
    },
  });
}

/** Clear the user's stored Strava OAuth client id/secret. */
export async function clearStravaClientCredentials(
  userId: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      stravaClientIdEncrypted: null,
      stravaClientSecretEncrypted: null,
    },
  });
}

/**
 * The `User` columns a removed Strava connection leaves behind: no tokens, no
 * athlete, and no backfill state. The backfill markers belong to the account
 * that was connected. Left standing, a later connection inherited them: a
 * completed marker kept its history from ever being read, and a resume point
 * made its first run start below the old account's oldest activity, so
 * everything newer was never asked for.
 */
export const STRAVA_DISCONNECTED = {
  stravaAccessTokenEncrypted: null,
  stravaRefreshTokenEncrypted: null,
  stravaAthleteId: null,
  stravaBackfillCompletedAt: null,
  stravaBackfillResumeBefore: null,
} as const;

export interface StravaConnection {
  accessToken: string;
  refreshToken: string;
  /**
   * The exact stored refresh-token ciphertext (NOT the decrypted value). The
   * refresh after a refusal (`refreshStravaAfterRefusal`) compares against it
   * so a concurrent sync that already rotated the token is not clobbered.
   */
  refreshTokenCiphertext: string;
}

export async function getStravaConnection(
  userId: string,
): Promise<StravaConnection | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      stravaAccessTokenEncrypted: true,
      stravaRefreshTokenEncrypted: true,
    },
  });
  if (!user?.stravaAccessTokenEncrypted || !user?.stravaRefreshTokenEncrypted) {
    return null;
  }
  return {
    accessToken: decrypt(user.stravaAccessTokenEncrypted),
    refreshToken: decrypt(user.stravaRefreshTokenEncrypted),
    refreshTokenCiphertext: user.stravaRefreshTokenEncrypted,
  };
}
