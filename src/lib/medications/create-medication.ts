/**
 * Create a medication with its nested schedule: `POST /api/medications`.
 *
 * The route authenticates (WRITE over the `medications` section), reads the
 * body and answers the schema refusal; everything from the category check to
 * the cache eviction runs here, in the order it always ran. The result says
 * what the route answers: a refusal, the existing row of a mirrored concept
 * the record already holds, or the new row.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { courseRefusalResponse } from "@/lib/medications/courses";
import {
  dateOfDayKey,
  dayKeyOfDate,
  validateCourses,
} from "@/lib/medications/course-window";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import type { createMedicationSchema } from "@/lib/validations/medication";
import {
  isAssignableCategory,
  setMedicationCategory,
} from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import type { Medication, MedicationSchedule } from "@/generated/prisma/client";
import {
  medicationDetail,
  type ReadUser,
} from "@/lib/medications/read-medication";
import { MEDICATION_SCHEDULE_ORDER } from "@/lib/medications/read-order";

export type CreateMedicationInput = z.output<typeof createMedicationSchema>;
type ScheduleInput = NonNullable<CreateMedicationInput["schedules"]>[number];

/**
 * Blast-radius cap on externally-mirrored medications per user. A client
 * that mints a fresh `externalId` for the same source concept on every sync
 * sweep (a known iOS unstable-key bug class) never matches the idempotency
 * triple, so each sweep would otherwise create a new mirror row unbounded.
 * Apple's own medication list makes >30 genuinely distinct meds implausible,
 * so this caps the damage a buggy client can do without breaking any
 * legitimate use.
 */
const APPLE_HEALTH_MIRROR_CAP = 30;

export type CreateMedicationOutcome =
  | {
      kind: "refused";
      message: string;
      status: number;
      meta?: { errorCode: string };
    }
  | { kind: "existing"; body: Record<string, unknown> }
  | { kind: "created"; body: Record<string, unknown> };

/**
 * Idempotent response for a re-mirrored medication. The create returns the
 * EXISTING row (status 200, vs 201 for a fresh create) when the caller
 * re-posts a `(externalSource, externalId)` pair this user already mirrors —
 * the iOS re-sync replays its full HealthKit medication list, and a replay
 * must neither duplicate nor 500. It answers the medication's read model,
 * the same body the fresh create and the detail read answer; no audit row
 * and no cache eviction because nothing was written.
 */
async function existingMirrorBody(
  user: ReadUser,
  medication: Medication & { schedules: MedicationSchedule[] },
): Promise<CreateMedicationOutcome> {
  annotate({
    action: {
      name: "medication.create",
      entity_type: "medication",
      entity_id: medication.id,
    },
    meta: { idempotent_replay: true },
  });
  // The read model, exactly as `GET /api/medications/{id}` answers it.
  const body = await medicationDetail({
    user,
    grantId: null,
    medication,
    announce: false,
  });
  return { kind: "existing", body };
}

/**
 * Idempotent mirror create. A mirrored medication (Apple Health) is keyed by
 * the `(userId, externalSource, externalId)` unique; a re-post of the same
 * concept id (iOS re-sync, retry after a dropped response) returns the
 * EXISTING medication with 200 instead of minting a duplicate or 500-ing on
 * P2002. The pre-query covers the common replay; the P2002 catch around the
 * create covers the concurrent race. Null when the create goes ahead.
 */
async function existingMirrorOrCap(
  user: ReadUser,
  externalSource: NonNullable<CreateMedicationInput["externalSource"]>,
  externalId: string,
): Promise<CreateMedicationOutcome | null> {
  const userId = user.id;
  const existing = await prisma.medication.findFirst({
    where: { userId, externalSource, externalId },
    include: { schedules: { orderBy: MEDICATION_SCHEDULE_ORDER } },
  });
  if (existing) {
    return existingMirrorBody(user, existing);
  }

  // Growth guard. This point is only reached when the idempotency lookup
  // MISSED, i.e. this is a genuinely NEW mirror row, not a replay of one the
  // user already holds (a replay returned 200 above). An idempotent re-post
  // of an existing mirror is therefore never blocked, even for a user already
  // at the cap. Refuse only the minting of a fresh row once the user already
  // holds the cap of Apple-Health-mirrored medications, so a client feeding a
  // rotating key can no longer fill the list with duplicates. The count runs
  // on the mirror-create-miss path only; native creates (no `externalSource`)
  // never reach this branch and pay nothing.
  const mirroredCount = await prisma.medication.count({
    where: { userId, externalSource: "APPLE_HEALTH" },
  });
  if (mirroredCount >= APPLE_HEALTH_MIRROR_CAP) {
    annotate({
      action: { name: "medication.mirror.limit_exceeded" },
      meta: { existing: mirroredCount },
    });
    return {
      kind: "refused",
      message:
        "This account already mirrors the maximum number of medications from an external source",
      status: 422,
      meta: { errorCode: "medications.mirror.limit_exceeded" },
    };
  }
  return null;
}

