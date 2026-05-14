import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import {
  updateMoodEntrySchema,
  getScoreForMood,
} from "@/lib/validations/moodlog";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";

type RouteParams = { params: Promise<{ id: string }> };

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    return JSON.parse(tags) as string[];
  } catch {
    return [];
  }
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    const entry = await prisma.moodEntry.findUnique({ where: { id } });

    if (!entry || entry.userId !== user.id) {
      return apiError("Mood entry not found", 404);
    }

    annotate({
      action: { name: "mood-entries.get" },
      meta: { moodEntryId: id },
    });

    return apiSuccess({ ...entry, tags: parseTags(entry.tags) });
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    const existing = await prisma.moodEntry.findUnique({ where: { id } });

    if (!existing || existing.userId !== user.id) {
      return apiError("Mood entry not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
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
      // v1.4.25 W7b — re-anchor the row's `date` to the user's current
      // displayTimezone. Also refresh the `tz` column so the row's
      // attribution stays consistent with the new `date`. Legacy rows
      // promoted via this PUT therefore migrate to per-row tz without
      // a separate backfill.
      const tz = user.timezone ?? DEFAULT_TIMEZONE;
      updateData.moodLoggedAt = data.moodLoggedAt;
      updateData.date = moodDateKey(data.moodLoggedAt, tz);
      updateData.tz = tz;
    }
    if (data.tags !== undefined) {
      updateData.tags = data.tags ? JSON.stringify(data.tags) : null;
    }

    const entry = await prisma.moodEntry.update({
      where: { id },
      data: updateData,
    });

    await auditLog("moodEntry.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: id },
    });

    annotate({
      action: { name: "mood-entries.update" },
      meta: { moodEntryId: id },
    });

    return apiSuccess({ ...entry, tags: parseTags(entry.tags) });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    const existing = await prisma.moodEntry.findUnique({ where: { id } });

    if (!existing || existing.userId !== user.id) {
      return apiError("Mood entry not found", 404);
    }

    await prisma.moodEntry.delete({ where: { id } });

    await auditLog("moodEntry.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { moodEntryId: id, mood: existing.mood },
    });

    annotate({
      action: { name: "mood-entries.delete" },
      meta: { moodEntryId: id },
    });

    return apiSuccess({ deleted: true });
  },
);
