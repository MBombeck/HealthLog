import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { calculateCompliance } from "@/lib/analytics/compliance";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
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

  const events = await prisma.medicationIntakeEvent.findMany({
    where: { medicationId: id, userId: sessionData.user.id },
    orderBy: { scheduledFor: "desc" },
  });

  const mapped = events.map((e) => ({
    takenAt: e.takenAt,
    skipped: e.skipped,
    scheduledFor: e.scheduledFor,
  }));

  const compliance7 = calculateCompliance(mapped, medication.schedules, 7);
  const compliance30 = calculateCompliance(mapped, medication.schedules, 30);

  return apiSuccess({ compliance7, compliance30 });
}
