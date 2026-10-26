/**
 * What a medication edit checks before anything is written: the stored
 * pre-image, the record-only rule, the category, the as-needed and one-shot
 * shapes, the primary-schedule grace bridge and the course window. Each
 * refusal leaves the medication as it was.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  checkCurrentWindow,
  courseRefusalResponse,
} from "@/lib/medications/courses";
import type { MedicationEdit } from "./schedule-normalise";

/** A refusal the route answers with `apiError(message, status, meta)`. */
export interface MedicationEditRefusal {
  ok: false;
  message: string;
  status: number;
  meta?: { errorCode: string };
}

const EDIT_SELECT = {
  active: true,
  createdAt: true,
  // `asNeeded` + the schedule count feed the as-needed invariants: a flip
  // to as-needed must end schedule-less, a flip back to scheduled must end
  // with at least one schedule.
  asNeeded: true,
  // The tracking transition (#1033) needs the before.
  trackIntake: true,
  // `autoMarkTakenSince` is stamped only on an off→on flip.
  autoMarkTaken: true,
  // The pre-image the audit row carries (C4).
  name: true,
  dose: true,
  endsOn: true,
  // The course check (#1024) needs the stored window.
  startsOn: true,
  oneShot: true,
  _count: { select: { schedules: true } },
} satisfies Prisma.MedicationSelect;

export type EditableMedication = Prisma.MedicationGetPayload<{
  select: typeof EDIT_SELECT;
}>;

/**
 * The narrow pre-image the edit reads after the route's ownership guard
 * passed: `active` for the pausedAt derivation, and the rest for the
 * invariants and the audit row. Null for the route's 404.
 */
export async function findMedicationForEdit(
  id: string,
): Promise<EditableMedication | null> {
  return prisma.medication.findUnique({
    where: { id },
    select: EDIT_SELECT,
  });
}

/**
 * ── A record-only schedule is only replaced knowingly (#1033) ──
 *
 * A medication with intake tracking off is served with `schedules: []`
 * and its stored schedule in `recordedSchedules`, so a client that
 * predates the field arms no reminder from it. The price is that such a
 * client cannot SEE the stored schedule. The shipped iPhone app (1.0.3 /
 * 1.0.4) opens a medication without schedule rows in its editor as
 * "daily at 08:00"; a rename or dose edit sends no `schedules` (its
 * editor diffs against that same prefill), but any touch of a schedule
 * field sends a full replacement built from the 08:00 default plus
 * `asNeeded` and `oneShot`, and never `trackIntake`. Applied, that would
 * overwrite the schedule the person kept on record with one they never
 * chose (or flip it to as-needed and delete the rows).
 *
 * Rule: on a medication whose intake tracking is off, a write that does
 * not name `trackIntake` leaves the schedule shape alone. `schedules`,
 * `asNeeded` and `oneShot` are dropped from it; every other field (name,
 * dose, dates, `active`, `notificationsEnabled`, inventory, ...) applies
 * as sent. A client that knows about the switch names it on every
 * schedule save (the web editor and wizard do), and those writes apply.
 */
export function applyRecordOnlyRule(
  existing: EditableMedication,
  data: MedicationEdit,
  id: string,
): MedicationEdit {
  const keepRecordedSchedule =
    existing.trackIntake === false &&
    data.trackIntake === undefined &&
    (data.schedules !== undefined ||
      data.asNeeded !== undefined ||
      data.oneShot !== undefined);
  const input = keepRecordedSchedule
    ? {
        ...data,
        schedules: undefined,
        asNeeded: undefined,
        oneShot: undefined,
      }
    : data;
  if (keepRecordedSchedule) {
    annotate({
      action: {
        name: "medication.update.record_schedule_kept",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        dropped_schedules: data.schedules !== undefined,
        dropped_as_needed: data.asNeeded !== undefined,
        dropped_one_shot: data.oneShot !== undefined,
      },
    });
  }
  return input;
}

/**
 * ── As-needed invariants (#316) ──
 *
 * An as-needed medication ends schedule-less, always. The Zod layer
 * already rejects a populated `schedules` array alongside
 * `asNeeded: true`; the route covers the cross-row cases the schema
 * cannot see:
 *   - flipping an existing scheduled medication to as-needed
 *     requires `schedules: []` in the same request (keeping the old
 *     rows alongside the flag is a 422, per the feature contract);
 *   - flipping as-needed OFF requires the medication to end with at
 *     least one schedule (the wizard always sends the full array).
 */
