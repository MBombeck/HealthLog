/**
 * v1.42.2 — the pure rules of auto-mark-taken that both the auto-take job
 * and the read paths (the medication card's next due, the dashboard, the
 * assistant tools) apply, so the card shows the slot the job will record.
 *
 *   - `autoTakeFloor`: the earliest slot the job may record.
 *   - `decideSlot`: what the job does with one slot given its rows.
 *   - `autoTakeRollingAnchor`: where a rolling cadence stands for an
 *     auto-taken medication. The engine yields only `lastIntakeAt + N`; a
 *     slot the job will never record (before the floor, inside a pause era,
 *     skipped, auto-missed, or removed by the person) would otherwise hold
 *     the cadence still forever. The anchor steps forward by N past every
 *     such slot, keeping the rhythm, and is fed back to the engine as the
 *     effective `lastIntakeAt`.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { MEDICATION_WINDOW_SELECT } from "@/lib/medications/course-window";

import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import {
  advanceRollingOccurrence,
  nextOccurrenceAfter,
  rollingIntakeAnchorFor,
  type Occurrence,
} from "@/lib/medications/scheduling/recurrence";
import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  type WorkerMedicationRow,
  type WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back one pass catches up on slots it has not filled yet. */
export const INTAKE_AUTO_TAKE_LOOKBACK_MS = 7 * DAY_MS;

/**
 * Upper bound on single steps past handled rolling slots. Slots before the
 * floor are crossed in one stride; only slots inside the catch-up window are
 * stepped one by one, and there are at most a handful.
 */
const MAX_ROLLING_STEPS = 64;

/** The slot floor for one medication: see `intake-auto-take.ts`. */
export function autoTakeFloor(input: {
  autoMarkTakenSince: Date;
  createdAt: Date;
  now: Date;
}): Date {
  return new Date(
    Math.max(
      input.autoMarkTakenSince.getTime(),
      input.createdAt.getTime(),
      input.now.getTime() - INTAKE_AUTO_TAKE_LOOKBACK_MS,
    ),
  );
}

/** True when `at` falls inside a `[pausedAt, resumedAt ?? now)` pause era. */
export function isInPauseEra(
  at: Date,
  eras: readonly { pausedAt: Date; resumedAt: Date | null }[],
  now: Date,
): boolean {
  const t = at.getTime();
  return eras.some(
    (era) =>
      t >= era.pausedAt.getTime() && t < (era.resumedAt ?? now).getTime(),
  );
}

/** One slot row as the occupancy check reads it. */
export interface SlotRow {
  id: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  autoMissed: boolean;
  deletedAt: Date | null;
  /** `USER_PIN` when the person bound the row to its `scheduledFor`. */
  attributionSource?: "AUTO" | "USER_PIN";
}

export type SlotDecision =
  | { kind: "create" }
  | { kind: "convert"; rowId: string }
  | {
      kind: "leave";
      reason: "actioned" | "removed" | "taken_nearby";
    };

/**
 * Decide what the pass does with one slot, given every row of the
 * medication around it (live and tombstoned). Pure, so the precedence rules
 * are tested without a database.
 *
 * `band` is the slot's attribution band when the cadence has one (a take
 * anywhere inside it belongs to this slot); `null` for a rolling slot, whose
 * next occurrence is by definition later than every taken dose.
 *
 * Only a take that belongs to no other slot claims this one from inside its
 * band. A take whose `scheduledFor` is another expected slot (`otherSlots`),
 * or that the person pinned to an instant other than this slot, is that
 * slot's dose however close its `takenAt` lies: the morning dose taken in
 * the evening is still the morning dose, and the evening one stays due.
 */
export function decideSlot(
  slotAt: Date,
  rows: readonly SlotRow[],
  band: Pick<SlotBand, "earlyStart" | "overdueEnd"> | null,
  otherSlots: ReadonlySet<number> = new Set(),
): SlotDecision {
  const t = slotAt.getTime();
  const onSlot = rows.filter((r) => r.scheduledFor.getTime() === t);
  const liveOnSlot = onSlot.filter((r) => r.deletedAt === null);

  if (liveOnSlot.some((r) => r.takenAt !== null || r.skipped || r.autoMissed)) {
    return { kind: "leave", reason: "actioned" };
  }
  if (liveOnSlot.length === 0 && onSlot.length > 0) {
    return { kind: "leave", reason: "removed" };
  }
  if (band) {
    const from = band.earlyStart.getTime();
    const to = band.overdueEnd.getTime();
    const takenNearby = rows.some(
      (r) =>
        r.deletedAt === null &&
        !r.skipped &&
        r.takenAt !== null &&
        r.takenAt.getTime() >= from &&
        r.takenAt.getTime() <= to &&
        !belongsElsewhere(r, t, otherSlots),
    );
    if (takenNearby) return { kind: "leave", reason: "taken_nearby" };
  }
  const pending = [...liveOnSlot].sort(
    (a, b) => a.id.localeCompare(b.id), // deterministic pick on duplicates
  )[0];
  return pending ? { kind: "convert", rowId: pending.id } : { kind: "create" };
}

