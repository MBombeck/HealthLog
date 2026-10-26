/**
 * v1.30.x — daily cleanup for the `oidc_native_handoffs` table.
 *
 * Mirrors the OAuth-state sweeps (`whoop-oauth-state-cleanup`). Native OIDC
 * handoff codes are single-use + 90-second-lived: every exchange consumes its
 * row (`consumedAt`), and expiry is enforced at read, so a row only lingers
 * when the app never came back to exchange the code. Once `expiresAt` passes
 * the row is dead weight — deleting expired rows (consumed or not) keeps the
 * table and its `expires_at` index tight.
 *
 * Idempotent: a re-run within the same window matches zero rows the second time
 * because the first pass deleted everything older than `now()`.
 */
// account-deletion(file): expires single-use sign-in handoffs; acts for no account.
import type { PrismaClient } from "@/generated/prisma/client";

export async function cleanupExpiredOidcNativeHandoffs(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.oidcNativeHandoff.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}
