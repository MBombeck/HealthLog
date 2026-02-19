import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { updateMeasurementSchema } from "@/lib/validations/measurement";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;

  const measurement = await prisma.measurement.findUnique({
    where: { id },
  });

  if (!measurement || measurement.userId !== sessionData.user.id) {
    return apiError("Messwert nicht gefunden", 404);
  }

  return apiSuccess(measurement);
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;

  const existing = await prisma.measurement.findUnique({
    where: { id },
  });

  if (!existing || existing.userId !== sessionData.user.id) {
    return apiError("Messwert nicht gefunden", 404);
  }

  try {
    const body = await request.json();
    const parsed = updateMeasurementSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const data = parsed.data;
    const measurement = await prisma.measurement.update({
      where: { id },
      data: {
        ...(data.value !== undefined && { value: data.value }),
        ...(data.measuredAt !== undefined && { measuredAt: data.measuredAt }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
    });

    await auditLog("measurement.update", {
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
      details: { measurementId: id },
    });

    return apiSuccess(measurement);
  } catch (err) {
    console.error("Update measurement error:", err);
    return apiError("Messwert konnte nicht aktualisiert werden", 500);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;

  const existing = await prisma.measurement.findUnique({
    where: { id },
  });

  if (!existing || existing.userId !== sessionData.user.id) {
    return apiError("Messwert nicht gefunden", 404);
  }

  await prisma.measurement.delete({ where: { id } });

  await auditLog("measurement.delete", {
    userId: sessionData.user.id,
    ipAddress: getClientIp(request),
    details: { measurementId: id, type: existing.type },
  });

  return apiSuccess({ deleted: true });
}
