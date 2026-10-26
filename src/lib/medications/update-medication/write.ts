/**
 * The write of a medication edit: everything the PUT changes on the
 * medication, its schedule and its course commits as one transaction.
 *
 * The course write can still be refused after the preflight check (another
 * request wrote a course in between); with the row update committed first,
 * the client got the refusal while the name, the schedule and `oneShot` were
 * already changed. Inside one transaction a refusal rolls all of it back. The
 * dose-day refresh and the grace bridge stay outside: both read or write what
 * this commit settles, and neither may undo it.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import type { SessionUser } from "@/lib/auth/session-user";
import { setCurrentWindow } from "@/lib/medications/courses";
import {
  schedulesMateriallyDiffer,
  toRevisionPayloadEntry,
} from "@/lib/medications/scheduling/schedule-eras";
import { moveAutoTakeFloorToNow } from "@/lib/medications/auto-take";
import { dayKeyForScheduledFor } from "@/lib/medications/dose-day-refresh";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import type { EditableMedication } from "./preflight";
import type { MedicationEdit, NormalisedSchedule } from "./schedule-normalise";
import { MEDICATION_SCHEDULE_ORDER } from "@/lib/medications/read-order";

/**
 * C7. What a schedule replacement destroys, captured for the audit row: the
 * cadence that was there and the pending slots that were tombstoned with it.
 * A feed line saying "changed a medication" cannot answer "back to what?",
 * and unlike a row a schedule keeps ACTING after the manager's grant ends.
 * `staleDoseDays` holds the dose days the tombstoned slots sat on, refreshed
 * once the transaction has committed the tombstones.
 */
export interface EraTrail {
  replacedCadence: string | null;
  replacedScheduleCount: number | null;
  tombstonedSlotCount: number | null;
  tombstonedFrom: Date | null;
  tombstonedTo: Date | null;
  staleDoseDays: Set<string>;
}

export function createEraTrail(): EraTrail {
  return {
    replacedCadence: null,
    replacedScheduleCount: null,
    tombstonedSlotCount: null,
    tombstonedFrom: null,
    tombstonedTo: null,
    staleDoseDays: new Set<string>(),
  };
}

export interface MedicationEditWrite {
  user: Pick<SessionUser, "id" | "timezone">;
  id: string;
  existing: EditableMedication;
  input: MedicationEdit;
  normalisedSchedules: NormalisedSchedule[] | undefined;
  wasTracked: boolean;
  willTrack: boolean;
  trackingChanged: boolean;
  pausedAtPatch: { pausedAt?: Date | null };
  touchesWindow: boolean;
  nextWindow: { startsOn: Date | null; endsOn: Date | null };
  courseTz: string;
  trail: EraTrail;
}

type RevisionSourceRow = Parameters<typeof toRevisionPayloadEntry>[0];

/**
 * Tombstone today's and future open pending rows of this medication. Runs on
 * a schedule replace (the old anchors are stale) and when intake tracking is
 * switched off (nothing is due any more).
 */
async function tombstoneOpenSlots(
  db: Prisma.TransactionClient,
  edit: MedicationEditWrite,
): Promise<void> {
  const { user, id, trail } = edit;
  // A schedule replace invalidates the open slot anchors the projector /
  // reminder worker minted for the OLD times: a pending 08:00 row for a
  // medication that now doses at 20:00 would linger as a phantom slot,
  // auto-miss later, and depress compliance. Tombstone today's and
  // future open pending rows (never an actioned row — `takenAt`,
  // `skipped`, and `autoMissed` are user-visible history) and bump
  // `syncVersion` so delta-sync clients drop them. The projector and
  // the reminder worker re-mint the anchors for the new times on their
  // next pass — the route does not pre-create them.
  const userTz = user.timezone || DEFAULT_TIMEZONE;
  const { start: todayStart } = getUserTodayBounds(new Date(), userTz);
  const tombstoneWhere = {
    userId: user.id,
    medicationId: id,
    deletedAt: null,
    takenAt: null,
    skipped: false,
    autoMissed: false,
    scheduledFor: { gte: todayStart },
  } as const;
  // Capture the affected slots BEFORE the tombstone so the compliance
  // rollups for those days can be recomputed after the commit —
  // `updateMany` does not return the touched rows. Without the
  // recompute a tombstoned pending kept counting as `scheduled` in
  // the rollup row until the next event-driven write for that day,
  // depressing the rate the cards read in the meantime.
  const tombstoned = await db.medicationIntakeEvent.findMany({
    where: tombstoneWhere,
    select: { scheduledFor: true },
  });
  // The count and the day range of the anchors that went.
  trail.tombstonedSlotCount = tombstoned.length;
  for (const row of tombstoned) {
    if (
      trail.tombstonedFrom === null ||
      row.scheduledFor < trail.tombstonedFrom
    ) {
      trail.tombstonedFrom = row.scheduledFor;
    }
    if (trail.tombstonedTo === null || row.scheduledFor > trail.tombstonedTo) {
      trail.tombstonedTo = row.scheduledFor;
    }
  }
  await db.medicationIntakeEvent.updateMany({
    where: tombstoneWhere,
    data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
  });
  // Deduped via the user-tz day key.
  for (const row of tombstoned) {
    trail.staleDoseDays.add(dayKeyForScheduledFor(row.scheduledFor, userTz));
  }
}

