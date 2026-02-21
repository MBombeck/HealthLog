import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import {
  updateMoodEntrySchema,
  getScoreForMood,
} from "@/lib/validations/moodlog";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

function toBerlinDate(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
  }).format(date);
}

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    return JSON.parse(tags) as string[];
  } catch {
    return [];
  }
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;

  const entry = await prisma.moodEntry.findUnique({ where: { id } });

  if (!entry || entry.userId !== sessionData.user.id) {
    return apiError("Stimmungseintrag nicht gefunden", 404);
  }

  return apiSuccess({ ...entry, tags: parseTags(entry.tags) });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;

  const existing = await prisma.moodEntry.findUnique({ where: { id } });

  if (!existing || existing.userId !== sessionData.user.id) {
    return apiError("Stimmungseintrag nicht gefunden", 404);
  }

  try {
    const body = await request.json();
    const parsed = updateMoodEntrySchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const data = parsed.data;

    const updateData: Record<string, unknown> = {};
    if (data.mood !== undefined) {
      updateData.mood = data.mood;
      updateData.score = getScoreForMood(data.mood);
    }
    if (data.moodLoggedAt !== undefined) {
      updateData.moodLoggedAt = data.moodLoggedAt;
      updateData.date = toBerlinDate(data.moodLoggedAt);
    }
    if (data.tags !== undefined) {
      updateData.tags = data.tags ? JSON.stringify(data.tags) : null;
    }

    const entry = await prisma.moodEntry.update({
      where: { id },
      data: updateData,
    });

    await auditLog("moodEntry.update", {
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: id },
    });

    return apiSuccess({ ...entry, tags: parseTags(entry.tags) });
  } catch (err) {
    console.error("Update mood entry error:", err);
    return apiError("Stimmungseintrag konnte nicht aktualisiert werden", 500);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;

  const existing = await prisma.moodEntry.findUnique({ where: { id } });

  if (!existing || existing.userId !== sessionData.user.id) {
    return apiError("Stimmungseintrag nicht gefunden", 404);
  }

  await prisma.moodEntry.delete({ where: { id } });

  await auditLog("moodEntry.delete", {
    userId: sessionData.user.id,
    ipAddress: getClientIp(request),
    details: { moodEntryId: id, mood: existing.mood },
  });

  return apiSuccess({ deleted: true });
}