/**
 * Route invariants for the scheduling primitives.
 *
 * The Zod layer already enforces `rrule` xor `rollingIntervalDays`
 * (scheduleSchema.refine). This layer enforces the cross-field invariants
 * that span medication + schedules:
 *
 *   1. **One-shot consistency** — when `oneShot === true`:
 *      a. The medication has at most ONE schedule.
 *      b. The single schedule carries neither `rrule` nor
 *         `rollingIntervalDays` (a one-shot dose IS the schedule).
 *      c. `endsOn` is normalised to equal `startsOn` on write so the
 *         worker's date-range cap matches the one-and-only slot.
 *
 *   2. **Recurring default** — when `oneShot !== true` AND the schedule has
 *      no `rrule`, no `rollingIntervalDays`, and no legacy `daysOfWeek`, the
 *      create stamps `rrule = "FREQ=DAILY"` so the canonical recurrence
 *      engine has a clean shape going forward instead of falling through to
 *      the legacy parser.
 *
 *   3. **iOS contract dual-write** — when `timesOfDay` is absent or empty,
 *      the create stamps `[windowStart]` so the new engine always sees a
 *      populated `timesOfDay` while legacy iOS clients (v0.6.x) keep encoding
 *      the `windowStart` / `windowEnd` / `daysOfWeek` shape. Both shapes
 *      coexist.
 *   4. **As-needed (#316)** — when `asNeeded === true` the medication carries
 *      ZERO schedules (the Zod refine already rejects a populated array,
 *      mutual exclusion with `oneShot` included). Every "never due / never
 *      reminded / never scored" surface follows structurally from the empty
 *      schedule list.
 */
function refuseOneShotShape(
  oneShot: boolean | undefined,
  scheduleInputs: readonly ScheduleInput[],
): CreateMedicationOutcome | null {
  if (oneShot === true) {
    if (scheduleInputs.length > 1) {
      return {
        kind: "refused",
        message: "A one-shot medication can have at most one schedule",
        status: 422,
      };
    }
    const s = scheduleInputs[0];
    if (s && (s.rrule !== undefined || s.rollingIntervalDays !== undefined)) {
      return {
        kind: "refused",
        message:
          "A one-shot medication cannot have a recurrence (rrule or rollingIntervalDays)",
        status: 422,
      };
    }
  }
  return null;
}

/**
 * A medication created with a window starts with one course; the row
 * projects it (#1024). An end without a start has always meant "running
 * since creation", so the course starts today (or on the end day, when that
 * lies earlier). No window: no course, chronic since creation.
 */
function resolveInitialCourse(
  timezone: string,
  startsOn: Date | null | undefined,
  normalisedEndsOn: Date | undefined,
  oneShot: boolean | undefined,
):
  | { initialCourse: { startsOn: Date; endsOn: Date | null } | null }
  | { refusal: CreateMedicationOutcome } {
  let initialCourse: { startsOn: Date; endsOn: Date | null } | null = null;
  if (startsOn || normalisedEndsOn) {
    const todayKey = userDayKey(new Date(), timezone || DEFAULT_TIMEZONE);
    const endKey = normalisedEndsOn ? dayKeyOfDate(normalisedEndsOn) : null;
    initialCourse = {
      startsOn:
        startsOn ??
        dateOfDayKey(endKey && endKey < todayKey ? endKey : todayKey),
      endsOn: normalisedEndsOn ?? null,
    };
    const refusal = validateCourses(
      [initialCourse],
      todayKey,
      oneShot === true,
    );
    if (refusal) {
      const r = courseRefusalResponse(refusal);
      return {
        refusal: {
          kind: "refused",
          message: r.message,
          status: r.status,
          meta: { errorCode: r.errorCode },
        },
      };
    }
  }
  return { initialCourse };
}

