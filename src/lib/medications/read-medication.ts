/**
 * Read one medication: `GET /api/medications/{id}`.
 *
 * The route authenticates (READ over the `medications` section) and answers
 * the 404; the fetch, the category enrichment, the server-computed next due
 * instant, the stock and runway, the composition, the courses and the related
 * records are resolved here, in the order they always were. `null` means the
 * medication is not the record's.
 */
import type { Medication, MedicationSchedule } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { sendsMedicationReminders } from "@/lib/medications/auto-mark-taken";
import { toIngredientDtos } from "@/lib/medications/ingredients/composition";
import { annotate } from "@/lib/logging/context";
import type { SessionUser } from "@/lib/auth/session-user";
import { resolveMedicationCategories } from "@/lib/medication-category";
import { resolveCourseFields } from "@/lib/medications/courses";
import { loadAutoTakeRollingAnchors } from "@/lib/medications/auto-take";
import {
  computeDisplayDue,
  OVERDUE_LOOKBACK_MS,
  toResolvedSlotMark,
} from "@/lib/medications/scheduling/next-due";
import {
  effectiveUnitsPerDose,
  estimateUnitsRunwayDays,
} from "@/lib/medications/supply-runway";
import { serializeScheduleUnitsPerDose } from "@/lib/medications/schedule-units-dto";
import {
  dueSchedules,
  isRecordOnly,
  scheduleWireFields,
} from "@/lib/medications/intake-tracking";
import { floorWhole } from "@/lib/medications/units-per-dose";
import { resolveIntakeActionability } from "@/lib/medications/intake-actionable";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { buildRelated } from "@/lib/links/related";

export type ReadUser = Pick<SessionUser, "id" | "timezone" | "locale">;
type MedicationWithSchedules = Medication & {
  schedules: MedicationSchedule[];
};

/**
 * The server-computed next due instant. Rolling cadences re-anchor on the
 * latest non-skipped intake, so fetch it once (no-op for calendar cadences
 * but cheap + keeps the value correct for rolling injections).
 */
async function loadDisplayDue(
  user: ReadUser,
  id: string,
  medication: MedicationWithSchedules,
) {
  const lastIntake = dueSchedules(medication).some(
    (s) => s.rollingIntervalDays !== null,
  )
    ? await prisma.medicationIntakeEvent.findFirst({
        // A tombstoned intake no longer anchors the rolling-interval
        // next-due computation.
        where: {
          userId: user.id,
          medicationId: id,
          deletedAt: null,
          takenAt: { not: null },
        },
        orderBy: { takenAt: "desc" },
        select: { takenAt: true },
      })
    : null;
  // Slots the user has already acted on near now, so the next-due search
  // skips them and advances to the next genuinely-open slot. Bound the read
  // to [now-1d, now+2d] — the lookahead only needs the slots adjacent to now.
  const now = new Date();
  // Reach back as far as the widest band tail so a long-resolved past slot
  // can never resurface as "overdue".
  const resolvedFrom = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);
  const resolvedTo = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const resolvedRows = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId: user.id,
      medicationId: id,
      deletedAt: null,
      scheduledFor: { gte: resolvedFrom, lte: resolvedTo },
      OR: [{ takenAt: { not: null } }, { skipped: true }, { autoMissed: true }],
    },
    // `takenAt` rides along so an ad-hoc row (`scheduledFor === takenAt`)
    // cannot ±6h-resolve a different slot.
    select: { scheduledFor: true, takenAt: true },
  });
  // Current-era floor: the open-overdue search mints from the LIVE schedule
  // rows, so it must not reach past the newest revision boundary into a
  // previous era's cadence.
  const latestRevision = await prisma.medicationScheduleRevision.findFirst({
    // Superseded rows are audit records — a correction may have
    // shortened the era, so the boundary reads only active rows.
    where: { medicationId: id, supersededByRevisionId: null },
    orderBy: { validUntil: "desc" },
    select: { validUntil: true },
  });
  // Intake tracking off (#1033): nothing is due from the stored rows, and no
  // runway derives from them.
  const liveSchedules = dueSchedules(medication);
  const userTz = user.timezone || DEFAULT_TIMEZONE;
  // Under auto-take a rolling cadence stands where the job will record next
  // (see `auto-take.ts`).
  const engineLastIntakeAt = await loadAutoTakeRollingAnchors(prisma, {
    userId: user.id,
    medicationIds: medication.autoMarkTaken ? [id] : [],
    now,
    userTz,
    lastIntakeAt: () => lastIntake?.takenAt ?? null,
  });
  const display = computeDisplayDue({
    medication: {
      id: medication.id,
      startsOn: medication.startsOn,
      endsOn: medication.endsOn,
      oneShot: medication.oneShot,
      createdAt: medication.createdAt,
    },
    schedules: liveSchedules,
    now,
    userTz,
    lastIntakeAt: engineLastIntakeAt(id),
    resolvedSlots: resolvedRows.map(toResolvedSlotMark),
    eraStart: latestRevision?.validUntil ?? null,
  });
  return { display, userTz, now };
}

