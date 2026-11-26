/**
 * End every way into an account: the one function behind each "end this
 * user's sessions" action (the password change, the admin password reset,
 * the admin force logout).
 *
 * It runs every statement `credentialRevocations` lists (web sessions, every
 * native sign-in's refresh token family and paired access token, API tokens,
 * trusted devices, step-up elevations, connected assistants, share links,
 * calendar feeds and emergency-card links), then strips the push credentials
 * of the devices left without a live sign-in. The account-deletion lock runs
 * the same list inside its own transaction; an action that keeps the
 * caller's own credential uses `destroyOtherSessions` instead. Rows are
 * revoked rather than deleted where they can be, so the audit trail survives.
 * `src/__tests__/session-termination-guard.test.ts` holds new code to it.
 */
import { prisma } from "@/lib/db";
import { credentialRevocations } from "@/lib/auth/credential-revocations";
import { liveRefreshTokenWhere } from "@/lib/devices/live-sign-in";
import { afterRefreshRevocation } from "@/lib/devices/signed-out-push";

/** What ended: web sessions, and the device sign-ins that were live. */
type AllSessionsDestroyed = {
  webSessions: number;
  deviceSignIns: number;
};

export async function destroyAllSessions(
  userId: string,
): Promise<AllSessionsDestroyed> {
  // One transaction: count the live sign-ins, then end them. The session
  // delete is the first statement `credentialRevocations` lists.
  const [deviceSignIns, sessions] = await prisma.$transaction([
    prisma.refreshToken.count({
      where: { userId, ...liveRefreshTokenWhere(new Date()) },
    }),
    ...credentialRevocations(prisma, userId),
  ]);
  // Every native sign-in ended: the account's devices take no more pushes.
  await afterRefreshRevocation(userId);
  return {
    webSessions: (sessions as { count: number }).count,
    deviceSignIns: deviceSignIns as number,
  };
}
