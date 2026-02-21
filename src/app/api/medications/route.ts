import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { createMedicationSchema } from "@/lib/validations/medication";
import {
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { NextRequest } from "next/server";

export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    // Compute today's UTC range for event counting
    const userTz = sessionData.user.timezone || "Europe/Berlin";
    const nowLocal = new Date(
      new Date().toLocaleString("en-US", { timeZone: userTz }),
    );
    const localMidnight = new Date(nowLocal);
    localMidnight.setHours(0, 0, 0, 0);
    const offsetMs =
      Math.round((nowLocal.getTime() - new Date().getTime()) / 60000) * 60000;
    const todayStartUtc = new Date(localMidnight.getTime() - offsetMs);
    const todayEndUtc = new Date(
      todayStartUtc.getTime() + 24 * 60 * 60 * 1000 - 1,
    );

    // Run all three queries in parallel
    const [medications, latestIntakes, todayEvents] = await Promise.all([
      prisma.medication.findMany({
        where: { userId: sessionData.user.id },
        include: { schedules: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.medicationIntakeEvent.groupBy({
        by: ["medicationId"],
        where: {
          userId: sessionData.user.id,
          skipped: false,
          takenAt: { not: null },
        },
        _max: { takenAt: true },
      }),
      prisma.medicationIntakeEvent.groupBy({
        by: ["medicationId"],
        where: {
          userId: sessionData.user.id,
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
      todayEvents.map((entry: { medicationId: string; _count: { id: number } }) => [entry.medicationId, entry._count.id]),
    );

    let categoryMap: Record<string, string> = {};
    try {
      categoryMap = await getMedicationCategories(
        medications.map((m) => m.id),
      );
    } catch (error) {
      console.error("Medication categories could not be loaded:", error);
    }

    return apiSuccess(
      medications.map((m) => ({
        ...m,
        category: categoryMap[m.id] ?? "OTHER",
        lastTakenAt: lastTakenAtByMedicationId[m.id] ?? null,
        todayEventCount: todayEventCountByMedId[m.id] ?? 0,
      })),
    );
  } catch (error) {
    console.error("Load medications error:", error);
    return apiError("Medikamente konnten nicht geladen werden", 500);
  }
}

export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    const body = await request.json();
    const parsed = createMedicationSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { name, dose, category, schedules } = parsed.data;

    const medication = await prisma.medication.create({
      data: {
        userId: sessionData.user.id,
        name,
        dose,
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
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: medication.id, name },
    });

    return apiSuccess(
      {
        ...medication,
        category: normalizedCategory,
      },
      201,
    );
  } catch (err) {
    console.error("Create medication error:", err);
    return apiError("Medikament konnte nicht erstellt werden", 500);
  }
}
