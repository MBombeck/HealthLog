/**
 * v1.12.0 — daily cleanup for the `fitbit_oauth_states` table.
 *
 * Mirrors `whoop-oauth-state-cleanup`. The OAuth state ledger is single-use —
 * every happy-path + error-path branch in `fitbit/callback` consumes its row, so
 * an abandoned row only lingers when the user closed the Google approval tab
 * without bouncing back to the callback URL. The cookie + row TTL is 10 minutes,
 * so once the timestamp blows the row is dead weight.
 *
 * Idempotent: a re-run within the same window matches zero rows the second time
 * because the first pass deleted everything older than `now()`.
 */
// account-deletion(file): expires abandoned OAuth state rows; acts for no account.
import type { PrismaClient } from "@/generated/prisma/client";

export async function cleanupExpiredFitbitOAuthStates(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.fitbitOAuthState.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}
