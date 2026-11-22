/**
 * The pin-conflict probe of the USER_PIN write paths (the bulk route, the
 * per-medication route, the event edit), with the wire form its refusals
 * answer: the slot and the take that holds it.
 */
import { prisma as defaultPrisma } from "@/lib/db";
import { findSlotRows, type SlotIntakeRow } from "./slot-upsert";

type PrismaLike = Parameters<typeof findSlotRows>[0];

interface PinConflictInput {
  userId: string;
  medicationId: string;
  /** The validated canonical slot anchor the pin targets. */
  canonicalSlot: Date;
  /** The incoming row's takenAt (null for a skip-shaped edit). */
  incomingTakenAt: Date | null;
  /** The event being edited (PUT path) — never conflicts with itself. */
  excludeEventId?: string;
  client?: PrismaLike;
}

/** What an occupied pin answers with: the slot and what holds it. */
interface PinConflict {
  slotInstant: Date;
  /** The take that holds the slot; null when a skip holds it. */
  takenAt: Date | null;
  takenVia: SlotIntakeRow["takenVia"];
}

/**
 * The pin-conflict probe of the USER_PIN write paths. A pin moves a
 * DIFFERENT take onto a named slot; converging it onto a slot whose live
 * row is already actioned (taken or explicitly skipped) would overwrite
 * that recorded action through the explicit-write last-write-wins rule —
 * a silent loss of a dose record. The read ledger only offers the pin for
 * UNSERVED slots (`nearestSlot.filled` gates the kebab action), so a
 * conflict here means a stale client or a hand-rolled API call: the route
 * refuses it with 422 `medications.intake.force_slot.occupied`.
 *
 * Not a conflict:
 *   - a pending projection row at the slot (that is the normal target the
 *     pin converges onto);
 *   - the row being edited itself (`excludeEventId` on the PUT path);
 *   - an actioned row whose `takenAt` equals the incoming instant — that
 *     is an idempotent re-post of the same pinned dose.
 *
 * Returns the recorded action the pin would overwrite, so the refusal can say
 * when and how the slot was answered, the way an `alreadyTaken` does; null
 * when the pin is free.
 */
export async function findPinConflictRow(
  input: PinConflictInput,
): Promise<PinConflict | null> {
  const client = input.client ?? defaultPrisma;
  const rows = await findSlotRows(
    client,
    input.userId,
    input.medicationId,
    input.canonicalSlot,
  );
  const held = rows.find((row) => {
    if (input.excludeEventId && row.id === input.excludeEventId) return false;
    const actioned = row.takenAt !== null || row.skipped;
    if (!actioned) return false;
    const sameTake =
      input.incomingTakenAt !== null &&
      row.takenAt !== null &&
      row.takenAt.getTime() === input.incomingTakenAt.getTime();
    return !sameTake;
  });
  if (!held) return null;
  return {
    slotInstant: input.canonicalSlot,
    takenAt: held.skipped ? null : held.takenAt,
    takenVia: held.skipped ? null : (held.takenVia ?? null),
  };
}

/** The wire form of an occupied pin, for a 422 `meta` or a bulk entry. */
export function pinConflictWire(conflict: PinConflict) {
  return {
    slotInstant: conflict.slotInstant.toISOString(),
    takenAt: conflict.takenAt?.toISOString() ?? null,
    takenVia: conflict.takenVia,
  };
}
