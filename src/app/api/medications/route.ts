import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { createMedicationSchema } from "@/lib/validations/medication";
import {
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { NextRequest } from "next/server";

export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const medications = await prisma.medication.findMany({
    where: { userId: sessionData.user.id },
    include: { schedules: true },
    orderBy: { createdAt: "desc" },
  });

  const categoryMap = await getMedicationCategories(medications.map((m) => m.id));

  return apiSuccess(
    medications.map((m) => ({
      ...m,
      category: categoryMap[m.id] ?? "OTHER",
    })),
  );
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
