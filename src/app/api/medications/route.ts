import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { createMedicationSchema } from "@/lib/validations/medication";
import {
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { getUserTodayBounds } from "@/lib/timezone";
import { NextRequest } from "next/server";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // Compute today's UTC range for event counting
  const userTz = user.timezone || "Europe/Berlin";
  const { start: todayStartUtc, end: todayEndUtc } = getUserTodayBounds(
    new Date(),
    userTz,
  );

  // Run all three queries in parallel
  const [medications, latestIntakes, todayEvents] = await Promise.all([
    prisma.medication.findMany({
      where: { userId: user.id },
      include: { schedules: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.medicationIntakeEvent.groupBy({
      by: ["medicationId"],
      where: {
        userId: user.id,
        skipped: false,
        takenAt: { not: null },
      },
      _max: { takenAt: true },
    }),
    prisma.medicationIntakeEvent.groupBy({
      by: ["medicationId"],
      where: {
        userId: user.id,
        scheduledFor: { gte: todayStartUtc, lte: todayEndUtc },
      },
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

  annotate({
    action: { name: "medication.list" },
    meta: { count: medications.length },
  });

  return apiSuccess(
    medications.map((m) => ({
      ...m,
      // v1.4.25 W4d — `category` is the existing clinical taxonomy
      // (BLOOD_PRESSURE / VITAMIN / ...) from the side-table; the
      // Prisma model has its own `treatmentClass` (GENERIC | GLP1) that
      // spreads through `...m` and unlocks the GLP-1 surfaces. Two
      // orthogonal concepts, both exposed.
      category: categoryMap[m.id] ?? "OTHER",
      lastTakenAt: lastTakenAtByMedicationId[m.id] ?? null,
      todayEventCount: todayEventCountByMedId[m.id] ?? 0,
    })),
  );
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = createMedicationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
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

  return apiSuccess(
    {
      ...medication,
      category: normalizedCategory,
    },
    201,
  );
});
