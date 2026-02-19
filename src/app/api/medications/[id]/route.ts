import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { updateMedicationSchema } from "@/lib/validations/medication";
import {
  deleteMedicationCategory,
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const existing = await prisma.medication.findUnique({ where: { id } });
  if (!existing || existing.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  try {
    const body = await request.json();
    const parsed = updateMedicationSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { name, dose, category, active, schedules } = parsed.data;

    // If schedules provided, replace all
    if (schedules) {
      await prisma.medicationSchedule.deleteMany({
        where: { medicationId: id },
      });
    }

    const medication = await prisma.medication.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(dose !== undefined && { dose }),
        ...(active !== undefined && { active }),
        ...(schedules && {
          schedules: {
            create: schedules.map((s) => ({
              windowStart: s.windowStart,
              windowEnd: s.windowEnd,
              label: s.label ?? null,
              dose: s.dose ?? null,
            })),
          },
        }),
      },
      include: { schedules: true },
    });

    const normalizedCategory =
      category !== undefined
        ? await setMedicationCategory(id, category)
        : (await getMedicationCategories([id]))[id] ?? "OTHER";

    await auditLog("medication.update", {
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id },
    });

    return apiSuccess({
      ...medication,
      category: normalizedCategory,
    });
  } catch (err) {
    console.error("Update medication error:", err);
    return apiError("Medikament konnte nicht aktualisiert werden", 500);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const existing = await prisma.medication.findUnique({ where: { id } });
  if (!existing || existing.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  await deleteMedicationCategory(id);
  await prisma.medication.delete({ where: { id } });

  await auditLog("medication.delete", {
    userId: sessionData.user.id,
    ipAddress: getClientIp(request),
    details: { medicationId: id, name: existing.name },
  });

  return apiSuccess({ deleted: true });
}
