import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import {
  createMoodEntrySchema,
  listMoodEntriesSchema,
  getScoreForMood,
} from "@/lib/validations/moodlog";
import { NextRequest } from "next/server";

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

export async function GET(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listMoodEntriesSchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { mood, from, to, limit, offset, sortBy, sortDir } = parsed.data;

  const where = {
    userId: sessionData.user.id,
    ...(mood && { mood }),
    ...(from || to
      ? {
          date: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
  };

  const [entries, total] = await Promise.all([
    prisma.moodEntry.findMany({
      where,
      orderBy: { [sortBy]: sortDir },
      take: limit,
      skip: offset,
    }),
    prisma.moodEntry.count({ where }),
  ]);

  const entriesWithParsedTags = entries.map((e) => ({
    ...e,
    tags: parseTags(e.tags),
  }));

  return apiSuccess({
    entries: entriesWithParsedTags,
    meta: { total, limit, offset },
  });
}

export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    const body = await request.json();
    const parsed = createMoodEntrySchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { mood, tags, moodLoggedAt, source } = parsed.data;
    const date = toBerlinDate(moodLoggedAt);
    const score = getScoreForMood(mood);

    const entry = await prisma.moodEntry.create({
      data: {
        userId: sessionData.user.id,
        date,
        mood,
        score,
        tags: tags ? JSON.stringify(tags) : null,
        source: source ?? "MANUAL",
        moodLoggedAt,
      },
    });

    await auditLog("moodEntry.create", {
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: entry.id, mood },
    });

    return apiSuccess({ ...entry, tags: parseTags(entry.tags) }, 201);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return apiError(
        "Ein Stimmungseintrag mit diesen Daten existiert bereits",
        409,
      );
    }
    console.error("Create mood entry error:", err);
    return apiError("Stimmungseintrag konnte nicht erstellt werden", 500);
  }
}
