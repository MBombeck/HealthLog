/**
 * v1.17.1 — Vorsorge (measurement) reminders CRUD: list + create.
 *
 * Server-authoritative `nextDueAt` is computed via the canonical
 * medication recurrence engine so web ↔ iOS read identical numbers.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, getClientIp, sanitiseZodIssues } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { createMeasurementReminderSchema } from "@/lib/validations/measurement-reminders";
import {
  computeReminderNextDueAt,
  parseReminderAnchor,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
import { listMeasurementReminders } from "@/lib/measurement-reminders/list-read";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

async function resolveTimezone(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return row?.timezone || DEFAULT_TIMEZONE;
}

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "measurements");

  // The query (with its ENCOUNTER-origin exclusion) lives in the shared
  // list read so this route and the `/checkups` SSR prefetch cannot drift.
  const reminders = await listMeasurementReminders(user.id);

  annotate({
    action: { name: "measurement-reminders.list" },
    meta: { total: reminders.length },
  });

  return apiSuccess(reminders);
});

async function postReminder(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. A reminder armed by a manager rings the record's own
  // phone, which is the person the reminder is about, and it is additive: the
  // row is listed, editable and removable by the owner.
  const { user } = await requireRecordAuth("manage", "measurements");

  const parsed = await parseJsonBody(request, createMeasurementReminderSchema, {
    maxBytes: 16 * 1024,
    action: "measurement-reminders.create.validation-failed",
    countIssues: true,
    onInvalid: (error) => {
      const auditIssues = sanitiseZodIssues(error.issues, {
        stripValuesFromMessage: true,
      });
      // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
      // .create`, because that helper is the only writer that stamps
      // `actorUserId`. Filed under the resolved record either way; without the
      // stamp a manager's malformed payload would read as the owner's own.
      void auditLog("measurement-reminders.create.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
    },
  });
  if (!parsed.ok) return parsed.error;

  const data = parsed.data;

  const timezone = await resolveTimezone(user.id);
  const now = new Date();
  const anchorDate =
    data.anchorDate != null
      ? parseReminderAnchor(data.anchorDate, timezone)
      : null;

  // Server-authoritative next-due. No satisfy yet → anchors on
  // anchorDate ?? createdAt (createdAt ≈ now for a fresh row).
  const scheduleInput: ReminderScheduleInput = {
    intervalDays: data.intervalDays ?? null,
    rrule: data.rrule ?? null,
    anchorDate,
    notifyHour: data.notifyHour,
    lastSatisfiedAt: null,
    createdAt: now,
  };
  const nextDueAt = computeReminderNextDueAt(scheduleInput, timezone, now);

  // Field-by-field — no mass assignment.
  const created = await prisma.measurementReminder.create({
    data: {
      userId: user.id,
      label: data.label,
      measurementType: data.measurementType ?? null,
      intervalDays: data.intervalDays ?? null,
      rrule: data.rrule ?? null,
      anchorDate,
      notifyHour: data.notifyHour,
      location: data.location ?? null,
      enabled: data.enabled,
      nextDueAt,
    },
  });

  await auditLog("measurementReminder.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { reminderId: created.id },
  });

  annotate({
    action: { name: "measurement-reminders.create" },
    meta: { reminderId: created.id, hasType: data.measurementType != null },
  });

  return apiSuccess(toMeasurementReminderDto(created), 201);
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postReminder));
