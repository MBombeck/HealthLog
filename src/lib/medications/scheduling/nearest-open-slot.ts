/**
 * Which scheduled dose a take answers when the band alone cannot say, and
 * whether a take repeats a dose already recorded.
 *
 * Band attribution binds a take to the slot whose window holds its time. A
 * take outside every window (a pill box opened after the morning dose's
 * window closed, a dose taken five hours late) used to land ad hoc: the slot
 * stayed open, the reminder kept firing and the phone kept asking for a dose
 * already taken, which is how a double dose happens. For the writes that
 * record a NEW take without naming a slot (the ingest hook and the
 * per-medication route) the take is settled like this:
 *
 *   1. Overdue first. The take answers the most recent dose of its local day
 *      at or before it that is still open: a dose taken late is that dose.
 *   2. Then the next dose. With no earlier dose open, it answers the next
 *      open dose ahead of it within {@link TAKE_AHEAD_REACH_MS} (six hours):
 *      the pill box opened at 18:30 for the 21:00 dose after the morning dose
 *      was taken. An earlier open dose always wins: a take at 15:00 used to
 *      settle the 21:00 dose because it sat a few seconds nearer to it than
 *      to the overdue 09:00 dose, and the evening reminder and Live Activity
 *      never came although the person had not taken that pill.
 *   3. Repeat. A take within {@link REPEAT_WINDOW_MS} of a take one of those
 *      doses already holds is the same dose reported twice (a sensor and a
 *      tap, a lid closed and opened again). Nothing is written; the writer
 *      answers with the recorded row and `alreadyTaken: true`. A band slot is
 *      checked by the shared slot write under the slot lock; the other doses
 *      here. The same window applies to a band slot: bands split the day
 *      between two dose times, so a take far from a band's recorded take is
 *      a further dose and follows rules 1 and 2.
 *
 * A take no rule answers is recorded ad hoc, as an extra dose. It is never
 * dropped: a pill box has no screen to warn on. A dose bound by rule 1 or 2
 * is recorded USER_PIN, so every reader binds it by anchor rather than by
 * clock.
 *
 * Slots are the medication's live rows on that day whose anchor is a real
 * slot of its schedule; today's are projected first so a slot nobody has
 * opened yet still counts. An as-needed medication has no slots, so the
 * rules are inert for it.
 */
import type { MedicationIntakeEvent } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { projectTodayIntakesAndRecompute } from "@/lib/medications/scheduling/project-today-intakes";
import { resolveForcedSlotForWrite } from "@/lib/medications/scheduling/slot-upsert";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import { NEAR_SLOT_CEILING_MINUTES } from "@/lib/medications/dose-state/take-rule";
import {
  holdsAnswer,
  holdsTake,
} from "@/lib/medications/scheduling/holds-take";

/**
 * How far ahead of a dose a take that names no slot may still settle it, when
 * no earlier dose of the day is open: six hours, the same constant the web's
 * take controls measure by (`NEAR_SLOT_CEILING_MINUTES`).
 */
export const TAKE_AHEAD_REACH_MS = NEAR_SLOT_CEILING_MINUTES * 60 * 1000;
/** How close to a recorded take a second one is the same dose: two hours. */
export const REPEAT_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface NearestSlot {
  slot: Date;
  /** The live row on the slot that carries an outcome, if any. */
  answered: MedicationIntakeEvent | null;
}

/**
 * The real slots a take may answer: those of its local day at or before it,
 * most recent first, then those at most {@link TAKE_AHEAD_REACH_MS} after it,
 * nearest first.
 */
export async function findSlotsForTake(input: {
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
  const t = takenAt.getTime();
  const rows = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      medicationId,
      deletedAt: null,
      scheduledFor: {
        gte: day.start,
        lte: new Date(Math.min(day.end.getTime(), t + TAKE_AHEAD_REACH_MS)),
      },
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const byInstant = new Map<number, MedicationIntakeEvent[]>();
  for (const row of rows) {
    const key = row.scheduledFor.getTime();
    if (key > t + TAKE_AHEAD_REACH_MS) continue;
    byInstant.set(key, [...(byInstant.get(key) ?? []), row]);
  }
  const keys = [...byInstant.keys()];
  const instants = [
    ...keys.filter((k) => k <= t).sort((a, b) => b - a),
    ...keys.filter((k) => k > t).sort((a, b) => a - b),
  ];
  const slots: NearestSlot[] = [];
  for (const instant of instants) {
    const real = await resolveForcedSlotForWrite({
      userId,
      medicationId,
      userTz,
      slotInstant: new Date(instant),
    });
    if (real === null || real.getTime() !== instant) continue;
    // An outcome the server recorded on its own (auto-miss, auto-skip, an
    // automatic take) leaves the slot open: a real take replaces it.
    const answered = byInstant.get(instant)?.find(holdsAnswer) ?? null;
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
 * one and the take is not a further dose; else a repeat of a take a slot
 * already holds answers `alreadyTaken`, and otherwise the most recent open
 * slot at or before the take, an open slot already takeable ahead of it, or
 * ad hoc.
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
    // band): it goes to an open slot like a take outside every band.
    // Only a take the person recorded counts (`holdsTake`): an automatic
    // one is replaced by the slot write, never repeated.
    const held = await prisma.medicationIntakeEvent.findFirst({
      where: {
        userId: input.userId,
        medicationId: input.medicationId,
        scheduledFor: bandSlot,
        deletedAt: null,
        skipped: false,
        takenAt: { not: null },
      },
      select: {
        takenAt: true,
        skipped: true,
        autoMissed: true,
        autoRecorded: true,
      },
    });
    if (!held || !holdsTake(held) || isRepeatOf(held.takenAt!, input.takenAt)) {
      return { kind: "slot", slot: bandSlot, attributionSource: "AUTO" };
    }
    return firstOpen(await findSlotsForTake(input));
  }
  const slots = await findSlotsForTake(input);
  const repeat = slots.find(
    (s) =>
      s.answered !== null &&
      holdsTake(s.answered) &&
      isRepeatOf(s.answered.takenAt as Date, input.takenAt),
  );
  if (repeat?.answered) return { kind: "alreadyTaken", row: repeat.answered };
  return firstOpen(slots);
}

function isRepeatOf(recorded: Date, takenAt: Date): boolean {
  return Math.abs(recorded.getTime() - takenAt.getTime()) <= REPEAT_WINDOW_MS;
}

/** The first open slot in the order {@link findSlotsForTake} gives, else ad hoc. */
function firstOpen(slots: NearestSlot[]): TakeResolution {
  const open = slots.find((s) => s.answered === null);
  return open
    ? { kind: "slot", slot: open.slot, attributionSource: "USER_PIN" }
    : { kind: "adHoc" };
}
