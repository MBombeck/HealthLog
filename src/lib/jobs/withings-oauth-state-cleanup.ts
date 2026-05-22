/**
 * Daily cleanup for the `withings_oauth_states` table.
 *
 * The v1.4.47 W6 OAuth state ledger is single-use — every happy-path
 * + error-path branch in `withings/callback` consumes its row, so an
 * abandoned row only lingers when the user closed the Withings
 * approval tab without ever bouncing back to the callback URL. The
 * cookie + row TTL is 10 minutes, so once the timestamp blows the
 * row is dead weight on the table.
 *
 * Runs daily at 03:20 Europe/Berlin (slotted between the audit-log
 * cleanup at 03:15 and the mood-reminder cleanup at 03:25) — the
 * table is bounded by `users × concurrent in-flight handshakes`, so
 * a daily sweep is overkill on volume but cheap and keeps the
 * `expires_at` index from accumulating dead tuples.
 *
 * The handler is idempotent: re-running it within the same window
 * matches zero rows the second time because the first pass deleted
 * everything older than `now()`.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export async function cleanupExpiredWithingsOAuthStates(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.withingsOAuthState.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}
