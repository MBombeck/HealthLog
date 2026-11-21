/**
 * Whether a take that band attribution puts on an already-taken slot is
 * another dose or the same one recorded again. Split out of
 * `slot-upsert.ts`; the bulk route reads it for external dose records.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { userDayKey } from "@/lib/tz/format";

/**
 * How far apart two different external dose records may sit and still be one
 * dose entered twice rather than two doses.
 */
export const DOUBLE_ENTRY_TOLERANCE_MS = 60_000;

/**
 * Is `held` (the take a slot already carries) a different dose from the
 * incoming external dose record, both attributed to the same slot by band?
 *
 * Band attribution maps a take to the slot whose band contains it, and a
 * weekly schedule's band reaches a day either side of the slot. Without this
 * check an extra dose logged the day after a Tuesday dose landed on the
 * Tuesday slot and overwrote it last-write-wins: the Tuesday time was
 * replaced and the extra dose existed nowhere (#1221). The rule:
 *
 *   - Nothing taken on the slot yet (pending, skipped): not another dose, the
 *     incoming take is the slot's dose.
 *   - The same external record: the same dose.
 *   - A take on a different local calendar day (the user's zone): another
 *     dose. A slot is one dose a day; the band only reaches across midnight
 *     so a late take still counts for its slot.
 *   - The same local day, and the held take was logged in HealthLog (no
 *     external record): the same dose. A tap at 08:00 and the same dose
 *     recorded in Health at 08:20 converge onto the slot, one dose and one
 *     stock consumption.
 *   - The same local day, two different external records: the record says
 *     which it is. One that names this slot as its scheduled time is the
 *     slot's dose, recorded again: editing a dose in Health replaces it with
 *     a new record (a new UUID, possibly a new time), and that must move the
 *     slot's dose, not add a second one. One without a scheduled time of its
 *     own (Health logs an extra dose as unscheduled, and the phone then sends
 *     its own time) is another dose, unless it sits within
 *     {@link DOUBLE_ENTRY_TOLERANCE_MS} of the held one, which is one dose
 *     entered twice.
 */
export function isAnotherDose(
  held: { takenAt: Date | null; externalId: string | null },
  incoming: {
    takenAt: Date;
    externalId: string | null;
    /** The record's scheduled time is the slot itself. */
    namesSlot: boolean;
  },
  userTz: string,
): boolean {
  if (held.takenAt === null) return false;
  if (held.externalId !== null && held.externalId === incoming.externalId) {
    return false;
  }
  if (
    userDayKey(held.takenAt, userTz) !== userDayKey(incoming.takenAt, userTz)
  ) {
    return true;
  }
  if (held.externalId === null || incoming.externalId === null) return false;
  if (incoming.namesSlot) return false;
  const gap = Math.abs(held.takenAt.getTime() - incoming.takenAt.getTime());
  return gap > DOUBLE_ENTRY_TOLERANCE_MS;
}

/**
 * Does the slot at `canonicalSlot` already carry a recorded take that is a
 * different dose from the incoming one (see {@link isAnotherDose})? The
 * caller records the incoming take as its own unscheduled dose instead of
 * converging onto the slot.
 */
export async function slotHeldByAnotherDose(input: {
  userId: string;
  medicationId: string;
  canonicalSlot: Date;
  takenAt: Date;
  externalId: string | null;
  /** The scheduled time the incoming record carries, if any. */
  scheduledFor: Date | null;
  userTz: string;
  client?: Pick<PrismaClient, "medicationIntakeEvent">;
}): Promise<boolean> {
  const client = input.client ?? defaultPrisma;
  const rows = await client.medicationIntakeEvent.findMany({
    where: {
      userId: input.userId,
      medicationId: input.medicationId,
      scheduledFor: input.canonicalSlot,
      deletedAt: null,
      takenAt: { not: null },
    },
    select: { takenAt: true, externalId: true },
  });
  const namesSlot =
    input.scheduledFor !== null &&
    Math.abs(input.scheduledFor.getTime() - input.canonicalSlot.getTime()) <=
      DOUBLE_ENTRY_TOLERANCE_MS;
  return rows.some((row) =>
    isAnotherDose(
      row,
      {
        takenAt: input.takenAt,
        externalId: input.externalId,
        namesSlot,
      },
      input.userTz,
    ),
  );
}
