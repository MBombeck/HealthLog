import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Run a read-merge-write on one account row under a row lock.
 *
 * Several settings live as JSON documents on the `User` row, and a write
 * that sets one field of such a document reads what is stored, merges the
 * field in and writes the whole document back. Two such writes that overlap
 * (two tabs, a tab and the phone, a guardian and the profile's own session)
 * both read the same document, and the second write drops the first one's
 * field. `FOR UPDATE` queues every writer for the account behind the one
 * holding the row, and a read made after the lock is granted sees the previous
 * writer's commit.
 *
 * Every write to the row inside `fn` must go through `tx`: a write through
 * the global client would wait for the lock this transaction holds. A read
 * through the global client is safe (it does not wait for the lock, and it
 * sees every write committed before the lock was granted), so a helper that
 * only reads the stored document need not take `tx`.
 */
export async function lockUserRow(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
}

/** `lockUserRow` in a transaction of its own, around `fn`. */
export function withUserRowLock<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockUserRow(tx, userId);
    return fn(tx);
  });
}
