import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";

const querySchema = z.object({
  from: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
  to: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
});

function toBerlinDayKey(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

interface DailySummary {
  date: string;
  total: number;
  medications: Record<string, number>;
}

export async function GET(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { from, to } = parsed.data;

  const events = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId: sessionData.user.id,
      skipped: false,
      takenAt: {
        not: null,
        ...(from && { gte: from }),
        ...(to && { lte: to }),
      },
    },
    select: {
      takenAt: true,
      medication: {
        select: {
          name: true,
        },
      },
    },
    orderBy: { takenAt: "asc" },
  });

  const medicationNames = new Set<string>();
  const byDay = new Map<string, DailySummary>();

  for (const event of events) {
    if (!event.takenAt) continue;

    const medicationName = event.medication.name;
    const dayKey = toBerlinDayKey(event.takenAt);
    medicationNames.add(medicationName);

    const existing = byDay.get(dayKey) ?? {
      date: dayKey,
      total: 0,
      medications: {},
    };

    existing.total += 1;
    existing.medications[medicationName] =
      (existing.medications[medicationName] ?? 0) + 1;
    byDay.set(dayKey, existing);
  }

  const points = [...byDay.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return apiSuccess({
    points,
    medications: [...medicationNames].sort((a, b) => a.localeCompare(b, "de")),
  });
}
