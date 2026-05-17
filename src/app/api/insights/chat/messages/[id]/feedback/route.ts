/**
 * v1.4.23 H7 — Coach assistant-message helpful/unhelpful feedback.
 *
 * POST /api/insights/chat/messages/:id/feedback
 *   Body: { rating: "helpful" | "unhelpful", reason?: string }
 *
 * Reuses the v1.4.16 B5e `RecommendationFeedback` table via the
 * polymorphic `targetType` field added in migration
 * `0040_recommendation_feedback_target_type`. Each Coach feedback row
 * snapshots the user's active prompt-tuning prefs (tone + verbosity)
 * into `metricSourceType` so the daily aggregator can bucket
 * helpful-rate per (promptVersion, tone, verbosity) without a join.
 *
 * The route enforces ownership: the message id must belong to a
 * conversation the authenticated user owns. Cross-account submissions
 * return 404 (never 403 — same lesson as the conversation route, no
 * cross-user existence leak).
 *
 * Idempotency: a partial unique index on
 * `(user_id, coach_message_id) WHERE target_type = 'coach'` dedupes
 * a replay submission for the same message. The Coach surface no
 * longer snapshots assistant prose into `recommendation_text` —
 * v1.4.23 senior-dev review (Sr-H3) flagged that as a silent break of
 * the encryption-at-rest invariant the Coach ships under
 * (`coach_messages.encrypted_content` is AES-256-GCM). Feedback rows
 * now reference the source message via `coachMessageId`; the
 * aggregator never reads the prose anyway, so nothing downstream
 * notices.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { resolveCoachFeedbackAttribution } from "@/lib/ai/feedback-attribution";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";

const coachMessageFeedbackSchema = z.object({
  rating: z.enum(["helpful", "unhelpful"]),
  reason: z.string().min(1).max(200).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function handlePost(request: NextRequest, ctx: RouteContext) {
  const { user } = await requireAuth();
  // v1.4.38 W-C M6 — Coach message feedback is a Coach surface
  // affordance; gate it on the same operator kill-switch so a
  // disabled Coach matrix can't be skirted through the feedback
  // endpoint.
  await requireAssistantSurface("coach");
  const { id: messageId } = await ctx.params;

  // Per-user rate limit — same shape as the recommendation feedback
  // route (60/h). Keeps a chatty client from drowning the bucketing
  // signal.
  const rl = await checkRateLimit(
    `coach-feedback:${user.id}`,
    60,
    60 * 60 * 1000,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "insights.coach.message.feedback" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many feedback submissions, try again later", 429);
  }

  const { data: rawBody, error } = await safeJson<unknown>(request);
  if (error) return error;
  const parsed = coachMessageFeedbackSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "insights.coach.message.feedback" },
      meta: { outcome: "validation_failed" },
    });
    throw new HttpError(422, "feedback.body.invalid");
  }
  const body = parsed.data;

  // Verify ownership only — we no longer touch encryptedContent. The
  // assistant prose stays encrypted-at-rest; the feedback row just
  // references the message id via the FK.
  const message = await prisma.coachMessage.findFirst({
    where: {
      id: messageId,
      role: "assistant",
      conversation: { userId: user.id },
    },
    select: { id: true },
  });
  if (!message) {
    annotate({
      action: { name: "insights.coach.message.feedback" },
      meta: { outcome: "not_found" },
    });
    throw new HttpError(404, "coach.message.notFound");
  }

  const attribution = await resolveCoachFeedbackAttribution(user.id, messageId);

  try {
    const created = await prisma.recommendationFeedback.create({
      data: {
        userId: user.id,
        recommendationId: messageId,
        // v1.4.23 reconcile (Sr-H3): no plaintext prose. The FK
        // resolves the message at read-time when (and only when) a
        // future surface needs to render it.
        coachMessageId: messageId,
        recommendationSeverity: "coach",
        metricSourceType: attribution.metricSourceType,
        metricSourceTimeRange: "single_message",
        helpful: body.rating === "helpful",
        providerType: attribution.providerType,
        promptVersion: attribution.promptVersion,
        targetType: "coach",
        reason: body.reason ?? null,
      },
      select: { id: true, createdAt: true },
    });

    await auditLog("insights.coach.message.feedback", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        feedbackId: created.id,
        messageId,
        rating: body.rating,
        providerType: attribution.providerType,
        promptVersion: attribution.promptVersion,
        metricSourceType: attribution.metricSourceType,
      },
    });

    annotate({
      action: { name: "insights.coach.message.feedback" },
      meta: {
        outcome: "created",
        rating: body.rating,
        providerType: attribution.providerType,
        promptVersion: attribution.promptVersion,
      },
    });

    return apiSuccess({ id: created.id, createdAt: created.createdAt }, 201);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      annotate({
        action: { name: "insights.coach.message.feedback" },
        meta: { outcome: "already_rated" },
      });
      return apiError("already_rated", 409);
    }
    throw err;
  }
}

export const POST = apiHandler(handlePost);