/** One nested schedule row, field-by-field from the parsed input. */
function scheduleCreateData(s: ScheduleInput, oneShot: boolean | undefined) {
  // Invariant 2 — default to FREQ=DAILY when nothing else is set. PRN
  // schedules carry no cadence, so never default them to FREQ=DAILY (they
  // would otherwise project + remind).
  const hasLegacyDays = (s.daysOfWeek?.length ?? 0) > 0;
  const isPrn = s.scheduleType === "PRN";
  const defaultedRrule =
    !oneShot &&
    !isPrn &&
    s.rrule === undefined &&
    s.rollingIntervalDays === undefined &&
    !hasLegacyDays
      ? "FREQ=DAILY"
      : s.rrule;

  // Invariant 3 — dual-write `timesOfDay` from windowStart when the
  // legacy-shape iOS client doesn't send the new field.
  const effectiveTimesOfDay =
    s.timesOfDay && s.timesOfDay.length > 0 ? s.timesOfDay : [s.windowStart];

  return {
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    label: s.label ?? null,
    dose: s.dose ?? null,
    // #219 — per-schedule inventory units. Field-by-field (no mass
    // assignment); absent leaves the column NULL so the consume hook
    // inherits the medication-level units_per_dose.
    ...(s.unitsPerDose !== undefined && {
      unitsPerDose: s.unitsPerDose,
    }),
    daysOfWeek: serializeScheduleRecurrence({
      daysOfWeek: s.daysOfWeek ?? [],
      intervalWeeks: s.intervalWeeks ?? 1,
    }),
    // First-class times-of-day.
    timesOfDay: effectiveTimesOfDay,
    ...(s.reminderGraceMinutes !== undefined && {
      reminderGraceMinutes: s.reminderGraceMinutes,
    }),
    ...(defaultedRrule !== undefined && { rrule: defaultedRrule }),
    ...(s.rollingIntervalDays !== undefined && {
      rollingIntervalDays: s.rollingIntervalDays,
    }),
    // Schedule type + cyclic weeks, field-by-field.
    ...(s.scheduleType !== undefined && {
      scheduleType: s.scheduleType,
    }),
    ...(s.cyclicOnWeeks !== undefined && {
      cyclicOnWeeks: s.cyclicOnWeeks,
    }),
    ...(s.cyclicOffWeeks !== undefined && {
      cyclicOffWeeks: s.cyclicOffWeeks,
    }),
    // Per-dose configurable on-time windows. Stored as the validated
    // `{ timeOfDay, start, end }[]` JSON; absent leaves the column NULL
    // (every slot on the default ±1h derivation).
    ...(s.doseWindows !== undefined && {
      doseWindows: s.doseWindows,
    }),
  };
}

/** The insert itself, field-by-field from the parsed input. */
function insertMedication(
  userId: string,
  data: CreateMedicationInput,
  shape: {
    scheduleInputs: readonly ScheduleInput[];
    normalisedEndsOn: Date | undefined;
    initialCourse: { startsOn: Date; endsOn: Date | null } | null;
  },
) {
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
    notificationsEnabled,
    liveActivityEnabled,
    criticalAlarmEnabled,
    atcCode,
    rxNormCode,
    externalSource,
    externalId,
    startsOn,
    oneShot,
    asNeeded,
    trackIntake,
    autoMarkTaken,
  } = data;
  const { scheduleInputs, normalisedEndsOn, initialCourse } = shape;
  return prisma.medication.create({
    data: {
      userId,
      name,
      dose,
      // treatmentClass + dosesPerUnit are optional in the wire schema; Prisma
      // fills the default GENERIC when omitted.
      ...(treatmentClass !== undefined && { treatmentClass }),
      ...(dosesPerUnit !== undefined && { dosesPerUnit }),
      // Units consumed per dose; Prisma defaults to 1 when omitted.
      ...(unitsPerDose !== undefined && { unitsPerDose }),
      // Optional reorder lead override; null/omitted = inherit the
      // user-level default in the low-stock alert.
      ...(reorderLeadDays !== undefined && { reorderLeadDays }),
      // Route of administration; Prisma defaults to ORAL when omitted.
      ...(deliveryForm !== undefined && { deliveryForm }),
      // Injection-site tracking opt-in + per-medication allowed sites; Prisma
      // defaults to false / [] when omitted.
      ...(trackInjectionSites !== undefined && { trackInjectionSites }),
      ...(allowedInjectionSites !== undefined && { allowedInjectionSites }),
      // iOS reminder flags; Prisma defaults both to false.
      ...(liveActivityEnabled !== undefined && { liveActivityEnabled }),
      ...(criticalAlarmEnabled !== undefined && { criticalAlarmEnabled }),
      // Optional drug-classification codes (ATC / RxNorm). Validated for
      // format by Zod; stored verbatim when present.
      ...(atcCode !== undefined && { atcCode }),
      ...(rxNormCode !== undefined && { rxNormCode }),
      // Mirrored-medication provenance (Apple Health). Zod enforces the
      // both-or-neither pairing; field-by-field like every other column.
      ...(externalSource !== undefined && { externalSource }),
      ...(externalId !== undefined && { externalId }),
      // The wizard's reminders toggle ships through the create payload.
      // Prisma defaults to true when omitted, matching the legacy form's
      // behaviour.
      ...(notificationsEnabled !== undefined && { notificationsEnabled }),
      // Scheduling primitives — pass-through when supplied.
      ...(startsOn !== undefined && { startsOn }),
      ...(normalisedEndsOn !== undefined && { endsOn: normalisedEndsOn }),
      ...(initialCourse && {
        startsOn: initialCourse.startsOn,
        endsOn: initialCourse.endsOn,
        courses: {
          create: {
            userId,
            startsOn: initialCourse.startsOn,
            endsOn: initialCourse.endsOn,
          },
        },
      }),
      ...(oneShot !== undefined && { oneShot }),
      // As-needed flag, field-by-field. An asNeeded create carries an empty
      // `scheduleInputs`, so the nested create below persists zero schedule
      // rows.
      ...(asNeeded !== undefined && { asNeeded }),
      // (#1033) — intake tracking, field-by-field. Created off, the schedule
      // is stored as a record from the start; the column default (true)
      // covers every caller that does not send it.
      ...(trackIntake !== undefined && { trackIntake }),
      // Auto-mark-taken, field-by-field. Created on, the auto-take job fills
      // slots from this moment only.
      ...(autoMarkTaken !== undefined && {
        autoMarkTaken,
        autoMarkTakenSince: autoMarkTaken ? new Date() : null,
      }),
      schedules: {
        create: scheduleInputs.map((s) => scheduleCreateData(s, oneShot)),
      },
    },
    include: { schedules: true },
  });
}

