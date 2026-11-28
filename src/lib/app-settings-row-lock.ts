import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Run a read-merge-write on the instance settings row under a row lock.
 *
 * The instance's settings live on one `app_settings` row, and a few of them
 * are JSON documents a write changes one key of: it reads what is stored,
 * merges the key in and writes the whole document back. Two such writes that
 * overlap (two admins, or an admin and a job) both read the same document,
 * and the second drops the first one's key. `FOR UPDATE` queues them, as
 * `withUserRowLock` does for the account row.
 *
 * The row may not exist yet on a fresh instance, and `FOR UPDATE` on a row
 * that is not there locks nothing, so the lock first inserts the default row
 * when it is missing. Every writer under the lock upserts the same row anyway,
 * so the end state is the one it would have reached.
 *
 * Every write to the row inside `fn` must go through `tx`: a write through
 * the global client would wait for the lock this transaction holds.
 */
export function withAppSettingsRowLock<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "app_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING`;
    await tx.$queryRaw`SELECT 1 FROM "app_settings" WHERE "id" = 'singleton' FOR UPDATE`;
    return fn(tx);
  });
}
