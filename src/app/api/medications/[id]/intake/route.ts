import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { intakeSchema } from "@/lib/validations/medication";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({ where: { id } });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  try {
    const body = await request.json();
    const parsed = intakeSchema.safeParse({ ...body, medicationId: id });
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { takenAt, skipped, idempotencyKey } = parsed.data;

    // Idempotency check
    if (idempotencyKey) {
      const existing = await prisma.medicationIntakeEvent.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return apiSuccess(existing);
      }
    }

    const event = await prisma.medicationIntakeEvent.create({
      data: {
        userId: sessionData.user.id,
        medicationId: id,
        scheduledFor: takenAt ?? new Date(),
        takenAt: skipped ? null : (takenAt ?? new Date()),
        skipped,
        source: "WEB",
        idempotencyKey: idempotencyKey ?? null,
      },
    });

    await auditLog("medication.intake", {
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, eventId: event.id, skipped },
    });

    return apiSuccess(event, 201);
  } catch (err) {
    console.error("Intake error:", err);
    return apiError("Einnahme konnte nicht gespeichert werden", 500);
  }
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({ where: { id } });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  const events = await prisma.medicationIntakeEvent.findMany({
    where: { medicationId: id, userId: sessionData.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return apiSuccess(events);
}
