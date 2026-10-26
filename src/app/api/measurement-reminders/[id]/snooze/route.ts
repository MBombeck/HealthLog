/**
 * v1.37.20 (#223) — push a Vorsorge reminder's current due date back to a
 * named calendar day.
 *
 * Body `{ until: "YYYY-MM-DD" }`, day precision on purpose: the server
 * resolves the day to the reminder's notifyHour in the profile timezone, so
 * no client-supplied instant ever anchors the cadence. Both `snoozedUntil`
 * and `nextDueAt` are set to the SAME resolved instant — every due-state
 * consumer (digest, dashboard card, cron, AI block) moves with it without
 * knowing snooze exists, and the cursor self-expires when the clock passes
 * it. The regular interval is untouched: `lastSatisfiedAt`,
 * `lastSkippedAt` and the anchor stay where they are, so after the snoozed
 * cycle the cadence resumes exactly as configured. Repeated snoozes: the
 * last one wins.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
import { snoozeMeasurementReminderSchema } from "@/lib/validations/measurement-reminders";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

type RouteParams = { params: Promise<{ id: string }> };

/** Furthest a snooze may reach: five years from now. */
const SNOOZE_CAP_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // MANAGE — the same level as satisfy/complete: pushing a due date back
    // re-anchors a schedule this level already admits editing.
    const { user } = await requireRecordAuth("manage", "measurements");
    const { id } = await params;

    const parsed = await parseJsonBody(
      request,
      snoozeMeasurementReminderSchema,
    );
    if (!parsed.ok) return parsed.error;

    // An appointment reminder is not addressable here — see the sibling
    // routes; snoozing one would move a date the visit record still owns.
    const existing = await prisma.measurementReminder.findFirst({
      where: { id, deletedAt: null, origin: { not: "ENCOUNTER" } },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement reminder not found", 404);
    }

    const userRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { timezone: true },
    });
    const timezone = userRow?.timezone || DEFAULT_TIMEZONE;

    // Resolve the named local day to its notifyHour instant in the profile
    // timezone (DST-settled at the target day, not at the request instant).
    const [year, month, day] = parsed.data.until.split("-").map(Number);
    const until = zonedWallClockToUtc(
      { year, month, day, hour: existing.notifyHour, minute: 0, second: 0 },
      timezone,
    );

    // Range gate: at least tomorrow (a snooze to today or the past is a
    // no-op wearing a confirmation), at most five years out.
    const now = new Date();
    const startOfTomorrow = zonedWallClockToUtc(
      (() => {
        const probe = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const parts = new Intl.DateTimeFormat("sv-SE", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .format(probe)
          .split("-")
          .map(Number);
        return {
          year: parts[0],
          month: parts[1],
          day: parts[2],
          hour: 0,
          minute: 0,
          second: 0,
        };
      })(),
      timezone,
    );
    if (until.getTime() < startOfTomorrow.getTime()) {
      return apiError("Snooze date must be at least tomorrow", 422);
    }
    if (until.getTime() > now.getTime() + SNOOZE_CAP_MS) {
      return apiError("Snooze date must be within five years", 422);
    }

    // One write, both cursors, same instant. lastSatisfiedAt/lastSkippedAt
    // and the cadence fields are deliberately untouched.
    await prisma.measurementReminder.update({
      where: { id },
      data: { snoozedUntil: until, nextDueAt: until },
    });

    const updated = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id },
    });

    await auditLog("measurementReminder.snooze", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reminderId: id, until: until.toISOString() },
    });

    annotate({
      action: { name: "measurement-reminders.snooze" },
      meta: { reminderId: id, until: until.toISOString() },
    });

    return apiSuccess({ reminder: toMeasurementReminderDto(updated) });
  },
);
