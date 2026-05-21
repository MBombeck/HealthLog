import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { createMedicationSchema } from "@/lib/validations/medication";
import {
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { getUserTodayBounds } from "@/lib/timezone";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { NextRequest } from "next/server";

type MedicationsListResult = Array<Record<string, unknown>>;

async function buildMedicationsList(
  userId: string,
  userTz: string,
): Promise<MedicationsListResult> {
  const { start: todayStartUtc, end: todayEndUtc } = getUserTodayBounds(
    new Date(),
    userTz,
  );

  const [medications, latestIntakes, todayEvents] = await Promise.all([
    prisma.medication.findMany({
      where: { userId },
      include: { schedules: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.medicationIntakeEvent.groupBy({
      by: ["medicationId"],
      where: { userId, skipped: false, takenAt: { not: null } },
      _max: { takenAt: true },
    }),
    prisma.medicationIntakeEvent.groupBy({
      by: ["medicationId"],
      where: { userId, scheduledFor: { gte: todayStartUtc, lte: todayEndUtc } },
      _count: { id: true },
    }),
  ]);

  const lastTakenAtByMedicationId = Object.fromEntries(
    latestIntakes.map((entry) => [
      entry.medicationId,
      entry._max.takenAt ? entry._max.takenAt.toISOString() : null,
    ]),
  );
  const todayEventCountByMedId = Object.fromEntries(
    todayEvents.map(
      (entry: { medicationId: string; _count: { id: number } }) => [
        entry.medicationId,
        entry._count.id,
      ],
    ),
  );

  let categoryMap: Record<string, string> = {};
  try {
    categoryMap = await getMedicationCategories(medications.map((m) => m.id));
  } catch {
    getEvent()?.addWarning("Medication categories could not be loaded");
  }

  return medications.map((m) => ({
    ...m,
    category: categoryMap[m.id] ?? "OTHER",
    lastTakenAt: lastTakenAtByMedicationId[m.id] ?? null,
    todayEventCount: todayEventCountByMedId[m.id] ?? 0,
  }));
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const userTz = user.timezone || "Europe/Berlin";

  // Cache the list shape on userId. The 60s TTL bounds the cross-midnight
  // staleness window for `todayEventCount` (the only time-of-day-derived
  // field in the response); writes via POST/PUT/DELETE flush through
  // `invalidateUserMedications` before the next read lands.
  const result = await cached(
    caches.medications as ServerCache<MedicationsListResult>,
    user.id,
    () => buildMedicationsList(user.id, userTz),
    annotate,
  );

  annotate({
    action: { name: "medication.list" },
    meta: { count: result.length },
  });

  return apiSuccess(result);
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = createMedicationSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  const { name, dose, category, treatmentClass, dosesPerUnit, schedules } =
    parsed.data;

  const medication = await prisma.medication.create({
    data: {
      userId: user.id,
      name,
      dose,
      // v1.4.25 W4d — treatmentClass + dosesPerUnit are optional in the
      // wire schema; Prisma fills the default GENERIC when omitted.
      ...(treatmentClass !== undefined && { treatmentClass }),
      ...(dosesPerUnit !== undefined && { dosesPerUnit }),
      schedules: {
        create: schedules.map((s) => ({
          windowStart: s.windowStart,
          windowEnd: s.windowEnd,
          label: s.label ?? null,
          dose: s.dose ?? null,
          daysOfWeek: serializeScheduleRecurrence({
            daysOfWeek: s.daysOfWeek ?? [],
            intervalWeeks: s.intervalWeeks ?? 1,
          }),
        })),
      },
    },
    include: { schedules: true },
  });

  const normalizedCategory = await setMedicationCategory(
    medication.id,
    category,
  );

  await auditLog("medication.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { medicationId: medication.id, name },
  });

  annotate({
    action: {
      name: "medication.create",
      entity_type: "medication",
      entity_id: medication.id,
    },
  });

  // v1.4.34 IW-G — bust per-user medications + compliance + achievement
  // caches so the next read reflects the new schedule.
  invalidateUserMedications(user.id);

  return apiSuccess(
    {
      ...medication,
      category: normalizedCategory,
    },
    201,
  );
});
