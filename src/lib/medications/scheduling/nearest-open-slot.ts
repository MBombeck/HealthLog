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
 *      slot is still open. The binding is USER_PIN, so every reader binds it
 *      by anchor rather than by clock.
 *   2. Repeat. A take within {@link REPEAT_WINDOW_MS} of a take the nearest
 *      slot already holds is the same dose reported twice (a sensor and a
 *      tap, a lid closed and opened again). Nothing is written; the writer
 *      answers with the recorded row and `alreadyTaken: true`. A band slot is
 *      checked by the shared slot write under the slot lock; the nearest-slot
 *      case here. The same window applies to a band slot: bands split the
 *      day between two dose times, so a take far from a band's recorded take
 *      is treated as rule 3.
 *   3. A further dose. A take further from the recorded one is a dose of its
 *      own (the pill box opened at 10:20 for the 13:00 dose after the 08:00
 *      dose was taken at 08:05). It answers the nearest OPEN slot within
 *      reach, so that slot's reminder never asks for the dose again, the way
 *      a double dose happens; with no open slot in reach it is recorded ad
 *      hoc. It is never dropped: a pill box has no screen to warn on.
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
/** How close to a recorded take a second one is the same dose: two hours. */
export const REPEAT_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface NearestSlot {
  slot: Date;
  /** The live row on the slot that carries an outcome, if any. */
  answered: MedicationIntakeEvent | null;
}

/** The real slots within reach of `takenAt` on its local day, nearest first. */
export async function findSlotsNearTake(input: {
  userId: string;
  medicationId: string;
  userTz: string;
  takenAt: Date;
}): Promise<NearestSlot[]> {
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
  if (!medication || medication.schedules.length === 0) return [];
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
  const slots: NearestSlot[] = [];
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
    slots.push({ slot: real, answered });
  }
  return slots;
}

export type TakeResolution =
  | { kind: "slot"; slot: Date; attributionSource: "AUTO" | "USER_PIN" }
  | { kind: "adHoc" }
  | { kind: "alreadyTaken"; row: MedicationIntakeEvent };

/**
 * The binding of a new take that names no slot: the band's slot when it has
 * one, else the nearest slot when it is open; a repeat of the take the
 * nearest slot holds answers `alreadyTaken`, a further dose the nearest open
 * slot, else ad hoc.
 */
export async function resolveNewTake(input: {
  userId: string;
  medicationId: string;
  userTz: string;
  takenAt: Date;
  bandSlot: Date | null;
}): Promise<TakeResolution> {
  const { bandSlot } = input;
  if (bandSlot !== null) {
    // A band slot that holds a take recorded within the repeat window
    // answers `alreadyTaken` in the shared slot write itself, under the slot
    // lock. One whose take lies further back is a further dose (bands split
    // the day between two dose times, so 10:20 still falls in the 08:00
    // band): it goes to the nearest open slot like a take outside every band.
    const held = await prisma.medicationIntakeEvent.findFirst({
      where: {
        userId: input.userId,
        medicationId: input.medicationId,
        scheduledFor: bandSlot,
        deletedAt: null,
        skipped: false,
        takenAt: { not: null },
      },
      select: { takenAt: true },
    });
    if (!held?.takenAt || isRepeatOf(held.takenAt, input.takenAt)) {
      return { kind: "slot", slot: bandSlot, attributionSource: "AUTO" };
    }
    return furtherDose(await findSlotsNearTake(input));
  }
  const slots = await findSlotsNearTake(input);
  const nearest = slots[0];
  if (nearest === undefined) return { kind: "adHoc" };
  if (nearest.answered === null) {
    return { kind: "slot", slot: nearest.slot, attributionSource: "USER_PIN" };
  }
  const recorded = nearest.answered.takenAt;
  if (recorded === null || nearest.answered.skipped) return { kind: "adHoc" };
  if (isRepeatOf(recorded, input.takenAt)) {
    return { kind: "alreadyTaken", row: nearest.answered };
  }
  return furtherDose(slots);
}

function isRepeatOf(recorded: Date, takenAt: Date): boolean {
  return Math.abs(recorded.getTime() - takenAt.getTime()) <= REPEAT_WINDOW_MS;
}

/** A dose of its own: the nearest open slot in reach, else ad hoc. */
function furtherDose(slots: NearestSlot[]): TakeResolution {
  const open = slots.find((s) => s.answered === null);
  return open
    ? { kind: "slot", slot: open.slot, attributionSource: "USER_PIN" }
    : { kind: "adHoc" };
}
