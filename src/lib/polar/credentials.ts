/**
 * v1.17.0 — per-user Polar token accessors.
 * v1.17.1 — per-user BYO client id/secret resolver (DB-first then env).
 *
 * Like WHOOP / Fitbit, Polar is now a per-user BYO-key integration: each user
 * may register their own AccessLink app and store the client id/secret encrypted
 * on `User`, with a fall-back to the shared env app for existing single-app
 * deploys. Also per-user is the granted token + Polar member id. Polar access
 * tokens do not expire and carry no refresh token, so there is no refresh path —
 * a revoked grant surfaces as a 401 on the next read.
 */
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { obtainAccessToken } from "@/lib/integrations/oauth-kit/token";
import { getPolarCredentials, type PolarCredentials } from "./oauth";
import { polarTokenDescriptor } from "./oauth-descriptor";

/**
 * Resolve the user's Polar OAuth client id/secret, DB-first then env.
 *
 * v1.17.1 makes Polar a per-user BYO-key integration (mirroring WHOOP / Fitbit):
 * a self-hoster registers their own Polar AccessLink app and pastes the client
 * id/secret into Settings, stored encrypted on `User`. When the user has not
 * configured per-user keys we fall back to the shared env app
 * (`POLAR_CLIENT_ID` / `POLAR_CLIENT_SECRET`) so existing single-app deploys
 * keep working. Returns null when neither source is configured.
 */
export async function getPolarClientCredentials(
  userId: string,
): Promise<PolarCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      polarClientIdEncrypted: true,
      polarClientSecretEncrypted: true,
    },
  });

  if (user?.polarClientIdEncrypted && user?.polarClientSecretEncrypted) {
    return {
      clientId: decrypt(user.polarClientIdEncrypted),
      clientSecret: decrypt(user.polarClientSecretEncrypted),
    };
  }

  // Fall back to the shared env-configured OAuth app.
  return getPolarCredentials();
}

/** Persist the user's Polar OAuth client id/secret, encrypted at rest. */
export async function storePolarClientCredentials(
  userId: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      polarClientIdEncrypted: encrypt(clientId),
      polarClientSecretEncrypted: encrypt(clientSecret),
    },
  });
}

/** Clear the user's stored Polar OAuth client id/secret. */
export async function clearPolarClientCredentials(
  userId: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      polarClientIdEncrypted: null,
      polarClientSecretEncrypted: null,
    },
  });
}

export interface PolarConnection {
  accessToken: string;
  /** Polar numeric member id (`x_user_id`), needed for every data path. */
  polarUserId: string;
}

/**
 * Fetch + decrypt the user's stored Polar token, read through the shared OAuth
 * token lifecycle like every other provider's. Returns null when the user has
 * not connected Polar (no access token) or the member id is missing.
 */
export async function getPolarConnection(
  userId: string,
): Promise<PolarConnection | null> {
  const grant = await obtainAccessToken(polarTokenDescriptor, userId);
  if (grant.kind !== "token") return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { polarUserIdEncrypted: true },
  });
  if (!user?.polarUserIdEncrypted) return null;
  return {
    accessToken: grant.accessToken,
    polarUserId: decrypt(user.polarUserIdEncrypted),
  };
}
