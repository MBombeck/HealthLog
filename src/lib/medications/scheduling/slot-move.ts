/**
 * Writes on one intake row by id, serialised with every other writer of its
 * slot (`slot-lock.ts`).
 *
 * The status and edit routes address a row by id rather than by slot. They
 * used to update it without the slot lock, so a take could land on a row an
 * undo had just tombstoned and report success while the dose was gone. And a
 * slot move refunded and tombstoned the source row before the target write,
 * outside any transaction: a target slot that already held a take answered a
 * no-op the move ignored, so the moved dose vanished with a 200 and its
 * stock refunded, and a failure between the two steps lost the dose too.
 *
 * Both now run inside one transaction holding the slot locks, write only a
 * live row (`deletedAt: null`), and a move onto a taken slot rolls back whole.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isP2002 } from "@/lib/prisma-errors";
import { lockSlot, slotLockKey } from "@/lib/medications/scheduling/slot-lock";
import type { ApplyCanonicalSlotWriteResult } from "@/lib/medications/scheduling/slot-upsert";

type Tx = Prisma.TransactionClient;

interface SlotRef {
  userId: string;
  medicationId: string;
}

/** Why a by-id write did not happen. */
export type RowWriteRefusal = "gone" | "occupied";

class Refused extends Error {
  constructor(readonly reason: RowWriteRefusal) {
    super(reason);
  }
}

async function inLockedTx<T>(
  ref: SlotRef,
  slots: Date[],
  run: (tx: Tx) => Promise<T>,
): Promise<T | RowWriteRefusal> {
  // A fixed order, so two moves in opposite directions cannot deadlock.
  const keys = [
    ...new Set(slots.map((slot) => slotLockKey({ ...ref, slot }))),
  ].sort();
  const attempt = () =>
    prisma.$transaction(async (tx) => {
      for (const key of keys) await lockSlot(tx, key);
      return run(tx);
    });
  try {
    try {
      return await attempt();
    } catch (err) {
      // A row a lock-free writer (the today projector) inserted meanwhile
      // aborted the transaction; the retry finds it.
      if (!isP2002(err)) throw err;
      return await attempt();
    }
  } catch (err) {
    if (err instanceof Refused) return err.reason;
    throw err;
  }
}

/**
 * Update the live row `id` under its slot's lock. `extra` runs in the same
 * transaction after the update. `gone` when the row was tombstoned meanwhile.
 */
export async function updateLiveRow<T>(
  ref: SlotRef & { id: string; slot: Date },
  data: Prisma.MedicationIntakeEventUpdateManyMutationInput,
  extra?: (tx: Tx) => Promise<T>,
) {
  return inLockedTx(ref, [ref.slot], async (tx) => {
    const { count } = await tx.medicationIntakeEvent.updateMany({
      where: { id: ref.id, userId: ref.userId, deletedAt: null },
      data,
    });
    if (count === 0) throw new Refused("gone");
    await extra?.(tx);
    return tx.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: ref.id },
    });
  });
}

/**
 * Move the dose of the live row `id` onto `target`: tombstone it, write the
 * target slot through `write`, then `settle` (stock) in the same
 * transaction. `occupied` when the target slot already holds a take (or the
 * write refused the outcome), and nothing changed; `gone` when the source
 * row was tombstoned meanwhile.
 */
export async function moveRowToSlot<T>(
  ref: SlotRef & { id: string; slot: Date; target: Date },
  write: (tx: Tx) => Promise<ApplyCanonicalSlotWriteResult>,
  settle: (tx: Tx, applied: ApplyCanonicalSlotWriteResult) => Promise<T>,
) {
  return inLockedTx(ref, [ref.slot, ref.target], async (tx) => {
    const { count } = await tx.medicationIntakeEvent.updateMany({
      where: { id: ref.id, userId: ref.userId, deletedAt: null },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });
    if (count === 0) throw new Refused("gone");
    const applied = await write(tx);
    if (applied.alreadyTaken || applied.outcomeChangeRefused) {
      throw new Refused("occupied");
    }
    return settle(tx, applied);
  });
}

export function isRowWriteRefusal(value: unknown): value is RowWriteRefusal {
  return value === "gone" || value === "occupied";
}
