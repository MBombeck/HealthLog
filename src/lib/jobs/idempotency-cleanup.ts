/**
 * Daily cleanup for the `idempotency_keys` table.
 *
 * `withIdempotency()` (src/lib/idempotency.ts) only purges a row lazily
 * on the next lookup with the same `(userId, key, method, path)` tuple
 * — most rows never see another retry, so without a sweeper the table
 * grows unbounded with stale 24h-expired entries.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export async function cleanupExpiredIdempotencyKeys(
  prisma: PrismaClient,
): Promise<number> {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}
