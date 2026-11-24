import { NextRequest } from "next/server";

import { prisma, toJson } from "@/lib/db";
import { withUserRowLock } from "@/lib/user-row-lock";
import { apiSuccess, returnAllZodIssues, safeJson } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  takeBaseToken,
  guardedUserDocumentUpdate,
  invalidBaseTokenError,
  userDocumentToken,
} from "@/lib/optimistic-lock";
import { annotate } from "@/lib/logging/context";
import {
  moodTagLayoutSchema,
  parseStoredMoodTagLayout,
  mergeMoodTagLayout,
  resolveGroupOrder,
  type MoodTagLayout,
} from "@/lib/mood/tag-layout";

export const dynamic = "force-dynamic";

/**
 * v1.17.0 — per-user mood-tag layout (group order + tag placements).
 *
 * GET returns the stored blob merged over defaults: `groupOrder` fully
 * resolved against the user's effective category set (layout order first,
 * unmentioned categories appended in seeded order) + the raw `placements`.
 * PUT updates with preserve-when-absent semantics — a groupOrder-only PUT
 * keeps the stored placements and vice versa. Mirrors
 * `/api/medications/layout`; the blob lives on its own `User` column
 * (`mood_tag_layout_json`) per the per-surface-column convention.
 *
 * Display-only: keys here are opaque, unknown / stale keys are dropped at
 * read time by `GET /api/mood/tags`, so the schema bounds size and shape
 * but does not assert ownership of every key.
 */

async function resolveLayoutResponse(
  userId: string,
  layout: MoodTagLayout,
  updatedAt?: string,
): Promise<{
  groupOrder: string[];
  placements: Record<string, string[]>;
  updatedAt?: string;
}> {
  const categories = await prisma.moodTagCategory.findMany({
    where: { isActive: true, OR: [{ userId: null }, { userId }] },
    orderBy: { sortOrder: "asc" },
    select: { key: true },
  });
  return {
    groupOrder: resolveGroupOrder(
      categories.map((c) => c.key),
      layout.groupOrder,
    ),
    placements: layout.placements ?? {},
    // v1.32.22 — optimistic-concurrency token; omitted (dropped from
    // JSON) when absent so a fresh user's response shape is unchanged.
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { moodTagLayoutJson: true, moodTagLayoutRevisedAt: true },
  });
  const stored = parseStoredMoodTagLayout(row?.moodTagLayoutJson);
  return apiSuccess(
    await resolveLayoutResponse(
      user.id,
      stored,
      userDocumentToken(row, "moodTagLayout"),
    ),
  );
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: rawJsonBody, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  // v1.32.22 — split the optimistic-concurrency base token off before the
  // Zod parse. The two cards on this page write DIFFERENT fields of the same
  // blob (group order vs placements); a stale merge would resurrect the other
  // card's overwritten field, which the token now 409s instead.
  const taken = takeBaseToken(rawJsonBody);
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;

  const parsed = moodTagLayoutSchema.safeParse(taken.rest);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  // Preserve-when-absent: a PUT carrying only `groupOrder` must not wipe
  // the stored placements, and a placements-only PUT must not reset the
  // group order.
  // Read, merge and write under the row lock: a tokenless write is
  // unconditional, and two that overlap would each carry forward a stored
  // copy without the other's change.
  const { merged, guarded } = await withUserRowLock(user.id, async (tx) => {
    const row = await tx.user.findUnique({
      where: { id: user.id },
      select: { moodTagLayoutJson: true },
    });
    const stored = parseStoredMoodTagLayout(row?.moodTagLayoutJson);
    const merged: MoodTagLayout = mergeMoodTagLayout(stored, {
      ...(parsed.data.groupOrder !== undefined
        ? { groupOrder: parsed.data.groupOrder }
        : {}),
      ...(parsed.data.placements !== undefined
        ? { placements: parsed.data.placements }
        : {}),
    });

    const guarded = await guardedUserDocumentUpdate({
      userId: user.id,
      document: "moodTagLayout",
      base,
      data: { moodTagLayoutJson: toJson(merged) },
      conflict: {
        action: "mood.tag.layout.conflict",
        errorCode: "mood_tag_layout_conflict",
        message: "Mood-tag layout changed since it was loaded",
      },
      client: tx,
    });
    return { merged, guarded };
  });
  if ("conflict" in guarded) return guarded.conflict;

  // No audit row by design: the layout blob is a per-user display ordering
  // (group order + tag placements), not a health-data write. It destroys
  // nothing and fires on every drag-to-reorder save, so a ledger row here
  // would be noise rather than forensics. The wide-event annotate still
  // carries it for observability.
  annotate({
    action: { name: "mood.tag.layout.update" },
    meta: {
      group_order_count: merged.groupOrder?.length ?? 0,
      placement_group_count: Object.keys(merged.placements ?? {}).length,
    },
  });

  return apiSuccess(
    await resolveLayoutResponse(user.id, merged, guarded.updatedAt),
  );
});
