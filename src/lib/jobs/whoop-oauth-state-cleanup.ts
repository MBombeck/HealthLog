/**
 * v1.11.0 — daily cleanup for the `whoop_oauth_states` table.
 *
 * Mirrors `withings-oauth-state-cleanup`. The OAuth state ledger is single-use
 * — every happy-path + error-path branch in `whoop/callback` consumes its row,
 * so an abandoned row only lingers when the user closed the WHOOP approval tab
 * without bouncing back to the callback URL. The cookie + row TTL is 10
 * minutes, so once the timestamp blows the row is dead weight.
 *
 * Idempotent: a re-run within the same window matches zero rows the second time
 * because the first pass deleted everything older than `now()`.
 */
// account-deletion(file): expires abandoned OAuth state rows and connect tickets; acts for no account.
import type { PrismaClient } from "@/generated/prisma/client";

export async function cleanupExpiredWhoopOAuthStates(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.whoopOAuthState.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}

/**
 * v1.12.2 — sweep expired (or already-consumed-and-now-stale)
 * `whoop_connect_tickets`. The tickets are single-use + ~60s-lived, so the
 * connect route consumes the live ones; this only reaps rows whose `expiresAt`
 * has passed (covers both never-used and consumed-then-expired). Same daily
 * cadence as the OAuth-state sweep above.
 */
export async function cleanupExpiredWhoopConnectTickets(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.whoopConnectTicket.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}
