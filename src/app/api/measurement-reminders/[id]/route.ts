/**
 * v1.17.1 — Vorsorge (measurement) reminder by id: get + patch + delete.
 *
 * PATCH re-derives the server-authoritative `nextDueAt` when the edit
 * changes when the reminder recurs (interval, rule, anchor, or re-enabling
 * it); a notify-hour edit moves the hour on the same due day, and any other
 * edit leaves the due date alone. DELETE removes the row; the
 * confirmation dialog says the reminder is permanently deleted, and nothing
 * here needs a tombstone to keep that promise honest.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { updateMeasurementReminderSchema } from "@/lib/validations/measurement-reminders";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
import { wallClockInTz, zonedWallClockToUtc } from "@/lib/tz/wall-clock";

type RouteParams = { params: Promise<{ id: string }> };

const DEFAULT_TIMEZONE = "Europe/Berlin";

async function resolveTimezone(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return row?.timezone || DEFAULT_TIMEZONE;
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "measurements");
    const { id } = await params;

    // An appointment reminder is not addressable here. It belongs to a visit,
    // is managed through the visit routes, and sits in a different sharing
    // domain — so this family treats one as not found rather than acting on
    // it. Filtering in the lookup rather than after it is what keeps a write
    // from committing before the refusal.
    const reminder = await prisma.measurementReminder.findFirst({
      where: { id, deletedAt: null, origin: { not: "ENCOUNTER" } },
    });
    if (!reminder || reminder.userId !== user.id) {
      return apiError("Measurement reminder not found", 404);
    }

    annotate({
      action: { name: "measurement-reminders.get" },
      meta: { reminderId: id },
    });

    return apiSuccess(toMeasurementReminderDto(reminder));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Editing a reminder re-anchors when the record's own
    // phone rings, which is management of the schedule the level admits.
    const { user } = await requireRecordAuth("manage", "measurements");
    const { id } = await params;

    // An appointment reminder is not addressable here. It belongs to a visit,
    // is managed through the visit routes, and sits in a different sharing
    // domain — so this family treats one as not found rather than acting on
    // it. Filtering in the lookup rather than after it is what keeps a write
    // from committing before the refusal.
    const existing = await prisma.measurementReminder.findFirst({
      where: { id, deletedAt: null, origin: { not: "ENCOUNTER" } },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement reminder not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = updateMeasurementReminderSchema.safeParse(body);
    if (!parsed.success) {
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "measurement-reminders.update.validation-failed" },
        meta: { issue_count: issues.length, reminderId: id },
      });
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
      // .create`, because that helper is the only writer that stamps
      // `actorUserId`. Filed under the resolved record either way; without the
      // stamp a manager's malformed payload would read as the owner's own.
      void auditLog("measurement-reminders.update.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues, reminderId: id },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
      return returnAllZodIssues(parsed.error, 422);
    }

    const data = parsed.data;

    // Field-by-field — no mass assignment.
    const updateData: Record<string, unknown> = {};
    if (data.label !== undefined) updateData.label = data.label;
    if (data.measurementType !== undefined) {
      updateData.measurementType = data.measurementType;
    }
    if (data.intervalDays !== undefined) {
      updateData.intervalDays = data.intervalDays;
      // Setting one cadence clears the other so the engine reads exactly
      // one dispatch family.
      if (data.intervalDays !== null && data.rrule === undefined) {
        updateData.rrule = null;
      }
    }
    if (data.rrule !== undefined) {
      updateData.rrule = data.rrule;
      if (data.rrule !== null && data.intervalDays === undefined) {
        updateData.intervalDays = null;
      }
    }
    if (data.anchorDate !== undefined) {
      updateData.anchorDate =
        data.anchorDate != null ? new Date(data.anchorDate) : null;
    }
    if (data.notifyHour !== undefined) updateData.notifyHour = data.notifyHour;
    if (data.location !== undefined) updateData.location = data.location;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;

    // Recompute next-due against the merged cadence. Floor the search at
    // the last-satisfied instant (or now) so a cadence edit re-anchors
    // cleanly off the user's last fulfilment.
    //
    // v1.32.1 — `Object.hasOwn(updateData, field)` replaces a `?? existing`
    // fallback here (issue #62). `??` cannot tell an explicit `null` clear
    // apart from an omitted field — both are nullish — so a PATCH that
    // cleared `intervalDays` to switch a reminder onto an RRULE still
    // recomputed `nextDueAt` against the OLD rolling interval for one
    // cycle (rolling cadence wins the dispatcher's precedence order, so the
    // stale interval silently overrode the just-set RRULE). The same gap
    // hit the RRULE → interval direction and an explicit `anchorDate: null`
    // clear. `updateData` already encodes the field-by-field truth of what
    // is ACTUALLY being persisted — including the mutual-exclusivity
    // auto-clear a few lines up — so keying off its own keys (present, even
    // when the value is `null`) can never diverge from what the database
    // ends up holding.
    const timezone = await resolveTimezone(user.id);
    const now = new Date();
    const merged: ReminderScheduleInput = {
      intervalDays: Object.hasOwn(updateData, "intervalDays")
        ? (updateData.intervalDays as number | null)
        : existing.intervalDays,
      rrule: Object.hasOwn(updateData, "rrule")
        ? (updateData.rrule as string | null)
        : existing.rrule,
      anchorDate: Object.hasOwn(updateData, "anchorDate")
        ? (updateData.anchorDate as Date | null)
        : existing.anchorDate,
      notifyHour: Object.hasOwn(updateData, "notifyHour")
        ? (updateData.notifyHour as number)
        : existing.notifyHour,
      lastSatisfiedAt: existing.lastSatisfiedAt,
      createdAt: existing.createdAt,
      // v1.18.1 — preserve the course window so an edit of a finite
      // (Coach-suggested) cadence keeps self-expiring.
      endsOn: existing.endsOn,
    };
    // v1.39.2 — only an edit to WHEN the reminder recurs reschedules it. A
    // label, location or type edit used to recompute too, and since the
    // recompute searches strictly after now, correcting the label of an
    // open, overdue check-up quietly moved it to its next slot. Compared by
    // value, because the edit forms resend every field on each save.
    const sameInstant = (a: Date | null, b: Date | null) =>
      (a?.getTime() ?? null) === (b?.getTime() ?? null);
    const cadenceChanged =
      merged.intervalDays !== existing.intervalDays ||
      merged.rrule !== existing.rrule ||
      !sameInstant(merged.anchorDate, existing.anchorDate) ||
      (updateData.enabled === true && !existing.enabled);
    if (cadenceChanged) {
      const after =
        existing.lastSatisfiedAt && existing.lastSatisfiedAt > now
          ? existing.lastSatisfiedAt
          : now;
      updateData.nextDueAt = computeReminderNextDueAt(merged, timezone, after);
      // v1.37.20 (#223) — a cadence edit recomputes `nextDueAt`, so it clears
      // the snooze cursor: the cycle the snooze pushed back no longer exists.
      updateData.snoozedUntil = null;
    } else if (
      merged.notifyHour !== existing.notifyHour &&
      existing.nextDueAt !== null
    ) {
      // A new notify hour keeps the due DAY and moves the hour on it, so an
      // open slot stays open. A snooze pinned to that same slot moves with it.
      const day = wallClockInTz(existing.nextDueAt, timezone);
      const moved = zonedWallClockToUtc(
        {
          year: day.year,
          month: day.month,
          day: day.day,
          hour: merged.notifyHour,
          minute: 0,
          second: 0,
        },
        timezone,
      );
      updateData.nextDueAt = moved;
      if (sameInstant(existing.snoozedUntil, existing.nextDueAt)) {
        updateData.snoozedUntil = moved;
      }
    }

    const updated = await prisma.measurementReminder.update({
      where: { id },
      data: updateData,
    });

    await auditLog("measurementReminder.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C4 — what the edit replaced. A cadence change moves when somebody's
      // phone rings; the feed has to be able to say what it used to be.
      details: {
        reminderId: id,
        ...overwriteDetails({
          before: {
            label: existing.label,
            measurementType: existing.measurementType,
            intervalDays: existing.intervalDays,
            rrule: existing.rrule,
            anchorDate: existing.anchorDate,
            notifyHour: existing.notifyHour,
            enabled: existing.enabled,
            nextDueAt: existing.nextDueAt,
          },
          after: {
            label: updated.label,
            measurementType: updated.measurementType,
            intervalDays: updated.intervalDays,
            rrule: updated.rrule,
            anchorDate: updated.anchorDate,
            notifyHour: updated.notifyHour,
            enabled: updated.enabled,
            nextDueAt: updated.nextDueAt,
          },
        }),
      },
    });

    annotate({
      action: { name: "measurement-reminders.update" },
      meta: { reminderId: id },
    });

    return apiSuccess(toMeasurementReminderDto(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE, and the one verb in this family that destroys without
    // a tombstone: the row goes, so the audit row below is the only thing left
    // that knows what it was for.
    const { user } = await requireRecordAuth("manage", "measurements");
    const { id } = await params;

    // An appointment reminder is not addressable here. It belongs to a visit,
    // is managed through the visit routes, and sits in a different sharing
    // domain — so this family treats one as not found rather than acting on
    // it. Filtering in the lookup rather than after it is what keeps a write
    // from committing before the refusal.
    // `findFirst` rather than `findUnique`: the origin is not part of any
    // unique key, so the predicate cannot ride a unique lookup.
    const existing = await prisma.measurementReminder.findFirst({
      where: { id, origin: { not: "ENCOUNTER" } },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement reminder not found", 404);
    }

    // Hard delete. The confirmation says "permanently deleted", and this row
    // has nothing that a tombstone would serve: it is not in the
    // `/api/sync/changes` delta feed, no restore route reaches it, no other
    // table references it, and every read already filters `deletedAt: null`.
    // The tombstone bought parity with tables that need one and cost the
    // dialog its accuracy, so the row goes.
    await prisma.measurementReminder.delete({ where: { id } });

    await auditLog("measurementReminder.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C3 — a hard delete, so the details carry the identity of what went:
      // the label the owner wrote, what it watched, when it was next due. An
      // id alone would say a preventive-care recall disappeared and never say
      // what it was for.
      details: {
        reminderId: id,
        ...destroyedDetails({
          model: "MeasurementReminder",
          id,
          label: existing.label,
          effectiveAt: existing.nextDueAt,
          extra: {
            measurementType: existing.measurementType,
            intervalDays: existing.intervalDays,
            rrule: existing.rrule,
            origin: existing.origin,
          },
        }),
      },
    });

    annotate({
      action: { name: "measurement-reminders.delete" },
      meta: { reminderId: id },
    });

    return apiSuccess({ deleted: true });
  },
);
