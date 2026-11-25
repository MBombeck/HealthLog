/**
 * Which slots a medication-level snooze holds.
 *
 * `snoozedUntil` lives on the medication row, but a snooze answers ONE dose:
 * the slot whose reminder window was open when it was set, or, set while none
 * was open, the next slot to open. The reminder worker has always scoped it
 * that way; the today list did not, and showed every open slot of the
 * medication as snoozed, so after a morning "skip" in Telegram the evening dose
 * read as snoozed on the phone while the worker reminded it. Both now read the
 * rule from here.
 *
 * `snoozedAt` is the instant the snooze was set, kept in its own row
 * (`MedicationSnooze`) that every snooze write stamps with `snoozedUntil`
 * ({@link snoozeData}). It used to be the medication row's @updatedAt, which
 * every later write to the row moved: a low-stock notice in the afternoon
 * carried a morning snooze over to the afternoon dose. A snooze without a
 * row (one restored from a backup, or running when the row was introduced)
 * reads @updatedAt as before ({@link snoozeAnchor}).
 */
import {
  normaliseDoseWindows,
  resolveSlotPhaseWindow,
  type SlotPhaseWindow,
  type WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";

/**
 * Whether a medication-level snooze holds the reminder of one slot. It
 * holds only while it runs (`now < snoozedUntil`), and only for a slot whose
 * reminder window had opened when the snooze was set, or for the slot the
 * snooze was set ahead of (`heldNextWindowStart`, see
 * {@link nextSlotHeldBySnooze}).
 */
export function snoozeHoldsSlot(
  snoozedUntil: Date | null,
  snoozedAt: Date,
  slotWindowStart: Date,
  now: Date,
  heldNextWindowStart: Date | null = null,
): boolean {
  if (!snoozedUntil || now.getTime() >= snoozedUntil.getTime()) return false;
  if (slotWindowStart.getTime() <= snoozedAt.getTime()) return true;
  return (
    heldNextWindowStart !== null &&
    slotWindowStart.getTime() === heldNextWindowStart.getTime()
  );
}

/**
 * The window start of the slot a snooze was set ahead of, or `null`. A
 * snooze set while one of the medication's reminder windows was open answers
 * that slot, and a later slot stays reminded (a morning "skip" that snoozes
 * to the end of the day must not silence the evening dose). A snooze set
 * while no window was open, such as "remind me later" on a dose that is
 * not due yet, answers the next slot to open, so that one is held too.
 */
export function nextSlotHeldBySnooze(
  windows: ReadonlyArray<{ start: Date; end: Date }>,
  snoozedAt: Date,
): Date | null {
  const at = snoozedAt.getTime();
  let next: Date | null = null;
  for (const window of windows) {
    const start = window.start.getTime();
    if (start <= at && at <= window.end.getTime()) return null;
    if (start > at && (next === null || start < next.getTime())) {
      next = window.start;
    }
  }
  return next;
}

type SnoozeSchedule = Pick<
  WorkerScheduleRow,
  "windowStart" | "windowEnd" | "timesOfDay" | "reminderGraceMinutes"
> & { doseWindows?: unknown };

function hhmm(at: Date, tz: string): string {
  const p = wallClockInTz(at, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** The reminder window of the slot at `slotInstant`, as the worker mints it. */
function slotReminderWindow(
  schedules: readonly SnoozeSchedule[],
  slotInstant: Date,
  tz: string,
): SlotPhaseWindow {
  const slotTime = hhmm(slotInstant, tz);
  const schedule = schedules.find((s) =>
    s.timesOfDay.length > 0
      ? s.timesOfDay.includes(slotTime)
      : s.windowStart === slotTime,
  );
  if (!schedule) return { start: slotInstant, end: slotInstant };
  return resolveSlotPhaseWindow(
    schedule,
    slotTime,
    normaliseDoseWindows(schedule.doseWindows),
    slotInstant,
    tz,
  );
}

/**
 * The slot instants among `slotInstants` that a running snooze holds, by the
 * worker's rule. Empty when no snooze runs.
 */
export function slotsHeldBySnooze(input: {
  snoozedUntil: Date | null;
  snoozedAt: Date;
  schedules: readonly SnoozeSchedule[];
  slotInstants: readonly Date[];
  tz: string;
  now: Date;
}): Set<number> {
  const held = new Set<number>();
  const { snoozedUntil, snoozedAt, now } = input;
  if (!snoozedUntil || now.getTime() >= snoozedUntil.getTime()) return held;
  const windows = input.slotInstants.map((at) => ({
    at,
    window: slotReminderWindow(input.schedules, at, input.tz),
  }));
  const next = nextSlotHeldBySnooze(
    windows.map((w) => w.window),
    snoozedAt,
  );
  for (const { at, window } of windows) {
    if (snoozeHoldsSlot(snoozedUntil, snoozedAt, window.start, now, next)) {
      held.add(at.getTime());
    }
  }
  return held;
}

/**
 * The medication `data` of a snooze write: `snoozedUntil`, and the instant
 * the snooze was set in its own row, which no other write to the medication
 * moves.
 */
export function snoozeData(until: Date, now: Date = new Date()) {
  return {
    snoozedUntil: until,
    snooze: {
      upsert: { create: { snoozedAt: now }, update: { snoozedAt: now } },
    },
  };
}

/** What a medication read includes for {@link snoozeAnchor}. */
export const SNOOZE_ANCHOR_INCLUDE = {
  snooze: { select: { snoozedAt: true } },
} as const;

/**
 * When the medication's snooze was set. A snooze with no recorded instant
 * reads the medication's `updatedAt`, the reading from before the instant was
 * kept.
 */
export function snoozeAnchor(medication: {
  updatedAt: Date;
  snooze?: { snoozedAt: Date } | null;
}): Date {
  return medication.snooze?.snoozedAt ?? medication.updatedAt;
}

/**
 * `medications` with the snooze record {@link snoozeAnchor} reads, for a
 * read that does not include it: one statement, and none while no snooze
 * runs (the navigation count, read on every page).
 */
export async function withSnoozeRecords<
  T extends { id: string; snoozedUntil: Date | null },
>(
  medications: readonly T[],
  now: Date,
): Promise<Array<T & { snooze: { snoozedAt: Date } | null }>> {
  const running = medications
    .filter((m) => m.snoozedUntil !== null && now < m.snoozedUntil)
    .map((m) => m.id);
  const rows =
    running.length === 0
      ? []
      : await prisma.medicationSnooze.findMany({
          where: { medicationId: { in: running } },
          select: { medicationId: true, snoozedAt: true },
        });
  const byId = new Map(rows.map((r) => [r.medicationId, r]));
  return medications.map((m) => ({ ...m, snooze: byId.get(m.id) ?? null }));
}
