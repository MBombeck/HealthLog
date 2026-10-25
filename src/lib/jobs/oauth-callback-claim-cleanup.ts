/**
 * Daily sweep for `oauth_callback_claims`.
 *
 * A claim is taken when a connect callback is about to exchange its code
 * (`src/lib/oauth/callback-claim.ts`) and is useless once its state has
 * expired. The callback itself sweeps expired rows whenever one completes, so
 * on a quiet instance the last few claims would stay until the next connect.
 * This pass rides the daily Withings OAuth-state cleanup (03:20 Europe/Berlin)
 * so the table empties on its own regardless. Idempotent.
 */
// account-deletion(file): expires single-use callback claims; acts for no account.
import type { PrismaClient } from "@/generated/prisma/client";

export async function cleanupExpiredOAuthCallbackClaims(
  prisma: Pick<PrismaClient, "oAuthCallbackClaim">,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.oAuthCallbackClaim.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}
