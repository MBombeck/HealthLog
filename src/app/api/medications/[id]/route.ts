import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { updateMedicationSchema } from "@/lib/validations/medication";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  deleteMedicationCategory,
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const medication = await prisma.medication.findUnique({
      where: { id },
      include: { schedules: true },
    });

    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    let category = "OTHER";
    try {
      const categories = await getMedicationCategories([id]);
      category = categories[id] ?? "OTHER";
    } catch {
      // Category enrichment is optional
    }

    annotate({
      action: {
        name: "medication.get",
        entity_type: "medication",
        entity_id: id,
      },
    });

    return apiSuccess({ ...medication, category });
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const existing = await prisma.medication.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
    const parsed = updateMedicationSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
    }

    const {
      name,
      dose,
      category,
      treatmentClass,
      dosesPerUnit,
      active,
      notificationsEnabled,
      schedules,
    } = parsed.data;

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
      ...(treatmentClass !== undefined && { treatmentClass }),
      ...(dosesPerUnit !== undefined && { dosesPerUnit }),
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
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id },
    });

    annotate({
      action: {
        name: "medication.update",
        entity_type: "medication",
        entity_id: id,
      },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the schedule change.
    invalidateUserMedications(user.id);

    return apiSuccess({
      ...medication,
      category: normalizedCategory,
    });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const existing = await prisma.medication.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    // Revoke API tokens scoped to this medication
    const medicationScope = `medication:${id}:ingest`;
    await prisma.apiToken.updateMany({
      where: {
        userId: user.id,
        revoked: false,
        permissions: { has: medicationScope },
      },
      data: { revoked: true },
    });

    await deleteMedicationCategory(id);
    await prisma.medication.delete({ where: { id } });

    await auditLog("medication.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, name: existing.name },
    });

    annotate({
      action: {
        name: "medication.delete",
        entity_type: "medication",
        entity_id: id,
      },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the deletion.
    invalidateUserMedications(user.id);

    return apiSuccess({ deleted: true });
  },
);
