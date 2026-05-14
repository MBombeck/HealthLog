/**
 * Top-level medication-intake aggregator + writer.
 *
 *   GET  /api/medications/intake?scope=today
 *     → array of today's intake events for the user (across medications).
 *
 *   GET  /api/medications/intake?scope=compliance&days=N
 *     → per-day { date, scheduled, taken } for the last N days.
 *
 *   POST /api/medications/intake
 *     Body: { intakeId, status: "taken" | "skipped" | "snoozed", takenAt?, snoozedUntil? }
 *     Updates the named MedicationIntakeEvent and returns the updated row.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/resolver";

const querySchema = z.object({
  scope: z.enum(["today", "compliance"]),
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const updateSchema = z.object({
  intakeId: z.string().min(1),
  status: z.enum(["taken", "skipped", "snoozed"]),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  snoozedUntil: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
});

function startOfDayInTz(date: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { scope, days } = parsed.data;

  // v1.4.25 W7b — anchor "today" and per-day compliance buckets to the
  // user's display timezone so a 23:30 reading in Pacific/Auckland lands
  // in today's bucket rather than yesterday's Berlin one.
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;

  if (scope === "today") {
    const todayStart = startOfDayInTz(new Date(), userTz);
    const todayEnd = new Date(todayStart.getTime() + 86_400_000);
    const events = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        scheduledFor: { gte: todayStart, lt: todayEnd },
      },
      orderBy: { scheduledFor: "asc" },
      include: { medication: { select: { id: true, snoozedUntil: true } } },
    });

    annotate({
      action: { name: "medications.intake.today" },
      meta: { count: events.length },
    });

    return apiSuccess(
      events.map((e) => ({
        id: e.id,
        medicationId: e.medicationId,
        scheduledAt: e.scheduledFor.toISOString(),
        takenAt: e.takenAt?.toISOString() ?? null,
        status: e.skipped
          ? "skipped"
          : e.takenAt
            ? "taken"
            : e.medication.snoozedUntil &&
                e.medication.snoozedUntil > new Date()
              ? "snoozed"
              : "pending",
        snoozedUntil: e.medication.snoozedUntil?.toISOString() ?? null,
      })),
    );
  }

  // compliance: per-day scheduled vs taken for the last N days
  const start = new Date(Date.now() - days * 86_400_000);
  const events = await prisma.medicationIntakeEvent.findMany({
    where: { userId: user.id, scheduledFor: { gte: start } },
    select: { scheduledFor: true, takenAt: true, skipped: true },
  });

  const buckets = new Map<string, { scheduled: number; taken: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    buckets.set(userDayKey(d, userTz), { scheduled: 0, taken: 0 });
  }
  for (const e of events) {
    const key = userDayKey(e.scheduledFor, userTz);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.scheduled += 1;
    if (e.takenAt && !e.skipped) bucket.taken += 1;
  }

  const result = [...buckets.entries()]
    .map(([date, v]) => ({ date, scheduled: v.scheduled, taken: v.taken }))
    .sort((a, b) => a.date.localeCompare(b.date));

  annotate({
    action: { name: "medications.intake.compliance" },
    meta: { days, count: result.length },
  });

  return apiSuccess(result);
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error } = await safeJson(request);
  if (error) return error;

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { intakeId, status, takenAt, snoozedUntil } = parsed.data;

  const existing = await prisma.medicationIntakeEvent.findUnique({
    where: { id: intakeId },
  });
  if (!existing || existing.userId !== user.id) {
    return apiError("Intake event not found", 404);
  }

  let updated;
  if (status === "taken") {
    [updated] = await prisma.$transaction([
      prisma.medicationIntakeEvent.update({
        where: { id: intakeId },
        data: { takenAt: takenAt ?? new Date(), skipped: false },
      }),
      prisma.medication.update({
        where: { id: existing.medicationId },
        data: { snoozedUntil: null },
      }),
    ]);
  } else if (status === "skipped") {
    updated = await prisma.medicationIntakeEvent.update({
      where: { id: intakeId },
      data: { takenAt: null, skipped: true },
    });
  } else {
    // snoozed: snoozedUntil lives on the Medication row.
    const until = snoozedUntil ?? new Date(Date.now() + 30 * 60_000); // default +30min
    await prisma.medication.update({
      where: { id: existing.medicationId },
      data: { snoozedUntil: until },
    });
    updated = await prisma.medicationIntakeEvent.findUnique({
      where: { id: intakeId },
    });
  }

  await auditLog("medications.intake.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { intakeId, status },
  });

  annotate({
    action: { name: "medications.intake.update" },
    meta: { intakeId, status },
  });

  return apiSuccess(updated);
});
