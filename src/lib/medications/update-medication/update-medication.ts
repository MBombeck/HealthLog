/**
 * Edit one medication: `PUT /api/medications/{id}`.
 *
 * The route authenticates (MANAGE over the `medications` section), runs the
 * ownership guard, reads the pre-image through `findMedicationForEdit` and
 * parses the body; the record-only rule, the invariants, the transaction and
 * everything after it run here, in the order they always ran. The outcome is
 * a refusal the route answers with `apiError`, or the edited medication.
 */
import {
  medicationDetail,
  type ReadUser,
} from "@/lib/medications/read-medication";
import { prisma } from "@/lib/db";
import {
  enqueueSupplementNutrientRecompute,
  medicationHasComposition,
} from "@/lib/medications/ingredients/recompute-job";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  isAssignableCategory,
  resolveMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import {
  CourseWriteError,
  courseRefusalResponse,
} from "@/lib/medications/courses";
import { refreshDoseDay } from "@/lib/medications/dose-day-refresh";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import {
  applyRecordOnlyRule,
  findPrimaryScheduleGracePatch,
  refuseAsNeededShape,
  refuseCourseWindow,
  refuseOneShotShape,
  type EditableMedication,
  type GracePatch,
  type MedicationEditRefusal,
} from "./preflight";
import { normaliseSchedules, type MedicationEdit } from "./schedule-normalise";
import {
  createEraTrail,
  writeMedicationEdit,
  type EraTrail,
  type MedicationEditWrite,
} from "./write";

type EditUser = ReadUser;
type EditedMedication = Awaited<ReturnType<typeof writeMedicationEdit>>;

export type MedicationEditOutcome =
  MedicationEditRefusal | { ok: true; body: Record<string, unknown> };

/**
 * Everything the edit checks and derives before the transaction, in the
 * order the route always ran it. A refusal leaves the medication as it was.
 */
async function planMedicationEdit(input: {
  user: EditUser;
  id: string;
  existing: EditableMedication;
  data: MedicationEdit;
}): Promise<
  | MedicationEditRefusal
  | {
      ok: true;
      write: MedicationEditWrite;
      primaryScheduleGracePatch: GracePatch | null;
    }
> {
  const { user, id, existing } = input;
  const edit = applyRecordOnlyRule(existing, input.data, id);
  const {
    category,
    active,
    schedules,
    startsOn,
    endsOn,
    oneShot,
    asNeeded,
    trackIntake,
    reminderGraceMinutes: topLevelGraceMinutes,
  } = edit;

  // A custom category must be one of this record's own (#1041).
  if (
    category !== undefined &&
    !(await isAssignableCategory(user.id, category))
  ) {
    return {
      ok: false,
      message: "Unknown medication category",
      status: 422,
      meta: { errorCode: "medications.category.unknown" },
    };
  }

  // Intake tracking transition (#1033). Off keeps the schedule as a record;
  // the live era from here on expects nothing.
  const wasTracked = existing.trackIntake !== false;
  const willTrack = trackIntake ?? wasTracked;
  const trackingChanged = wasTracked !== willTrack;

  const asNeededRefusal = refuseAsNeededShape(existing, asNeeded, schedules);
  if (asNeededRefusal) return asNeededRefusal;

  const primaryScheduleGracePatch = await findPrimaryScheduleGracePatch(
    id,
    topLevelGraceMinutes,
    schedules,
  );

  const oneShotRefusal = refuseOneShotShape(oneShot, schedules);
  if (oneShotRefusal) return oneShotRefusal;

  // Normalise endsOn for one-shot. `oneShot === true` + `startsOn`
  // means the dose is the start date; endsOn auto-matches.
  const normalisedEndsOn = oneShot === true && startsOn ? startsOn : endsOn;

  const touchesWindow =
    startsOn !== undefined ||
    normalisedEndsOn !== undefined ||
    oneShot !== undefined;
  const nextWindow = {
    startsOn: startsOn !== undefined ? startsOn : existing.startsOn,
    endsOn: normalisedEndsOn !== undefined ? normalisedEndsOn : existing.endsOn,
  };
  const courseTz = user.timezone || DEFAULT_TIMEZONE;
  if (touchesWindow) {
    const refusal = await refuseCourseWindow({
      userId: user.id,
      medicationId: id,
      timeZone: courseTz,
      nextWindow,
      oneShot: oneShot ?? existing.oneShot,
      createdAt: existing.createdAt,
    });
    if (refusal) return refusal;
  }

  const pausedAtPatch =
    active === undefined
      ? {}
      : active
        ? { pausedAt: null as Date | null }
        : existing.active
          ? { pausedAt: new Date() }
          : {};

  return {
    ok: true,
    primaryScheduleGracePatch,
    write: {
      user,
      id,
      existing,
      input: edit,
      normalisedSchedules: normaliseSchedules(schedules, oneShot),
      wasTracked,
      willTrack,
      trackingChanged,
      pausedAtPatch,
      touchesWindow,
      nextWindow,
      courseTz,
      trail: createEraTrail(),
    },
  };
}

/**
 * Refresh each dose day the tombstoned slots sat on, now that the tombstones
 * are committed, then apply the primary-schedule grace bridge. Both run
 * after the transaction so a failure here doesn't roll the edit back.
 */