/**
 * Stock + runway on the detail wire, mirroring the list payload's semantics:
 * NULL stock = inventory tracking off, 0 = the supply ran out; runwayDays via
 * the slot-aware burn rate. Published resolved so no client re-derives the
 * inheritance / cadence math.
 */
async function loadStock(
  user: ReadUser,
  id: string,
  medication: MedicationWithSchedules,
) {
  const [usableStock, anyItemCount] = await Promise.all([
    prisma.medicationInventoryItem.aggregate({
      where: {
        userId: user.id,
        medicationId: id,
        state: { in: ["ACTIVE", "IN_USE"] },
        unitsRemaining: { gt: 0 },
      },
      _sum: { unitsRemaining: true },
    }),
    prisma.medicationInventoryItem.count({
      where: { userId: user.id, medicationId: id },
    }),
  ]);
  const schedulesDto = serializeScheduleUnitsPerDose(
    medication.schedules,
    medication.unitsPerDose,
  );
  const stockUnitsRemaining =
    anyItemCount > 0 ? Number(usableStock._sum.unitsRemaining ?? 0) : null;
  const stockDosesRemaining =
    stockUnitsRemaining === null
      ? null
      : floorWhole(
          stockUnitsRemaining /
            effectiveUnitsPerDose(
              schedulesDto,
              Number(medication.unitsPerDose),
            ),
        );
  const runwayDays =
    stockUnitsRemaining === null
      ? null
      : estimateUnitsRunwayDays(
          stockUnitsRemaining,
          isRecordOnly(medication) ? [] : schedulesDto,
          Number(medication.unitsPerDose),
        );
  return { schedulesDto, stockUnitsRemaining, stockDosesRemaining, runwayDays };
}

/** The detail answer of one medication, or null for the route's 404. */
export async function readMedication(input: {
  user: ReadUser;
  grantId: string | null;
  id: string;
}): Promise<Record<string, unknown> | null> {
  const { user, grantId, id } = input;
  const medication = await prisma.medication.findUnique({
    where: { id },
    include: { schedules: true },
  });

  if (!medication || medication.userId !== user.id) {
    return null;
  }
  return medicationDetail({ user, grantId, medication, announce: true });
}

/**
 * The read model of a medication row in hand: the detail answer, and the
 * answer of a create or an edit, which pass the row they just wrote so they
 * answer exactly what `GET /api/medications/{id}` would.
 */
export async function medicationDetail(input: {
  user: ReadUser;
  grantId: string | null;
  medication: MedicationWithSchedules;
  /**
   * Name the request's action `medication.get`. A write answering with the
   * read model passes false and keeps its own action.
   */
  announce: boolean;
}): Promise<Record<string, unknown>> {
  const { user, grantId, medication } = input;
  const id = medication.id;

  let category = "OTHER";
  let categoryLabel: string | null = null;
  try {
    const categories = await resolveMedicationCategories([id]);
    category = categories[id]?.category ?? "OTHER";
    categoryLabel = categories[id]?.categoryLabel ?? null;
  } catch {
    // Category enrichment is optional
  }

  const { display, userTz, now } = await loadDisplayDue(user, id, medication);

  if (input.announce) {
    annotate({
      action: {
        name: "medication.get",
        entity_type: "medication",
        entity_id: id,
      },
    });
  }

  const { schedulesDto, stockUnitsRemaining, stockDosesRemaining, runwayDays } =
    await loadStock(user, id, medication);

  // The composition per unit, labelled in the account language.
  const ingredientRows = await prisma.medicationIngredient.findMany({
    where: { medicationId: id, userId: user.id },
    select: {
      nutrient: true,
      amountPerUnit: true,
      unit: true,
      enteredAmount: true,
      enteredUnit: true,
    },
  });

  // The courses, resolved on the server (#1024).
  const courseFields = (
    await resolveCourseFields(
      [medication],
      now,
      user.timezone || DEFAULT_TIMEZONE,
    )
  ).get(id);

  return {
    ...medication,
    unitsPerDose: Number(medication.unitsPerDose),
    // `schedules: []` plus `recordedSchedules` when intake tracking is off
    // (#1033, see `scheduleWireFields`).
    ...scheduleWireFields(medication.trackIntake, schedulesDto),
    category,
    categoryLabel,
    ...courseFields,
    nextDueAt: display ? display.at.toISOString() : null,
    // The server's own reminder decision, published resolved.
    remindersActive: sendsMedicationReminders(medication, {
      now,
      timeZone: userTz,
    }),
    nextDueOverdue: display?.overdue ?? false,
    // See `resolveIntakeActionability` (#1040).
    ...resolveIntakeActionability(
      medication,
      now,
      user.timezone || DEFAULT_TIMEZONE,
    ),
    stockUnitsRemaining,
    stockDosesRemaining,
    runwayDays,
    ingredients: toIngredientDtos(ingredientRows, user.locale ?? null),
    // The records this medication relates to (`src/lib/links/`).
    related: await buildRelated(prisma, {
      userId: user.id,
      grantId,
      kind: "medication",
      id,
    }),
  };
}
