/**
 * PATCH  /api/insights/coach/facts/[id] — edit one Coach fact's wording.
 * DELETE /api/insights/coach/facts/[id] — soft-delete one Coach fact.
 *
 * v1.11.1 — the per-fact "forget this one thing" delete for the durable
 * Coach facts surface. It is also the "Undo" under a note the Coach saved in
 * a turn (v1.41).
 *
 * v1.41 — PATCH rewrites the fact's text (re-encrypted) and reads the new
 * wording again (`settleCategory`, the lexicon the Coach's own saves pass):
 * text that now names a medication moves to `medication`, so the medications
 * module still filters it; other health wording moves a non-health category
 * to `condition`; otherwise the category stays. A health fact the person
 * wrote themselves is confirmed by that edit (`source: "user"`). Only a
 * listed fact can be edited: a proposal still waiting for the person's
 * answer is not one, and answers 404 like an unknown id. Editing is the
 * person's own data, so no Coach or AI gate.
 *
 * Ownership + existence privacy: the soft-delete uses `updateMany` scoped
 * `where: { id, userId, deletedAt: null }` rather than `update`. A
 * cross-user id, an unknown id, or an already-deleted fact all resolve to
 * a `count: 0` no-op — the route returns `200 { deleted: false }` and
 * never reveals whether the id exists under another account. The matching
 * convention is the idempotent-delete one used elsewhere in the tree
 * (a not-found delete is a successful no-op, not a 404).
 *
 * Never AI-gated, like the collection route: deleting a stored fact keeps
 * working while the Coach is unavailable.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { isHealthFact } from "@/lib/ai/coach/facts";
import { settleCategory } from "@/lib/ai/coach/memory/remember";
import { PROPOSED_FACT_SOURCE } from "@/lib/ai/coach/memory/shared";
import {
  COACH_MEMORY_CATEGORIES,
  type CoachMemoryCategory,
} from "@/lib/ai/coach/types";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { coachFactPatchSchema } from "@/lib/validations/coach-fact";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const PATCH_RATE_LIMIT = 40;
const PATCH_WINDOW_MS = 60_000;

export const PATCH = apiHandler(async (req: NextRequest, ctx: RouteCtx) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `coach-facts:patch:${user.id}`,
    PATCH_RATE_LIMIT,
    PATCH_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const { id } = await ctx.params;
  const { data: body, error: jsonError } = await safeJson(req, {
    maxBytes: 2 * 1024,
  });
  if (jsonError) return jsonError;
  const parsed = coachFactPatchSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const text = parsed.data.fact.replace(/\s+/g, " ");
  const live = {
    id,
    userId: user.id,
    deletedAt: null,
    source: { not: PROPOSED_FACT_SOURCE },
  };
  const current = await prisma.coachFact.findFirst({
    where: live,
    select: { category: true, source: true },
  });
  if (!current) return apiError("Fact not found", 404);
  const known = (COACH_MEMORY_CATEGORIES as readonly string[]).includes(
    current.category,
  );
  const category = known
    ? settleCategory(current.category as CoachMemoryCategory, text)
    : current.category;
  // A health fact the person wrote is one they confirmed.
  const source = isHealthFact(category, text) ? "user" : current.source;
  // `updateMany` scoped by id, owner and liveness: an unknown, cross-user,
  // deleted or still-proposed id is a 0-count no-op, never a P2025 throw.
  const { count } = await prisma.coachFact.updateMany({
    where: live,
    data: { factEncrypted: encryptToBytes(text), category, source },
  });
  if (count === 0) {
    // Indistinguishable from "owned by someone else" — never reveal which.
    return apiError("Fact not found", 404);
  }

  const row = await prisma.coachFact.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true, category: true, source: true, updatedAt: true },
  });
  if (!row) return apiError("Fact not found", 404);

  annotate({
    action: { name: "coach.facts.updated" },
    meta: { category: row.category },
  });

  return apiSuccess({
    fact: {
      id: row.id,
      category: row.category,
      text,
      source: row.source,
      updatedAt: row.updatedAt.toISOString(),
    },
  });
});

export const DELETE = apiHandler(
  async (_request: NextRequest, ctx: RouteCtx) => {
    const { user } = await requireAuth();

    const { id } = await ctx.params;

    // `updateMany` (not `update`) so an unknown / cross-user / already-soft-
    // deleted id is a 0-count no-op rather than a P2025 throw — the
    // existence channel never leaks across accounts.
    const { count } = await prisma.coachFact.updateMany({
      where: { id, userId: user.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    const deleted = count > 0;

    annotate({
      action: { name: "coach.facts.deleted" },
      meta: { deleted },
    });

    return apiSuccess({ deleted });
  },
);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
