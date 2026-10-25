/**
 * The statements that end every credential an account holds.
 *
 * A leaf module, so the account-deletion lock can run the same list inside
 * its own transaction without importing the session module (and with it
 * `next/headers`). `destroyAllSessions` runs it as a batch.
 */
import type { Prisma } from "@/generated/prisma/client";

type CredentialStore = Pick<
  Prisma.TransactionClient,
  | "session"
  | "apiToken"
  | "refreshToken"
  | "trustedDevice"
  | "mcpOAuthConnection"
  | "clinicianShareLink"
  | "stepUpElevation"
>;

/**
 * The statements that end every credential `userId` holds, unexecuted, so
 * the same list runs as `destroyAllSessions`' batch and inside a caller's own
 * transaction (account deletion locks the account with them). Each is a lazy
 * Prisma promise: nothing runs until it is awaited or batched.
 */
export function credentialRevocations(
  db: CredentialStore,
  userId: string,
): Prisma.PrismaPromise<unknown>[] {
  const now = new Date();
  return [
    db.session.deleteMany({ where: { userId } }),
    db.apiToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    }),
    db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
    // A credential rotation also kills every "remember this device"
    // trusted-device token: a stolen device cookie must not survive a
    // password change or account-credential remediation.
    db.trustedDevice.deleteMany({ where: { userId } }),
    // A connected AI assistant holds a refresh chain of its own: revoking its
    // access tokens above left the connection able to mint the next one.
    db.mcpOAuthConnection.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
    // A clinician share link opens the record without signing in. Whoever
    // held the old password could have made one, and it would outlive the
    // change; the owner makes a fresh link for the people who should keep it.
    db.clinicianShareLink.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
    db.stepUpElevation.deleteMany({ where: { userId } }),
  ];
}