function revisionEntryOf(row: RevisionSourceRow) {
  return toRevisionPayloadEntry({
    timesOfDay: row.timesOfDay,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    daysOfWeek: row.daysOfWeek,
    rrule: row.rrule,
    rollingIntervalDays: row.rollingIntervalDays,
    scheduleType: row.scheduleType,
    cyclicOnWeeks: row.cyclicOnWeeks,
    cyclicOffWeeks: row.cyclicOffWeeks,
    doseWindows: row.doseWindows,
    label: row.label,
    dose: row.dose,
    reminderGraceMinutes: row.reminderGraceMinutes,
  });
}

/** One archived era covering `[previous validUntil | createdAt, now)`. */
async function archiveEra(
  tx: Prisma.TransactionClient,
  edit: MedicationEditWrite,
  payload: unknown[],
  meta: Record<string, unknown>,
): Promise<void> {
  const { id, existing } = edit;
  const lastRevision = await tx.medicationScheduleRevision.findFirst({
    // Chain from the ACTIVE boundary: a superseded row is an
    // audit record whose `validUntil` may sit past its correction.
    where: { medicationId: id, supersededByRevisionId: null },
    orderBy: [{ validUntil: "desc" }, { id: "desc" }],
    select: { validUntil: true },
  });
  await tx.medicationScheduleRevision.create({
    data: {
      medicationId: id,
      validFrom: lastRevision?.validUntil ?? existing.createdAt,
      validUntil: new Date(),
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
  annotate({
    action: {
      name: "medication.schedule.revision_archived",
      entity_type: "medication",
      entity_id: id,
    },
    meta,
  });
}

/** The cadence a schedule replace destroys, as one comparable line. */
function cadenceOf(previousRows: RevisionSourceRow[]): string | null {
  return previousRows.length > 0
    ? previousRows
        .map((row) =>
          [
            row.timesOfDay,
            row.rrule ?? "",
            row.rollingIntervalDays !== null
              ? `every ${row.rollingIntervalDays}d`
              : "",
            row.daysOfWeek ?? "",
          ]
            .filter((part) => part !== "")
            .join(" "),
        )
        .join(" | ")
    : null;
}

/**
 * A schedule replace. Effective dating: before the wholesale replace wipes
 * the old rows, archive them as ONE revision covering `[previous validUntil |
 * medication.createdAt, now)` — but only when a cadence-relevant field
 * actually changes. A no-op edit (the Zeitplan tab echoing the same rows
 * back) must not mint a phantom era.
 */
async function replaceSchedules(
  tx: Prisma.TransactionClient,
  edit: MedicationEditWrite,
  normalisedSchedules: NormalisedSchedule[],
): Promise<void> {
  const { id, existing, input, wasTracked, trackingChanged, trail } = edit;
  const previousRows = await tx.medicationSchedule.findMany({
    where: { medicationId: id },
  });
  const previousEntries = previousRows.map(revisionEntryOf);
  trail.replacedScheduleCount = previousRows.length;
  trail.replacedCadence = cadenceOf(previousRows);

  // A stretch with intake tracking off expected nothing (#1033), so it
  // archives with an empty payload whatever the rows said; and a tracking
  // transition is itself an era boundary even when the rows stay the same.
  const archivedEntries = wasTracked ? previousEntries : [];
  if (
    previousRows.length > 0 &&
    (trackingChanged ||
      !wasTracked ||
      schedulesMateriallyDiffer(
        previousEntries,
        normalisedSchedules.map((n) => n.snapshot),
      ))
  ) {
    await archiveEra(tx, edit, archivedEntries, {
      schedule_revision_rows: archivedEntries.length,
    });
  } else if (
    previousRows.length === 0 &&
    existing.asNeeded &&
    input.asNeeded === false &&
    normalisedSchedules.length > 0
  ) {
    // Flipping as-needed OFF. The medication carried ZERO
    // schedule rows while as-needed, so the wholesale-replace archive
    // above never fires — and without a revision the live era would
    // start at the PREVIOUS revision's `validUntil` (or `createdAt`),
    // retro-painting the schedule-less as-needed stretch with the NEW
    // schedule's expected slots: every PRN day would read as missed.
    // Archive an EMPTY era covering the as-needed stretch instead; an
    // empty payload expands to zero schedules, so era-aware compliance
    // expects nothing there — exactly the as-needed contract.
    await archiveEra(tx, edit, [], { schedule_revision_rows: 0 });
  }
  await tombstoneOpenSlots(tx, edit);
  await tx.medicationSchedule.deleteMany({
    where: { medicationId: id },
  });
}

/**
 * Intake tracking switched without a schedule replace (#1033). Close the
 * current era at this instant: switching OFF archives the schedule that was
 * in force (the tracked stretch keeps its expected doses); switching back ON
 * archives the untracked stretch with an empty payload, so compliance never
 * counts it as missed and the live schedule, the projector and the reminder
 * worker all resume from now.
 */
async function archiveTrackingSwitch(
  tx: Prisma.TransactionClient,
  edit: MedicationEditWrite,
): Promise<void> {
  const { id, wasTracked, willTrack } = edit;
  const liveRows = await tx.medicationSchedule.findMany({
    where: { medicationId: id },
  });
  if (liveRows.length > 0) {
    const archivedEntries = wasTracked ? liveRows.map(revisionEntryOf) : [];
    await archiveEra(tx, edit, archivedEntries, {
      schedule_revision_rows: archivedEntries.length,
      track_intake: willTrack,
    });
  }
}

/** The medication row's update, field-by-field from the parsed body. */
function medicationUpdateData(edit: MedicationEditWrite) {
  const { existing, input, normalisedSchedules } = edit;
  const {
    name,
    dose,
    treatmentClass,
    dosesPerUnit,
    unitsPerDose,
    reorderLeadDays,
    deliveryForm,
    trackInjectionSites,
    allowedInjectionSites,
    active,
    notificationsEnabled,
    liveActivityEnabled,
    criticalAlarmEnabled,
    atcCode,
    rxNormCode,
    oneShot,
    asNeeded,
    trackIntake,
    autoMarkTaken,
  } = input;
  return {
    ...(name !== undefined && { name }),
    ...(dose !== undefined && { dose }),
    ...(treatmentClass !== undefined && { treatmentClass }),
    ...(dosesPerUnit !== undefined && { dosesPerUnit }),
    // Units consumed per dose. Field-by-field; the stamp on
    // already-taken intake events freezes their recorded consumption.
    ...(unitsPerDose !== undefined && { unitsPerDose }),
    // Reorder lead override. Field-by-field; `null` is a
    // valid explicit value (clears the override → user-level default).
    ...(reorderLeadDays !== undefined && { reorderLeadDays }),
    ...(deliveryForm !== undefined && { deliveryForm }),
    // Injection-site tracking opt-in + per-medication allowed
    // sites. Field-by-field; `false` / `[]` are valid explicit values
    // (deactivate tracking / clear the per-med restriction).
    ...(trackInjectionSites !== undefined && { trackInjectionSites }),
    ...(allowedInjectionSites !== undefined && { allowedInjectionSites }),
    ...(active !== undefined && { active }),
    ...(notificationsEnabled !== undefined && { notificationsEnabled }),
    // iOS reminder flags, field-by-field.
    ...(liveActivityEnabled !== undefined && { liveActivityEnabled }),
    ...(criticalAlarmEnabled !== undefined && { criticalAlarmEnabled }),
    // Optional drug-classification codes (ATC / RxNorm).
    // Field-by-field; `null` is a valid explicit value (clears the code).
    ...(atcCode !== undefined && { atcCode }),
    ...(rxNormCode !== undefined && { rxNormCode }),
    // Scheduling primitives — pass-through when supplied.
    // `startsOn` / `endsOn` are not written here (#1024): the
    // course writer below writes them together with the course they
    // project, in one transaction, so the row and its courses cannot
    // disagree if one of the two writes fails.
    ...(oneShot !== undefined && { oneShot }),
    // As-needed flag, field-by-field (the invariants above
    // already guaranteed the medication ends schedule-consistent).
    ...(asNeeded !== undefined && { asNeeded }),
    // Intake tracking, field-by-field (#1033).
    ...(trackIntake !== undefined && { trackIntake }),
    // Auto-mark-taken, field-by-field. Only an off→on flip
    // stamps `autoMarkTakenSince`, so re-saving the form with the
    // option already on never moves the floor; switching it off
    // clears the stamp.
    ...(autoMarkTaken !== undefined &&
      autoMarkTaken !== existing.autoMarkTaken && {
        autoMarkTaken,
        autoMarkTakenSince: autoMarkTaken ? new Date() : null,
      }),
    ...(normalisedSchedules && {
      schedules: {
        create: normalisedSchedules.map((n) => n.createData),
      },
    }),
  };
}

/**
 * Durable pause intervals. The `pausedAt` column is a single live marker that
 * resume clears, so the paused window is irrecoverable once resumed and every
 * paused day's slot collapses to "missed" in the compliance denominator.
 * Mirror the live transition onto an additive era record the rate paths read:
 * a pause opens an era (resumedAt null), a resume closes the latest open era.
 * `userId` comes from the authenticated session; the data object is built
 * field-by-field.
 */
async function recordPauseTransition(
  tx: Prisma.TransactionClient,
  edit: MedicationEditWrite,
): Promise<void> {
  const { user, id, existing } = edit;
  const { active } = edit.input;
  if (active === false && existing.active) {
    await tx.medicationPauseEra.create({
      data: {
        medicationId: id,
        userId: user.id,
        pausedAt: new Date(),
        resumedAt: null,
      },
    });
  } else if (active === true && !existing.active) {
    await tx.medicationPauseEra.updateMany({
      where: { medicationId: id, userId: user.id, resumedAt: null },
      data: { resumedAt: new Date() },
    });
    // Made active again: the auto-take pass starts from
    // now, never filling the inactive days as taken.
    await moveAutoTakeFloorToNow(tx, id);
  }
}

/**
 * The transaction. Throws `CourseWriteError` when a concurrent course write
 * landed between the preflight check and the course write; nothing is then
 * written.
 */
export async function writeMedicationEdit(edit: MedicationEditWrite) {
  const { user, id, input, normalisedSchedules, trackingChanged, willTrack } =
    edit;
  const { schedules } = input;
  return prisma.$transaction(async (tx) => {
    // If schedules provided, replace all
    if (schedules && normalisedSchedules) {
      await replaceSchedules(tx, edit, normalisedSchedules);
    } else if (trackingChanged) {
      await archiveTrackingSwitch(tx, edit);
    }

    // Switching intake tracking off leaves nothing due (#1033):
    // the open placeholders of today and later go the way a schedule
    // replace sends them (a replace in the same request already did it).
    if (trackingChanged && !willTrack && !schedules) {
      await tombstoneOpenSlots(tx, edit);
    }

    const baseUpdateData = medicationUpdateData(edit);

    const updated = await tx.medication.update({
      where: { id },
      data: { ...baseUpdateData, ...edit.pausedAtPatch },
      include: { schedules: { orderBy: MEDICATION_SCHEDULE_ORDER } },
    });

    await recordPauseTransition(tx, edit);

    // Write the window onto the latest course and
    // project it back, then serve the projected row (#1024).
    if (edit.touchesWindow) {
      const projected = await setCurrentWindow(
        {
          userId: user.id,
          medicationId: id,
          timeZone: edit.courseTz,
          ...edit.nextWindow,
        },
        tx,
      );
      return { ...updated, ...projected };
    }
    return updated;
  });
}
