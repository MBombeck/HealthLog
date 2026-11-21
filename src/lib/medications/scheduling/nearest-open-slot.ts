/**
 * Which scheduled dose a take answers when the band alone cannot say, and
 * whether a take repeats a dose already recorded.
 *
 * Band attribution binds a take to the slot whose window holds its time. A
 * take outside every window (a pill box opened an hour and a half early, a
 * dose taken five hours late) used to land ad hoc: the slot stayed open, the
 * reminder kept firing and the phone kept asking for a dose already taken,
 * which is how a double dose happens. Two rules close that, for the writes
 * that record a NEW take without naming a slot (the ingest hook and the
 * per-medication route):
 *
 *   1. Nearest slot. The take answers the slot nearest to it on the same
 *      local day, within {@link NEAREST_SLOT_REACH_MS} either side, when that
 *      slot is still open. When the nearest slot is already answered the take
 *      does not reach past it to a further one: a second morning dose never
 *      consumes the evening slot. The binding is USER_PIN, so every reader
 *      binds it by anchor rather than by clock.
 *   2. Repeat. A take of a slot that already holds a take is the same dose
 *      reported twice (a sensor and a tap, a tap on two devices). Nothing is
 *      written; the writer answers with the recorded row and
 *      `alreadyTaken: true`. A band slot is checked by the shared slot write
 *      under the slot lock; the nearest-slot case here.
 *
 * Slots are the medication's live rows on that day whose anchor is a real
 * slot of its schedule; today's are projected first so a slot nobody has
 * opened yet still counts. An as-needed medication has no slots, so both
 * rules are inert for it.
 */
import type { MedicationIntakeEvent } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { projectTodayIntakesAndRecompute } from "@/lib/medications/scheduling/project-today-intakes";
import { resolveForcedSlotForWrite } from "@/lib/medications/scheduling/slot-upsert";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

/** How far from its slot a take still answers it: six hours either side. */
export const NEAREST_SLOT_REACH_MS = 6 * 60 * 60 * 1000;

export interface NearestSlot {
  slot: Date;
  /** The live row on the slot that carries an outcome, if any. */
  answered: MedicationIntakeEvent | null;
}

/** The slot nearest to `takenAt` on its local day, within reach, or null. */
export async function findNearestSlot(input: {
  userId: string;
  medicationId: string;
  userTz: string;
  takenAt: Date;
}): Promise<NearestSlot | null> {
  const { userId, medicationId, userTz, takenAt } = input;
  // An as-needed, record-only or schedule-less medication has no slot.
  const medication = await prisma.medication.findFirst({
    where: {
      id: medicationId,
      userId,
      asNeeded: false,
      ...TRACKED_INTAKE_WHERE,
    },
    select: { schedules: { select: { id: true }, take: 1 } },
  });
  if (!medication || medication.schedules.length === 0) return null;
  const day = getUserTodayBounds(takenAt, userTz);
  const today = getUserTodayBounds(new Date(), userTz);
  if (day.start.getTime() === today.start.getTime()) {
    await projectTodayIntakesAndRecompute({
      userId,
      userTz,
      todayStart: today.start,
      todayEnd: new Date(today.end.getTime() + 1),
    });
  }
  const rows = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      medicationId,
      deletedAt: null,
      scheduledFor: {
        gte: new Date(
          Math.max(
            day.start.getTime(),
            takenAt.getTime() - NEAREST_SLOT_REACH_MS,
          ),
        ),
        lte: new Date(
          Math.min(
            day.end.getTime(),
            takenAt.getTime() + NEAREST_SLOT_REACH_MS,
          ),
        ),
      },
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const byInstant = new Map<number, MedicationIntakeEvent[]>();
  for (const row of rows) {
    const key = row.scheduledFor.getTime();
    if (Math.abs(key - takenAt.getTime()) > NEAREST_SLOT_REACH_MS) continue;
    byInstant.set(key, [...(byInstant.get(key) ?? []), row]);
  }
  const instants = [...byInstant.keys()].sort(
    (a, b) => Math.abs(a - takenAt.getTime()) - Math.abs(b - takenAt.getTime()),
  );
  for (const instant of instants) {
    const real = await resolveForcedSlotForWrite({
      userId,
      medicationId,
      userTz,
      slotInstant: new Date(instant),
    });
    if (real === null || real.getTime() !== instant) continue;
    const answered =
      byInstant.get(instant)?.find((r) => r.takenAt !== null || r.skipped) ??
      null;
    return { slot: real, answered };
  }
  return null;
}

export type TakeResolution =
  | { kind: "slot"; slot: Date; attributionSource: "AUTO" | "USER_PIN" }
  | { kind: "adHoc" }
  | { kind: "alreadyTaken"; row: MedicationIntakeEvent };

/**
 * The binding of a new take that names no slot: the band's slot when it has
 * one, else the nearest open slot, else ad hoc; a repeat of a recorded take
 * on the slot it would bind to answers `alreadyTaken`.
 */
export async function resolveNewTake(input: {
  userId: string;
  medicationId: string;
  userTz: string;
  takenAt: Date;
  bandSlot: Date | null;
}): Promise<TakeResolution> {
  const { bandSlot } = input;
  // A band slot that already holds a take answers `alreadyTaken` in the
  // shared slot write itself, under the slot lock.
  if (bandSlot !== null) {
    return { kind: "slot", slot: bandSlot, attributionSource: "AUTO" };
  }
  const nearest = await findNearestSlot(input);
  if (nearest === null) return { kind: "adHoc" };
  if (nearest.answered === null) {
    return { kind: "slot", slot: nearest.slot, attributionSource: "USER_PIN" };
  }
  if (nearest.answered.takenAt !== null && !nearest.answered.skipped) {
    return { kind: "alreadyTaken", row: nearest.answered };
  }
  return { kind: "adHoc" };
}
