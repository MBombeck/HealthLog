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
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";

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

  const { mood, tags, note, moodLoggedAt, source } = parsed.data;
  // v1.4.25 W7b (Decision A) — anchor the `date` string to the user's
  // current displayTimezone and store the resolved zone on the row.
  // Legacy rows with `tz IS NULL` continue to read as Europe/Berlin
  // (see `src/lib/mood/date-key.ts`).
  const tz = user.timezone ?? DEFAULT_TIMEZONE;
  const date = moodDateKey(moodLoggedAt, tz);
  const score = getScoreForMood(mood);

  try {
    const entry = await prisma.moodEntry.create({
      data: {
        userId: user.id,
        date,
        tz,
        mood,
        score,
        tags: tags ? JSON.stringify(tags) : null,
        note: note ?? null,
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

    // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.4.39 W-MOOD — refresh the persisted DAY rollup for the
    // entry's bucket and enqueue the WEEK / MONTH / YEAR folds.
    // Best-effort: a failure here must not surface as a 5xx to the
    // user, the rollup is a cache tier, not a write-path invariant.
    try {
      await recomputeMoodBucketsForEntry(user.id, moodLoggedAt);
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }

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