export async function createMedication(input: {
  user: ReadUser;
  data: CreateMedicationInput;
  ipAddress: string | null;
}): Promise<CreateMedicationOutcome> {
  const { user, data } = input;
  const {
    name,
    category,
    externalSource,
    externalId,
    schedules,
    startsOn,
    endsOn,
    oneShot,
  } = data;

  // (#1041) — a custom category must be one of this record's own.
  if (
    category !== undefined &&
    !(await isAssignableCategory(user.id, category))
  ) {
    return {
      kind: "refused",
      message: "Unknown medication category",
      status: 422,
      meta: { errorCode: "medications.category.unknown" },
    };
  }

  if (externalSource !== undefined && externalId !== undefined) {
    const mirror = await existingMirrorOrCap(user, externalSource, externalId);
    if (mirror) return mirror;
  }

  const scheduleInputs = schedules ?? [];
  const oneShotRefusal = refuseOneShotShape(oneShot, scheduleInputs);
  if (oneShotRefusal) return oneShotRefusal;

  // Normalise endsOn for one-shot. Zod gives us `Date | null | undefined`.
  const normalisedEndsOn =
    oneShot === true && startsOn ? startsOn : (endsOn ?? undefined);

  const course = resolveInitialCourse(
    user.timezone,
    startsOn,
    normalisedEndsOn,
    oneShot,
  );
  if ("refusal" in course) return course.refusal;
  const { initialCourse } = course;

  let medication: Awaited<ReturnType<typeof insertMedication>>;
  try {
    medication = await insertMedication(user.id, data, {
      scheduleInputs,
      normalisedEndsOn,
      initialCourse,
    });
  } catch (err: unknown) {
    // P2002 on the mirror triple: a concurrent create of the same
    // `(userId, externalSource, externalId)` won the race between the
    // pre-query above and this insert. Resolve to the winning row and answer
    // idempotently instead of 500-ing. Any other unique violation (there is
    // none on this table today) rethrows.
    const isP2002 =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2002";
    if (isP2002 && externalSource !== undefined && externalId !== undefined) {
      const winner = await prisma.medication.findFirst({
        where: { userId: user.id, externalSource, externalId },
        include: { schedules: { orderBy: MEDICATION_SCHEDULE_ORDER } },
      });
      if (winner) return existingMirrorBody(user, winner);
    }
    throw err;
  }

  await setMedicationCategory(medication.id, category);

  await auditLog("medication.create", {
    userId: user.id,
    ipAddress: input.ipAddress,
    details: {
      medicationId: medication.id,
      name,
      // A medication created with its doses recorded automatically says so
      // in its audit row.
      autoMarkTaken: medication.autoMarkTaken,
    },
  });

  annotate({
    action: {
      name: "medication.create",
      entity_type: "medication",
      entity_id: medication.id,
    },
  });

  // Bust per-user medications + compliance + achievement caches so the next
  // read reflects the new schedule.
  invalidateUserMedications(user.id, { evict: true });

  // The read model, exactly as `GET /api/medications/{id}` answers it.
  const body = await medicationDetail({
    user,
    grantId: null,
    medication,
    announce: false,
  });
  return { kind: "created", body };
}