/** True when a row is attributed to a slot other than the one at `slotMs`. */
function belongsElsewhere(
  row: SlotRow,
  slotMs: number,
  otherSlots: ReadonlySet<number>,
): boolean {
  const at = row.scheduledFor.getTime();
  if (at === slotMs) return false;
  return row.attributionSource === "USER_PIN" || otherSlots.has(at);
}

export interface AutoTakeRollingMedication extends WorkerMedicationRow {
  schedules: WorkerScheduleRow[];
  pauseEras: { pausedAt: Date; resumedAt: Date | null }[];
}

/**
 * The effective `lastIntakeAt` for a rolling cadence under auto-take: the
 * real one when its next slot is one the job will record, otherwise an
 * anchor stepped forward by N past every slot it will not record. `null`
 * input stays `null` only when the course-start slot is recordable.
 *
 * A slot is passed over when it lies before `floor` (the option is never
 * applied to history before it was switched on, and the catch-up window is
 * bounded), inside a pause era, or, for a slot whose time has come, when the
 * person already handled it: skipped, auto-missed, taken, or removed.
 *
 * Returns the input unchanged for a medication without a rolling schedule.
 * When the course ends before a recordable slot, returns the last passed
 * slot as the anchor, so the engine yields nothing.
 */
export function autoTakeRollingAnchor(input: {
  medication: AutoTakeRollingMedication;
  userTz: string;
  floor: Date;
  now: Date;
  lastIntakeAt: Date | null;
  rows: readonly SlotRow[];
}): Date | null {
  const { medication, userTz, floor, now, rows } = input;
  const scheduleRow = medication.schedules.find(
    (s) => s.rollingIntervalDays !== null && s.rollingIntervalDays > 0,
  );
  if (!scheduleRow || medication.oneShot) return input.lastIntakeAt;
  const schedule = buildCanonicalSchedule(scheduleRow);
  const n = schedule.rollingIntervalDays!;
  const ctx = buildRecurrenceContext({
    medication,
    userTz,
    lastIntakeAt: input.lastIntakeAt,
  });

  // The engine's identity: `lastIntakeAt + N`, or the course start.
  let occ: Occurrence | null = nextOccurrenceAfter(schedule, floor, ctx);
  if (!occ) return input.lastIntakeAt;
  let last: Occurrence | null = null;

  // Cross a long stretch before the floor in one stride, stopping one
  // interval short so the single steps below land on the first slot at or
  // after the floor, whatever DST did to the hours in between.
  const strides = Math.floor(
    (floor.getTime() - occ.at.getTime()) / (n * DAY_MS),
  );
  if (strides >= 2) {
    last = occ;
    occ = advanceRollingOccurrence(
      { ...schedule, rollingIntervalDays: (strides - 1) * n },
      occ,
      ctx,
    );
  }

  const passOver = (at: Date): boolean => {
    if (at.getTime() < floor.getTime()) return true;
    if (isInPauseEra(at, medication.pauseEras, now)) return true;
    if (at.getTime() > now.getTime()) return false;
    return decideSlot(at, rows, null).kind === "leave";
  };

  let stepped = last !== null;
  for (let step = 0; occ && step < MAX_ROLLING_STEPS; step++) {
    if (!passOver(occ.at)) break;
    last = occ;
    stepped = true;
    occ = advanceRollingOccurrence(schedule, occ, ctx);
  }
  if (!stepped) return input.lastIntakeAt;
  if (occ === null) return last!.at;
  return rollingIntakeAnchorFor(schedule, occ, ctx) ?? input.lastIntakeAt;
}

/**
 * The row window the job reads around one medication, and the read paths
 * read for the same purpose: every row (tombstones included) whose slot or
 * take falls within a day of `[floor, now]`.
 */
export function autoTakeRowWindow(floor: Date, now: Date) {
  const gte = new Date(floor.getTime() - DAY_MS);
  const lte = new Date(now.getTime() + DAY_MS);
  return {
    OR: [{ scheduledFor: { gte, lte } }, { takenAt: { gte, lte } }],
  };
}

/**
 * The medications the auto-take job works on (see `intake-auto-take.ts`),
 * apart from the intake-tracking switch, which each caller spreads itself
 * (`TRACKED_INTAKE_WHERE`) so the structural guard sees every reader ask.
 */
