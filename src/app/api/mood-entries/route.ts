import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import {
  createMoodEntrySchema,
  listMoodEntriesSchema,
  getScoreForMood,
} from "@/lib/validations/moodlog";
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";

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

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listMoodEntriesSchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { mood, from, to, limit, offset, sortBy, sortDir } = parsed.data;

  const where = {
    userId: user.id,
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

  annotate({
    action: { name: "mood-entries.list" },
    meta: { total, limit, offset },
  });

  const entriesWithParsedTags = entries.map((e) => ({
    ...e,
    tags: parseTags(e.tags),
  }));

  return apiSuccess({
    entries: entriesWithParsedTags,
    meta: { total, limit, offset },
  });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postMoodEntry));

async function postMoodEntry(request: NextRequest) {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = createMoodEntrySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { mood, tags, moodLoggedAt, source } = parsed.data;
  const date = toBerlinDate(moodLoggedAt);
  const score = getScoreForMood(mood);

  try {
    const entry = await prisma.moodEntry.create({
      data: {
        userId: user.id,
        date,
        mood,
        score,
        tags: tags ? JSON.stringify(tags) : null,
        source: source ?? "MANUAL",
        moodLoggedAt,
      },
    });

    await auditLog("moodEntry.create", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: entry.id, mood },
    });

    annotate({
      action: { name: "mood-entries.create" },
      meta: { moodEntryId: entry.id, mood },
    });

    return apiSuccess({ ...entry, tags: parseTags(entry.tags) }, 201);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return apiError("A mood entry with this data already exists", 409);
    }
    throw err;
  }
}
