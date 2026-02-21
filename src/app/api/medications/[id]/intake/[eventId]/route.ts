import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { updateIntakeEventSchema } from "@/lib/validations/medication";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string; eventId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id, eventId } = await params;

  const event = await prisma.medicationIntakeEvent.findUnique({
    where: { id: eventId },
  });

  if (
    !event ||
    event.userId !== sessionData.user.id ||
    event.medicationId !== id
  ) {
    return apiError("Einnahme nicht gefunden", 404);
  }

  try {
    const body = await request.json();
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
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
      details: { eventId, medicationId: id },
    });

    return apiSuccess(updated);
  } catch (err) {
    console.error("Update intake event error:", err);
    return apiError("Einnahme konnte nicht aktualisiert werden", 500);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id, eventId } = await params;

  const event = await prisma.medicationIntakeEvent.findUnique({
    where: { id: eventId },
  });

  if (
    !event ||
    event.userId !== sessionData.user.id ||
    event.medicationId !== id
  ) {
    return apiError("Einnahme nicht gefunden", 404);
  }

  await prisma.medicationIntakeEvent.delete({ where: { id: eventId } });

  const ip = getClientIp(request) ?? "unknown";
  await auditLog("medication.intake.delete", {
    userId: sessionData.user.id,
    ipAddress: ip,
    details: { eventId, medicationId: id },
  });

  return apiSuccess({ deleted: true });
}