export function autoTakeEligibleWhere(now: Date) {
  return {
    autoMarkTaken: true,
    autoMarkTakenSince: { not: null, lte: now },
    active: true,
    pausedAt: null,
    asNeeded: false,
  };
}

/**
 * True when an edit to a medication's window reopens time before now: the
 * start moves earlier (or goes), or the end moves later (or goes). Dates are
 * calendar days, compared as stored.
 */
export function windowWidens(
  before: { startsOn: Date | null; endsOn: Date | null },
  after: { startsOn: Date | null; endsOn: Date | null },
): boolean {
  const startsEarlier =
    before.startsOn !== null &&
    (after.startsOn === null ||
      after.startsOn.getTime() < before.startsOn.getTime());
  const endsLater =
    before.endsOn !== null &&
    (after.endsOn === null || after.endsOn.getTime() > before.endsOn.getTime());
  return startsEarlier || endsLater;
}

/**
 * Move an auto-taken medication's floor to now when it lies before now.
 * Called wherever an edit reopens past slots (a wider window, a medication
 * made active again): the option was on, but the person never had those
 * days as due, so the pass must not fill them as taken. A no-op on a
 * medication without the option.
 */
export interface AutoTakeFloorClient {
  medication: {
    updateMany(args: {
      where: {
        id: string;
        autoMarkTaken: true;
        autoMarkTakenSince: { lt: Date };
      };
      data: { autoMarkTakenSince: Date };
    }): Promise<{ count: number }>;
  };
}

export async function moveAutoTakeFloorToNow(
  client: AutoTakeFloorClient,
  medicationId: string,
  now: Date = new Date(),
): Promise<void> {
  await client.medication.updateMany({
    where: {
      id: medicationId,
      autoMarkTaken: true,
      autoMarkTakenSince: { lt: now },
    },
    data: { autoMarkTakenSince: now },
  });
}

const ROLLING_SCHEDULE_SELECT = {
  id: true,
  windowStart: true,
  windowEnd: true,
  daysOfWeek: true,
  timesOfDay: true,
  reminderGraceMinutes: true,
  rrule: true,
  rollingIntervalDays: true,
  scheduleType: true,
  cyclicOnWeeks: true,
  cyclicOffWeeks: true,
  doseWindows: true,
} as const;

/**
 * For the read paths: resolves the `lastIntakeAt` to hand the engine for
 * each medication. An auto-taken rolling medication among `medicationIds`
 * gets its stepped anchor; every other one its real last intake. At most
 * one medication query and one row query, and none when `medicationIds` is
 * empty.
 */
export async function loadAutoTakeRollingAnchors(
  prisma: Pick<PrismaClient, "medication" | "medicationIntakeEvent">,
  input: {
    userId: string;
    medicationIds: readonly string[];
    now: Date;
    userTz: string;
    lastIntakeAt: (medicationId: string) => Date | null;
  },
): Promise<(medicationId: string) => Date | null> {
  const out = new Map<string, Date | null>();
  const resolve = (id: string) =>
    out.has(id) ? (out.get(id) ?? null) : input.lastIntakeAt(id);
  if (input.medicationIds.length === 0) return resolve;
  const { now } = input;
  const medications = await prisma.medication.findMany({
    where: {
      userId: input.userId,
      id: { in: [...input.medicationIds] },
      ...autoTakeEligibleWhere(now),
      ...TRACKED_INTAKE_WHERE,
      schedules: { some: { rollingIntervalDays: { not: null } } },
    },
    select: {
      id: true,
      ...MEDICATION_WINDOW_SELECT,
      oneShot: true,
      createdAt: true,
      autoMarkTakenSince: true,
      schedules: { select: ROLLING_SCHEDULE_SELECT },
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
  });
  if (medications.length === 0) return resolve;

  const floors = new Map<string, Date>();
  let earliest = now;
  for (const m of medications) {
    const floor = autoTakeFloor({
      autoMarkTakenSince: m.autoMarkTakenSince!,
      createdAt: m.createdAt,
      now,
    });
    floors.set(m.id, floor);
    if (floor.getTime() < earliest.getTime()) earliest = floor;
  }
  const rows = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId: input.userId,
      medicationId: { in: medications.map((m) => m.id) },
      ...autoTakeRowWindow(earliest, now),
    },
    select: {
      id: true,
      medicationId: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
      autoMissed: true,
      deletedAt: true,
    },
  });

  for (const m of medications) {
    const anchor = autoTakeRollingAnchor({
      medication: m as AutoTakeRollingMedication,
      userTz: input.userTz,
      floor: floors.get(m.id)!,
      now,
      lastIntakeAt: input.lastIntakeAt(m.id),
      rows: rows.filter((r) => r.medicationId === m.id),
    });
    out.set(m.id, anchor);
  }
  return resolve;
}
