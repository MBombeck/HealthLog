import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { phaseConfigSchema } from "@/lib/validations/phase-config";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  const config = await prisma.reminderPhaseConfig.findUnique({
    where: { medicationId: id },
  });

  // Return config or defaults
  return apiSuccess(
    config ?? {
      greenValue: 60,
      greenMode: "MINUTES",
      yellowValue: 30,
      yellowMode: "MINUTES",
      orangeValue: 0,
      orangeMode: "MINUTES",
      redValue: 240,
      redMode: "MINUTES",
    },
  );
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  const body = await request.json();
  const parsed = phaseConfigSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Ungültige Eingabe", 400);
  }

  const config = await prisma.reminderPhaseConfig.upsert({
    where: { medicationId: id },
    create: {
      medicationId: id,
      ...parsed.data,
    },
    update: parsed.data,
  });

  return apiSuccess(config);
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  await prisma.reminderPhaseConfig.deleteMany({
    where: { medicationId: id },
  });

  return apiSuccess({ reset: true });
}
