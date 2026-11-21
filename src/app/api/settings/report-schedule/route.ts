/**
 * `/api/settings/report-schedule` — the scheduled doctor report.
 *
 *   GET    → the schedule (`null` while it is off) and the period the next
 *            run files, from the record's own clock.
 *   PUT    → turn it on or change it: `{ cadence, window }`. A new cadence
 *            starts with no stamp, so the latest closed period of that
 *            cadence is filed on the next hourly run; the same cadence keeps
 *            its stamp, so a period already filed is not filed again.
 *   DELETE → turn it off. Reports already filed stay in the vault.
 *
 * Auth: the caller's own record (`requireActorAuth`), a cookie session or a
 * full token. A schedule is a standing instruction that keeps writing into
 * the vault, so only the person the record is about sets one; a delegate or
 * a guardian inside another record reads and sets their own, like the care
 * calendar subscription. Turning it on needs the `doctorReport` module; the
 * job checks it again, with the vault's module, on every run.
 */
import { NextRequest } from "next/server";

import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma, toJson } from "@/lib/db";
import { latestClosedPeriod } from "@/lib/doctor-report/schedule";
import {
  parseReportSchedule,
  type ReportSchedule,
} from "@/lib/doctor-report/schedule-shape";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { reportSchedulePutSchema } from "@/lib/validations/report-schedule";

export const dynamic = "force-dynamic";

async function readSchedule(userId: string): Promise<ReportSchedule | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { reportScheduleJson: true },
  });
  return parseReportSchedule(row?.reportScheduleJson);
}

/** The wire view: the stored schedule and the period the next run files. */
async function view(userId: string, schedule: ReportSchedule | null) {
  if (!schedule) return { schedule: null };
  const tz = await resolveUserTimezone(userId);
  const due = latestClosedPeriod(schedule.cadence, new Date(), tz);
  return {
    schedule: {
      cadence: schedule.cadence,
      window: schedule.window,
      lastPeriod: schedule.lastPeriod,
      lastOutcome: schedule.lastOutcome,
      lastRunAt: schedule.lastRunAt,
      // The period the next run files, or null when it is already filed.
      duePeriod: schedule.lastPeriod === due.key ? null : due.key,
    },
  };
}

export const GET = apiHandler(async () => {
  const { user } = await requireActorAuth();
  annotate({ action: { name: "settings.report-schedule.read" } });
  return apiSuccess(await view(user.id, await readSchedule(user.id)));
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireActorAuth();
  const gate = await requireModuleEnabled(user.id, "doctorReport");
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, reportSchedulePutSchema, {
    maxBytes: 1024,
    action: "settings.report-schedule.validation-failed",
  });
  if (!parsed.ok) return parsed.error;
  const { cadence, window } = parsed.data;

  const stored = await readSchedule(user.id);
  const sameCadence = stored?.cadence === cadence;
  const next: ReportSchedule = {
    v: 1,
    cadence,
    window,
    lastPeriod: sameCadence ? stored.lastPeriod : null,
    lastOutcome: sameCadence ? stored.lastOutcome : null,
    lastRunAt: sameCadence ? stored.lastRunAt : null,
  };
  await prisma.user.update({
    where: { id: user.id },
    data: { reportScheduleJson: toJson(next) },
  });
  await auditLog("report-schedule.set", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { cadence, window },
  });
  annotate({
    action: { name: "settings.report-schedule.set" },
    meta: { cadence, window, cadence_changed: !sameCadence },
  });
  return apiSuccess(await view(user.id, next));
});

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireActorAuth();
  await prisma.user.update({
    where: { id: user.id },
    data: { reportScheduleJson: Prisma.DbNull },
  });
  await auditLog("report-schedule.off", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });
  annotate({ action: { name: "settings.report-schedule.off" } });
  return apiSuccess({ schedule: null });
});
