/**
 * PATCH  /api/coach/plans/[id] — confirm / update a Coach plan's lifecycle.
 * DELETE /api/coach/plans/[id] — soft-delete one Coach plan.
 *
 * v1.21.3 (B1) — the user-confirm + management surface for the durable Coach
 * plans. Coach-proposes-then-user-confirms: the extractor writes a plan as
 * `status: "proposed"`; this PATCH is the ONLY path that activates it
 * (proposed → active), or marks it met / abandoned, or sets a review date.
 * The body never carries the plan's metric or its encrypted free text, so a
 * client can never inject or overwrite a plan's prose — only its lifecycle.
 *
 * Ownership + existence privacy: every mutation is scoped
 * `where: { id, userId, deletedAt: null }` via `updateMany`, so a cross-user
 * id, an unknown id, or an already-deleted plan all resolve to a `count: 0`
 * no-op rather than a P2025 throw — the existence channel never leaks across
 * accounts. PATCH on a 0-count match returns 404; DELETE on a 0-count match
 * returns the idempotent `{ deleted: false }`.
 *
 * PATCH is Coach use (it confirms what the Coach proposed) and is gated by
 * `requireModuleEnabled(userId, "coach")`. DELETE is not: erasing one's own
 * stored plan never depends on the Coach being available, the same rule as
 * the stored facts and conversations. Bodies are Zod-parsed; an invalid body
 * returns the multi-issue 422 envelope.
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
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { clampReviewDays } from "@/lib/ai/coach/memory/propose-plan";
import { COACH_CHECKIN_REVIEW_DAYS } from "@/lib/daily/coach-checkin-intents";
import { coachPlanPatchSchema } from "@/lib/validations/coach-plan";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// Lifecycle mutations are cheap + owner-scoped; the limit only caps a runaway
// client loop, mirroring the about-me management routes.
const MUTATE_RATE_LIMIT = 40;
const MUTATE_WINDOW_MS = 60_000;

/** Apply the shared per-user mutation limit; returns a 429 response or null. */
async function enforceMutateLimit(
  op: string,
  userId: string,
): Promise<Response | null> {
  const rl = await checkRateLimit(
    `coach-plans:${op}:${userId}`,
    MUTATE_RATE_LIMIT,
    MUTATE_WINDOW_MS,
  );
  if (rl.allowed) return null;
  const response = apiError("Too many requests", 429);
  for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
    response.headers.set(k, v);
  }
  return response;
}

export const PATCH = apiHandler(async (req: NextRequest, ctx: RouteCtx) => {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  const limited = await enforceMutateLimit("patch", user.id);
  if (limited) return limited;

  const { id } = await ctx.params;

  const { data: body, error: jsonError } = await safeJson(req, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = coachPlanPatchSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }

  // Field-by-field data assembly (no mass assignment): only the lifecycle
  // fields the body carried are written; the metric + encrypted text are never
  // touched by this route.
  const data: { status?: string; reviewDate?: Date | null } = {};
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  if (parsed.data.reviewDate !== undefined) {
    data.reviewDate = parsed.data.reviewDate
      ? new Date(parsed.data.reviewDate)
      : null;
  }

  // S3 (§2.3.1) — every accepted plan earns a check-in. When the coach
  // activates a plan and set no review date of its own, default `reviewDate` to
  // +COACH_CHECKIN_REVIEW_DAYS so the Today check-in card fires in a week. Read
  // the current row first so an explicitly-pinned review date is never
  // clobbered; the read stays owner-scoped, so it leaks no cross-account state.
  // v1.41 — a plan the Coach proposed in a turn carries its review window as
  // the distance from the proposal to its `reviewDate`; taking it on here
  // counts that window from now, exactly like the tap under the answer
  // (`decidePlanProposal`).
  if (parsed.data.status === "active" && parsed.data.reviewDate === undefined) {
    const current = await prisma.coachPlan.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: { reviewDate: true, status: true, createdAt: true },
    });
    if (current && current.reviewDate === null) {
      data.reviewDate = new Date(
        Date.now() + COACH_CHECKIN_REVIEW_DAYS * 86_400_000,
      );
    } else if (current?.reviewDate && current.status === "proposed") {
      const days = clampReviewDays(
        (current.reviewDate.getTime() - current.createdAt.getTime()) /
          86_400_000,
      );
      data.reviewDate = new Date(Date.now() + days * 86_400_000);
    }
  }

  // `updateMany` (not `update`) so an unknown / cross-user / already-deleted id
  // is a 0-count no-op rather than a P2025 throw — the existence channel never
  // leaks across accounts.
  const { count } = await prisma.coachPlan.updateMany({
    where: { id, userId: user.id, deletedAt: null },
    data,
  });

  if (count === 0) {
    // Indistinguishable from "owned by someone else" — never reveal which.
    return apiError("Plan not found", 404);
  }

  const row = await prisma.coachPlan.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true,
      metric: true,
      ifCueEncrypted: true,
      thenActionEncrypted: true,
      targetEncrypted: true,
      status: true,
      reviewDate: true,
      sourceConversationId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!row) {
    // Should not happen (we just updated it), but fail safe.
    return apiError("Plan not found", 404);
  }

  let ifCue: string;
  let thenAction: string;
  try {
    ifCue = decryptFromBytes(row.ifCueEncrypted);
    thenAction = decryptFromBytes(row.thenActionEncrypted);
  } catch {
    // The row updated fine but its key id is no longer in the map — surface the
    // lifecycle change without the (unreadable) prose rather than 500ing.
    annotate({
      action: { name: "coach.plans.updated" },
      meta: { status: row.status },
    });
    return apiSuccess({
      plan: {
        id: row.id,
        metric: row.metric,
        ifCue: null,
        thenAction: null,
        target: null,
        status: row.status,
        reviewDate: row.reviewDate?.toISOString() ?? null,
        sourceConversationId: row.sourceConversationId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  }

  let target: string | null = null;
  if (row.targetEncrypted) {
    try {
      target = decryptFromBytes(row.targetEncrypted);
    } catch {
      target = null;
    }
  }

  annotate({
    action: { name: "coach.plans.updated" },
    meta: { status: row.status },
  });

  return apiSuccess({
    plan: {
      id: row.id,
      metric: row.metric,
      ifCue,
      thenAction,
      target,
      status: row.status,
      reviewDate: row.reviewDate?.toISOString() ?? null,
      sourceConversationId: row.sourceConversationId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  });
});

export const DELETE = apiHandler(
  async (_request: NextRequest, ctx: RouteCtx) => {
    const { user } = await requireAuth();

    const limited = await enforceMutateLimit("delete", user.id);
    if (limited) return limited;

    const { id } = await ctx.params;

    // `updateMany` scoped by BOTH id and userId, active-only: an unknown /
    // cross-user / already-deleted id is a 0-count no-op.
    const { count } = await prisma.coachPlan.updateMany({
      where: { id, userId: user.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    const deleted = count > 0;

    annotate({
      action: { name: "coach.plans.deleted" },
      meta: { deleted },
    });

    return apiSuccess({ deleted });
  },
);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