export function refuseAsNeededShape(
  existing: EditableMedication,
  asNeeded: boolean | undefined,
  schedules: MedicationEdit["schedules"],
): MedicationEditRefusal | null {
  const effectiveAsNeeded = asNeeded ?? existing.asNeeded;
  if (effectiveAsNeeded) {
    const endsScheduleless = schedules
      ? schedules.length === 0
      : existing._count.schedules === 0;
    if (!endsScheduleless) {
      return {
        ok: false,
        message:
          "An as-needed medication cannot carry schedules (send schedules: [] to clear them)",
        status: 422,
      };
    }
  } else if (
    asNeeded === false &&
    existing.asNeeded &&
    (!schedules || schedules.length === 0)
  ) {
    return {
      ok: false,
      message: "A scheduled medication requires at least one schedule",
      status: 422,
    };
  }
  return null;
}

export interface GracePatch {
  scheduleId: string;
  reminderGraceMinutes: number | null;
}

/**
 * ── Primary-schedule grace bridge ──
 *
 * The detail-page settings section saves the reminder-window in
 * one PUT carrying only `{ reminderGraceMinutes }` at the top
 * level (no full `schedules` array). Map it onto the medication's
 * primary schedule before the Prisma update so the persisted
 * shape stays per-schedule and the engine reads it from the same
 * column as the wizard write-path. A full `schedules` array on
 * the same request takes precedence — the wizard already declares
 * the grace per row and we never want to overwrite that intent.
 */
export async function findPrimaryScheduleGracePatch(
  id: string,
  topLevelGraceMinutes: number | null | undefined,
  schedules: MedicationEdit["schedules"],
): Promise<GracePatch | null> {
  let primaryScheduleGracePatch: GracePatch | null = null;
  if (topLevelGraceMinutes !== undefined && !schedules) {
    const primary = await prisma.medicationSchedule.findFirst({
      where: { medicationId: id },
      orderBy: [{ windowStart: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (primary) {
      primaryScheduleGracePatch = {
        scheduleId: primary.id,
        reminderGraceMinutes: topLevelGraceMinutes,
      };
    }
  }
  return primaryScheduleGracePatch;
}

/**
 * ── Route invariants for the scheduling primitives ──
 *
 * Mirrors the create: oneShot ⇒ at-most-one schedule + no
 * recurrence on it; endsOn normalised to startsOn for one-shot;
 * recurring default = FREQ=DAILY when nothing else is set;
 * timesOfDay dual-write from windowStart when absent.
 *
 * The PUT replaces all schedules wholesale, so the invariants run
 * against the incoming `schedules` array (if provided) the same
 * way they do on create.
 */
export function refuseOneShotShape(
  oneShot: boolean | undefined,
  schedules: MedicationEdit["schedules"],
): MedicationEditRefusal | null {
  if (oneShot === true && schedules) {
    if (schedules.length > 1) {
      return {
        ok: false,
        message: "A one-shot medication can have at most one schedule",
        status: 422,
      };
    }
    const s = schedules[0];
    if (s && (s.rrule !== undefined || s.rollingIntervalDays !== undefined)) {
      return {
        ok: false,
        message:
          "A one-shot medication cannot have a recurrence (rrule or rollingIntervalDays)",
        status: 422,
      };
    }
  }
  return null;
}

/**
 * The window a PUT sets is the latest course (#1024). Check it against the
 * other courses BEFORE the row changes, so a refused window leaves the
 * medication as it was.
 */
export async function refuseCourseWindow(args: {
  userId: string;
  medicationId: string;
  timeZone: string;
  nextWindow: { startsOn: Date | null; endsOn: Date | null };
  oneShot: boolean;
  createdAt: Date;
}): Promise<MedicationEditRefusal | null> {
  const refusal = await checkCurrentWindow({
    userId: args.userId,
    medicationId: args.medicationId,
    timeZone: args.timeZone,
    ...args.nextWindow,
    oneShot: args.oneShot,
    createdAt: args.createdAt,
  });
  if (refusal) {
    const r = courseRefusalResponse(refusal);
    return {
      ok: false,
      message: r.message,
      status: r.status,
      meta: { errorCode: r.errorCode },
    };
  }
  return null;
}
