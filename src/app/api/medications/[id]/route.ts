import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { updateMedicationSchema } from "@/lib/validations/medication";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  deleteMedicationCategory,
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { computeNextDueAt } from "@/lib/medications/scheduling/next-due";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const medication = await prisma.medication.findUnique({
      where: { id },
      include: { schedules: true },
    });

    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    let category = "OTHER";
    try {
      const categories = await getMedicationCategories([id]);
      category = categories[id] ?? "OTHER";
    } catch {
      // Category enrichment is optional
    }

    // v1.7.0 SB-SCHED-3 — server-computed next due instant. Rolling
    // cadences re-anchor on the latest non-skipped intake, so fetch it
    // once (no-op for calendar cadences but cheap + keeps the value
    // correct for rolling injections).
    const lastIntake =
      medication.schedules.some((s) => s.rollingIntervalDays !== null)
        ? await prisma.medicationIntakeEvent.findFirst({
            // v1.7.0 sync — a tombstoned intake no longer anchors the
            // rolling-interval next-due computation.
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
    const nextDue = computeNextDueAt({
      medication: {
        id: medication.id,
        startsOn: medication.startsOn,
        endsOn: medication.endsOn,
        oneShot: medication.oneShot,
        createdAt: medication.createdAt,
      },
      schedules: medication.schedules,
      now: new Date(),
      userTz: user.timezone || "Europe/Berlin",
      lastIntakeAt: lastIntake?.takenAt ?? null,
    });

    annotate({
      action: {
        name: "medication.get",
        entity_type: "medication",
        entity_id: id,
      },
    });

    return apiSuccess({
      ...medication,
      category,
      nextDueAt: nextDue ? nextDue.toISOString() : null,
    });
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.5.5 C-E3-3 — route ownership check through the shared helper
    // so the 404 leak shape stays identical across every
    // `[id]/**` handler. The PUT branch still needs `existing.active`
    // for the pausedAt-derivation step below, so re-read the narrow
    // field after the guard passes.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;
    const existing = await prisma.medication.findUnique({
      where: { id },
      select: { active: true },
    });
    if (!existing) {
      return apiError("Medication not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
    const parsed = updateMedicationSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
    }

    const {
      name,
      dose,
      category,
      treatmentClass,
      dosesPerUnit,
      deliveryForm,
      active,
      notificationsEnabled,
      liveActivityEnabled,
      criticalAlarmEnabled,
      schedules,
      startsOn,
      endsOn,
      oneShot,
      reminderGraceMinutes: topLevelGraceMinutes,
    } = parsed.data;

    // ── v1.5.5 — primary-schedule grace bridge ──────────────────────
    //
    // The detail-page settings section saves the reminder-window in
    // one PUT carrying only `{ reminderGraceMinutes }` at the top
    // level (no full `schedules` array). Map it onto the medication's
    // primary schedule before the Prisma update so the persisted
    // shape stays per-schedule and the engine reads it from the same
    // column as the wizard write-path. A full `schedules` array on
    // the same request takes precedence — the wizard already declares
    // the grace per row and we never want to overwrite that intent.
    let primaryScheduleGracePatch: {
      scheduleId: string;
      reminderGraceMinutes: number | null;
    } | null = null;
    if (topLevelGraceMinutes !== undefined && !schedules) {
      const primary = await prisma.medicationSchedule.findFirst({
        where: { medicationId: id },
        orderBy: { windowStart: "asc" },
        select: { id: true },
      });
      if (primary) {
        primaryScheduleGracePatch = {
          scheduleId: primary.id,
          reminderGraceMinutes: topLevelGraceMinutes,
        };
      }
    }

    // ── v1.5 route invariants for the new scheduling primitives ─────
    //
    // Mirrors the POST route: oneShot ⇒ at-most-one schedule + no
    // recurrence on it; endsOn normalised to startsOn for one-shot;
    // recurring default = FREQ=DAILY when nothing else is set;
    // timesOfDay dual-write from windowStart when absent.
    //
    // The PUT replaces all schedules wholesale, so the invariants run
    // against the incoming `schedules` array (if provided) the same
    // way they do on create.
    if (oneShot === true && schedules) {
      if (schedules.length > 1) {
        return apiError(
          "A one-shot medication can have at most one schedule",
          422,
        );
      }
      const s = schedules[0];
      if (s && (s.rrule !== undefined || s.rollingIntervalDays !== undefined)) {
        return apiError(
          "A one-shot medication cannot have a recurrence (rrule or rollingIntervalDays)",
          422,
        );
      }
    }

    // Normalise endsOn for one-shot. `oneShot === true` + `startsOn`
    // means the dose is the start date; endsOn auto-matches.
    const normalisedEndsOn =
      oneShot === true && startsOn ? startsOn : endsOn;

    const pausedAtPatch =
      active === undefined
        ? {}
        : active
          ? { pausedAt: null as Date | null }
          : existing.active
            ? { pausedAt: new Date() }
            : {};

    // If schedules provided, replace all
    if (schedules) {
      await prisma.medicationSchedule.deleteMany({
        where: { medicationId: id },
      });
    }

    const baseUpdateData = {
      ...(name !== undefined && { name }),
      ...(dose !== undefined && { dose }),
      ...(treatmentClass !== undefined && { treatmentClass }),
      ...(dosesPerUnit !== undefined && { dosesPerUnit }),
      ...(deliveryForm !== undefined && { deliveryForm }),
      ...(active !== undefined && { active }),
      ...(notificationsEnabled !== undefined && { notificationsEnabled }),
      // v1.7.0 — iOS reminder flags, field-by-field.
      ...(liveActivityEnabled !== undefined && { liveActivityEnabled }),
      ...(criticalAlarmEnabled !== undefined && { criticalAlarmEnabled }),
      // v1.5 scheduling primitives — pass-through when supplied.
      // `startsOn` / `endsOn` are `Date | null | undefined` (the
      // schema lets the user clear them explicitly with null).
      ...(startsOn !== undefined && { startsOn }),
      ...(normalisedEndsOn !== undefined && { endsOn: normalisedEndsOn }),
      ...(oneShot !== undefined && { oneShot }),
      ...(schedules && {
        schedules: {
          create: schedules.map((s) => {
            // Invariant 2 — default to FREQ=DAILY when nothing else is set.
            // v1.7.0 — PRN carries no cadence, so never default it.
            const hasLegacyDays = (s.daysOfWeek?.length ?? 0) > 0;
            const isPrn = s.scheduleType === "PRN";
            const defaultedRrule =
              oneShot !== true &&
              !isPrn &&
              s.rrule === undefined &&
              s.rollingIntervalDays === undefined &&
              !hasLegacyDays
                ? "FREQ=DAILY"
                : s.rrule;

            // Invariant 3 — dual-write timesOfDay from windowStart.
            const effectiveTimesOfDay =
              s.timesOfDay && s.timesOfDay.length > 0
                ? s.timesOfDay
                : [s.windowStart];

            return {
              windowStart: s.windowStart,
              windowEnd: s.windowEnd,
              label: s.label ?? null,
              dose: s.dose ?? null,
              daysOfWeek: serializeScheduleRecurrence({
                daysOfWeek: s.daysOfWeek ?? [],
                intervalWeeks: s.intervalWeeks ?? 1,
              }),
              // v1.5 first-class times-of-day.
              timesOfDay: effectiveTimesOfDay,
              ...(s.reminderGraceMinutes !== undefined && {
                reminderGraceMinutes: s.reminderGraceMinutes,
              }),
              ...(defaultedRrule !== undefined && { rrule: defaultedRrule }),
              ...(s.rollingIntervalDays !== undefined && {
                rollingIntervalDays: s.rollingIntervalDays,
              }),
              // v1.7.0 — schedule type + cyclic weeks, field-by-field.
              ...(s.scheduleType !== undefined && {
                scheduleType: s.scheduleType,
              }),
              ...(s.cyclicOnWeeks !== undefined && {
                cyclicOnWeeks: s.cyclicOnWeeks,
              }),
              ...(s.cyclicOffWeeks !== undefined && {
                cyclicOffWeeks: s.cyclicOffWeeks,
              }),
            };
          }),
        },
      }),
    };

    const withoutNotifications = { ...baseUpdateData } as Record<
      string,
      unknown
    >;
    delete withoutNotifications.notificationsEnabled;
    const hasPausedAtPatch = Object.keys(pausedAtPatch).length > 0;
    const hasNotificationsPatch = notificationsEnabled !== undefined;

    const updateCandidates: Array<Record<string, unknown>> = [
      { ...baseUpdateData, ...pausedAtPatch },
    ];
    if (hasPausedAtPatch) {
      updateCandidates.push(baseUpdateData);
    }
    if (hasNotificationsPatch) {
      updateCandidates.push({ ...withoutNotifications, ...pausedAtPatch });
      if (hasPausedAtPatch) {
        updateCandidates.push(withoutNotifications);
      }
    }

    let medication;
    let lastUpdateErr: unknown;
    for (const candidate of updateCandidates) {
      try {
        medication = await prisma.medication.update({
          where: { id },
          data: candidate,
          include: { schedules: true },
        });
        break;
      } catch (updateErr) {
        lastUpdateErr = updateErr;
      }
    }
    if (!medication) throw lastUpdateErr;

    // Apply the v1.5.5 primary-schedule grace bridge after the
    // medication update so a failure here doesn't roll the medication
    // edit back. Re-read the row so the response shape carries the
    // converged grace value.
    if (primaryScheduleGracePatch) {
      await prisma.medicationSchedule.update({
        where: { id: primaryScheduleGracePatch.scheduleId },
        data: {
          reminderGraceMinutes:
            primaryScheduleGracePatch.reminderGraceMinutes,
        },
      });
      const refreshed = await prisma.medication.findUnique({
        where: { id },
        include: { schedules: true },
      });
      if (refreshed) {
        medication = refreshed;
      }
    }

    const normalizedCategory =
      category !== undefined
        ? await setMedicationCategory(id, category)
        : ((await getMedicationCategories([id]))[id] ?? "OTHER");

    await auditLog("medication.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id },
    });

    annotate({
      action: {
        name: "medication.update",
        entity_type: "medication",
        entity_id: id,
      },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the schedule change.
    invalidateUserMedications(user.id);

    return apiSuccess({
      ...medication,
      category: normalizedCategory,
    });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.5.5 C-E3-3 — ownership via the shared helper. The DELETE
    // branch needs the medication name for the audit-row detail; pull
    // it after the guard passes.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;
    const existing = await prisma.medication.findUnique({
      where: { id },
      select: { name: true },
    });
    if (!existing) {
      return apiError("Medication not found", 404);
    }

    // Revoke API tokens scoped to this medication
    const medicationScope = `medication:${id}:ingest`;
    await prisma.apiToken.updateMany({
      where: {
        userId: user.id,
        revoked: false,
        permissions: { has: medicationScope },
      },
      data: { revoked: true },
    });

    await deleteMedicationCategory(id);
    await prisma.medication.delete({ where: { id } });

    await auditLog("medication.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, name: existing.name },
    });

    annotate({
      action: {
        name: "medication.delete",
        entity_type: "medication",
        entity_id: id,
      },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the deletion.
    invalidateUserMedications(user.id);

    return apiSuccess({ deleted: true });
  },
);
