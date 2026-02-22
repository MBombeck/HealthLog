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
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({
    where: { id },
    include: { schedules: true },
  });

  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  let category = "OTHER";
  try {
    const categories = await getMedicationCategories([id]);
    category = categories[id] ?? "OTHER";
  } catch {
    // Category enrichment is optional
  }

  return apiSuccess({ ...medication, category });
}

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

    const { name, dose, category, active, notificationsEnabled, schedules } =
      parsed.data;

    const pausedAtPatch =
      active === undefined
        ? {}
        : active
          ? { pausedAt: null as Date | null }
          : existing.active
            ? { pausedAt: new Date() }
            : {};

    // If schedules provided, replace all
    if (schedules) {
      await prisma.medicationSchedule.deleteMany({
        where: { medicationId: id },
      });
    }

    const baseUpdateData = {
      ...(name !== undefined && { name }),
      ...(dose !== undefined && { dose }),
      ...(active !== undefined && { active }),
      ...(notificationsEnabled !== undefined && { notificationsEnabled }),
      ...(schedules && {
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
      }),
    };

    const withoutNotifications = { ...baseUpdateData } as Record<
      string,
      unknown
    >;
    delete withoutNotifications.notificationsEnabled;
    const hasPausedAtPatch = Object.keys(pausedAtPatch).length > 0;
    const hasNotificationsPatch = notificationsEnabled !== undefined;

    const updateCandidates: Array<Record<string, unknown>> = [
      { ...baseUpdateData, ...pausedAtPatch },
    ];
    if (hasPausedAtPatch) {
      updateCandidates.push(baseUpdateData);
    }
    if (hasNotificationsPatch) {
      updateCandidates.push({ ...withoutNotifications, ...pausedAtPatch });
      if (hasPausedAtPatch) {
        updateCandidates.push(withoutNotifications);
      }
    }

    let medication;
    let lastUpdateErr: unknown;
    for (const candidate of updateCandidates) {
      try {
        medication = await prisma.medication.update({
          where: { id },
          data: candidate,
          include: { schedules: true },
        });
        break;
      } catch (updateErr) {
        lastUpdateErr = updateErr;
      }
    }
    if (!medication) throw lastUpdateErr;

    const normalizedCategory =
      category !== undefined
        ? await setMedicationCategory(id, category)
        : ((await getMedicationCategories([id]))[id] ?? "OTHER");

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

  // Revoke API tokens scoped to this medication
  const medicationScope = `medication:${id}:ingest`;
  await prisma.apiToken.updateMany({
    where: {
      userId: sessionData.user.id,
      revoked: false,
      permissions: { has: medicationScope },
    },
    data: { revoked: true },
  });

  await deleteMedicationCategory(id);
  await prisma.medication.delete({ where: { id } });

  await auditLog("medication.delete", {
    userId: sessionData.user.id,
    ipAddress: getClientIp(request),
    details: { medicationId: id, name: existing.name },
  });

  return apiSuccess({ deleted: true });
}
