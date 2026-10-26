/**
 * v1.17.0 — per-user Oura token accessors.
 * v1.17.1 — per-user BYO client id/secret resolver (DB-first then env).
 *
 * Like WHOOP / Fitbit, Oura is now a per-user BYO-key integration: each user may
 * register their own Oura app and store the client id/secret encrypted on
 * `User`, with a fall-back to the shared env app for existing single-app
 * deploys. Also per-user is the granted access + refresh token. The schema
 * carries NO token-expiry column, so the sync layer refreshes REACTIVELY on a
 * 401 rather than proactively on an expiry timestamp (persisting both rotated
 * tokens).
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { decrypt, encrypt } from "@/lib/crypto";
import { getOuraCredentials, type OuraCredentials } from "./oauth";

/**
 * Resolve the user's Oura OAuth client id/secret, DB-first then env.
 *
 * v1.17.1 makes Oura a per-user BYO-key integration (mirroring WHOOP / Fitbit):
 * a self-hoster registers their own Oura app and pastes the client id/secret
 * into Settings, stored encrypted on `User`. When the user has not configured
 * per-user keys we fall back to the shared env app (`OURA_CLIENT_ID` /
 * `OURA_CLIENT_SECRET`) so existing single-app deploys keep working. Returns
 * null when neither source is configured.
 */
export async function getOuraClientCredentials(
  userId: string,
): Promise<OuraCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ouraClientIdEncrypted: true,
      ouraClientSecretEncrypted: true,
    },
  });

  if (user?.ouraClientIdEncrypted && user?.ouraClientSecretEncrypted) {
    return {
      clientId: decrypt(user.ouraClientIdEncrypted),
      clientSecret: decrypt(user.ouraClientSecretEncrypted),
    };
  }

  // Fall back to the shared env-configured OAuth app.
  return getOuraCredentials();
}

/** Persist the user's Oura OAuth client id/secret, encrypted at rest. */
export async function storeOuraClientCredentials(
  userId: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      ouraClientIdEncrypted: encrypt(clientId),
      ouraClientSecretEncrypted: encrypt(clientSecret),
    },
  });
}

/** Clear the user's stored Oura OAuth client id/secret. */
export async function clearOuraClientCredentials(
  userId: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      ouraClientIdEncrypted: null,
      ouraClientSecretEncrypted: null,
    },
  });
}

export interface OuraConnection {
  accessToken: string;
  /**
   * The exact stored refresh-token ciphertext (NOT the decrypted value).
   * `refreshOuraAfterRefusal` compares against it under the refresh lock to
   * tell whether a peer already rotated the token this sync started with.
   */
  refreshTokenCiphertext: string;
  /** Collections the grant was last seen not to cover (`ouraScopeDenied`). */
  scopeDenied?: string[];
}

export async function getOuraConnection(
  userId: string,
): Promise<OuraConnection | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ouraAccessTokenEncrypted: true,
      ouraRefreshTokenEncrypted: true,
      ouraScopeDenied: true,
    },
  });
  if (!user?.ouraAccessTokenEncrypted || !user?.ouraRefreshTokenEncrypted) {
    return null;
  }
  return {
    accessToken: decrypt(user.ouraAccessTokenEncrypted),
    refreshTokenCiphertext: user.ouraRefreshTokenEncrypted,
    scopeDenied: readOuraScopeDenied(user.ouraScopeDenied),
  };
}

/**
 * Collections the current Oura grant does not cover, by collection name. Read
 * by the settings envelope; an absent or malformed value reads as none.
 */
export function readOuraScopeDenied(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is string => typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v),
  );
}

/**
 * Record which collections the grant does not cover after a sync, writing only
 * when the set changed so an hourly poll does not touch the user row for
 * nothing. An empty set clears the column.
 */
export async function syncOuraScopeDenied(
  userId: string,
  denied: readonly string[],
): Promise<void> {
  const next = [...new Set(denied)].sort();
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { ouraScopeDenied: true },
  });
  const current = readOuraScopeDenied(row?.ouraScopeDenied).sort();
  if (current.length === next.length && current.every((v, i) => v === next[i]))
    return;
  await prisma.user.update({
    where: { id: userId },
    data: { ouraScopeDenied: next.length > 0 ? next : Prisma.DbNull },
  });
}
