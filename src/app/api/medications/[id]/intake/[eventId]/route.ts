import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string; eventId: string }> };

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
