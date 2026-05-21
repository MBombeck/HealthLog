import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { updateIntakeEventSchema } from "@/lib/validations/medication";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string; eventId: string }> };

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id, eventId } = await params;

    const event = await prisma.medicationIntakeEvent.findUnique({
      where: { id: eventId },
    });

    if (!event || event.userId !== user.id || event.medicationId !== id) {
      return apiError("Intake not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
    const parsed = updateIntakeEventSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const data = parsed.data;
    const updated = await prisma.medicationIntakeEvent.update({
      where: { id: eventId },
      data: {
        ...(data.takenAt !== undefined && { takenAt: data.takenAt }),
        ...(data.skipped !== undefined && { skipped: data.skipped }),
        ...(data.scheduledFor !== undefined && {
          scheduledFor: data.scheduledFor,
        }),
      },
    });

    await auditLog("medication.intake.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { eventId, medicationId: id },
    });

    annotate({
      action: {
        name: "medication.intake.update",
        entity_type: "intake_event",
        entity_id: eventId,
      },
      meta: { medication_id: id },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the edited event.
    invalidateUserMedications(user.id);

    // v1.4.39 W-MED — refresh the rollup row for both the old + new
    // scheduledFor day-keys when the timestamp moved across a day
    // boundary; if only takenAt / skipped changed the second call
    // collapses to a no-op upsert.
    await recomputeMedicationComplianceForEvent({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor,
      tz: user.timezone,
    });
    if (
      data.scheduledFor !== undefined &&
      data.scheduledFor.getTime() !== event.scheduledFor.getTime()
    ) {
      await recomputeMedicationComplianceForEvent({
        userId: user.id,
        medicationId: id,
        scheduledFor: data.scheduledFor,
        tz: user.timezone,
      });
    }

    return apiSuccess(updated);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id, eventId } = await params;

    const event = await prisma.medicationIntakeEvent.findUnique({
      where: { id: eventId },
    });

    if (!event || event.userId !== user.id || event.medicationId !== id) {
      return apiError("Intake not found", 404);
    }

    await prisma.medicationIntakeEvent.delete({ where: { id: eventId } });

    const ip = getClientIp(request) ?? "unknown";
    await auditLog("medication.intake.delete", {
      userId: user.id,
      ipAddress: ip,
      details: { eventId, medicationId: id },
    });

    annotate({
      action: {
        name: "medication.intake.delete",
        entity_type: "intake_event",
        entity_id: eventId,
      },
      meta: { medication_id: id },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the deletion.
    invalidateUserMedications(user.id);

    // v1.4.39 W-MED — refresh the rollup row for the day the deleted
    // event sat on. When that day now holds zero events the helper
    // drops the rollup row entirely.
    await recomputeMedicationComplianceForEvent({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor,
      tz: user.timezone,
    });

    return apiSuccess({ deleted: true });
  },
);
