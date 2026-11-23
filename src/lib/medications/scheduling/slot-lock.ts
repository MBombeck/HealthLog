/**
 * One slot, one writer at a time.
 *
 * Every take, skip and undo of a scheduled dose ends on one row per slot
 * (`userId`, `medicationId`, `scheduledFor`). Without a lock two writers
 * could both read the slot and both act on what they read: a pill box and a
 * Telegram tap each inserted a row, a take that read the slot before an undo
 * committed wrote onto the tombstone and reported success while the dose was
 * gone. Each such write now runs inside one transaction holding a
 * transaction-scoped advisory lock on the slot, and re-reads the slot under
 * it.
 *
 * A caller that is already inside a transaction passes its transaction
 * client and the lock joins it. A caller holding the root client gets a
 * transaction of its own; a unique violation inside it (a row a writer that
 * takes no lock, such as the today projector, inserted meanwhile) aborts the
 * transaction, so the whole write is retried once and then finds that row.
 */
import { Prisma } from "@/generated/prisma/client";
import { isP2002 } from "@/lib/prisma-errors";

interface LockableClient {
  $queryRaw?: (query: Prisma.Sql) => Promise<unknown>;
  $transaction?: unknown;
}

export function slotLockKey(input: {
  userId: string;
  medicationId: string;
  slot: Date;
}): string {
  return `intake-slot|${input.userId}|${input.medicationId}|${input.slot.toISOString()}`;
}

/** Take the slot's advisory lock inside the caller's transaction. */
export async function lockSlot(client: unknown, key: string): Promise<void> {
  const c = client as LockableClient;
  if (typeof c.$queryRaw !== "function") return;
  await c.$queryRaw(
    Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) AS lock`,
  );
}

/**
 * Run `write` holding the slot's lock: in a fresh transaction when `client`
 * is the root client, else in the caller's.
 */
export async function withSlotLock<C, T>(
  client: C,
  key: string,
  write: (tx: C) => Promise<T>,
): Promise<T> {
  const root = client as LockableClient & {
    $transaction?: (fn: (tx: C) => Promise<T>) => Promise<T>;
  };
  if (typeof root.$transaction !== "function") {
    await lockSlot(client, key);
    return write(client);
  }
  const run = () =>
    root.$transaction!(async (tx) => {
      await lockSlot(tx, key);
      return write(tx);
    });
  try {
    return await run();
  } catch (err) {
    if (!isP2002(err)) throw err;
    return run();
  }
}