async function settleAfterCommit(
  write: MedicationEditWrite,
  medication: EditedMedication,
  primaryScheduleGracePatch: GracePatch | null,
): Promise<EditedMedication> {
  const { user, id, trail } = write;
  // Best-effort like every dose write-hook: a failure is reported, never
  // fails the edit.
  for (const dayKey of trail.staleDoseDays) {
    await refreshDoseDay({
      userId: user.id,
      medicationId: id,
      dayKey,
      tz: user.timezone || DEFAULT_TIMEZONE,
    });
  }

  // Re-read the row so the response shape carries the converged grace value.
  if (primaryScheduleGracePatch) {
    await prisma.medicationSchedule.update({
      where: { id: primaryScheduleGracePatch.scheduleId },
      data: {
        reminderGraceMinutes: primaryScheduleGracePatch.reminderGraceMinutes,
      },
    });
    const refreshed = await prisma.medication.findUnique({
      where: { id },
      include: { schedules: true },
    });
    if (refreshed) {
      return refreshed;
    }
  }
  return medication;
}

/**
 * An iPhone app build that predates custom categories (#1041) decodes an
 * unknown category as OTHER and sends it back on every edit, which would
 * overwrite the person's own category with OTHER. A native client (Bearer)
 * sending OTHER over a custom category keeps the custom one; moving a custom
 * category back to OTHER stays possible on the web.
 */
async function writeCategory(
  id: string,
  category: string | undefined,
  authMethod: string,
) {
  let categoryToWrite = category;
  if (category === "OTHER" && authMethod === "bearer") {
    const current = (await resolveMedicationCategories([id]))[id];
    if (current?.category.startsWith("custom:")) {
      categoryToWrite = undefined;
      annotate({
        action: { name: "medication.update.custom_category_kept" },
        meta: { entity_id: id },
      });
    }
  }
  if (categoryToWrite !== undefined)
    await setMedicationCategory(id, categoryToWrite);
}

/** The audit row: C4 on the medication row itself, C7 on the schedule. */
async function auditMedicationEdit(
  write: MedicationEditWrite,
  medication: EditedMedication,
  ipAddress: string | null,
) {
  const { user, id, existing, trail } = write;
  const {
    replacedCadence,
    replacedScheduleCount,
    tombstonedSlotCount,
    tombstonedFrom,
    tombstonedTo,
  }: EraTrail = trail;
  await auditLog("medication.update", {
    userId: user.id,
    ipAddress,
    // C4 on what the medication row itself lost, and C7 on the schedule:
    // the cadence that was replaced, and how many pending slots went with
    // it over which days.
    details: {
      medicationId: id,
      ...overwriteDetails({
        before: {
          name: existing.name,
          dose: existing.dose,
          active: existing.active,
          asNeeded: existing.asNeeded,
          trackIntake: existing.trackIntake,
          // Switching automatic recording on or off is a change
          // to how doses are recorded, so the row names it.
          autoMarkTaken: existing.autoMarkTaken,
          endsOn: existing.endsOn,
        },
        after: {
          name: medication.name,
          dose: medication.dose,
          active: medication.active,
          asNeeded: medication.asNeeded,
          trackIntake: medication.trackIntake,
          autoMarkTaken: medication.autoMarkTaken,
          endsOn: medication.endsOn,
        },
      }),
      ...(replacedScheduleCount !== null
        ? {
            replacedCadence,
            replacedScheduleCount,
            tombstonedSlotCount,
            tombstonedFrom: tombstonedFrom?.toISOString() ?? null,
            tombstonedTo: tombstonedTo?.toISOString() ?? null,
          }
        : {}),
    },
  });
}

/** Edit one medication the route found and authorised. */
export async function updateMedication(input: {
  user: EditUser;
  authMethod: string;
  id: string;
  existing: EditableMedication;
  data: MedicationEdit;
  ipAddress: string | null;
}): Promise<MedicationEditOutcome> {
  const { user, id } = input;
  const plan = await planMedicationEdit(input);
  if (!plan.ok) return plan;
  const { write } = plan;

  let medication: EditedMedication;
  try {
    medication = await writeMedicationEdit(write);
  } catch (err) {
    // A concurrent course write landed between the check above and the
    // course write. The transaction rolled back: nothing was written.
    if (err instanceof CourseWriteError) {
      const r = courseRefusalResponse(err.refusal);
      return {
        ok: false,
        message: r.message,
        status: r.status,
        meta: { errorCode: r.errorCode },
      };
    }
    throw err;
  }

  medication = await settleAfterCommit(
    write,
    medication,
    plan.primaryScheduleGracePatch,
  );

  await writeCategory(id, write.input.category, input.authMethod);

  // A changed units-per-dose (on the medication or on a slot) changes what
  // every taken dose added, so a medication with a composition has its doses
  // recomputed. Cheap and coalesced when nothing moved.
  if (await medicationHasComposition(user.id, id)) {
    await enqueueSupplementNutrientRecompute(user.id);
  }

  await auditMedicationEdit(write, medication, input.ipAddress);

  annotate({
    action: {
      name: "medication.update",
      entity_type: "medication",
      entity_id: id,
    },
  });

  // Bust per-user medications + compliance + achievement caches so the next
  // read reflects the schedule change.
  invalidateUserMedications(user.id, { evict: true });

  // The read model, exactly as `GET /api/medications/{id}` answers it.
  const body = await medicationDetail({
    user,
    grantId: null,
    medication,
    announce: false,
  });
  return { ok: true, body };
}
