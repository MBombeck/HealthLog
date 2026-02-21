import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({ where: { id } });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  const { count } = await prisma.medicationIntakeEvent.deleteMany({
    where: { medicationId: id, userId: sessionData.user.id },
  });

  await auditLog("medication.intake.purge", {
    userId: sessionData.user.id,
    ipAddress: getClientIp(request),
    details: { medicationId: id, name: medication.name, deletedCount: count },
  });

  return apiSuccess({ purged: true, count });
}
