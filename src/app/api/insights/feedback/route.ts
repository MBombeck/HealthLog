import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { resolveFeedbackAttribution } from "@/lib/ai/feedback-attribution";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { recommendationFeedbackRequestSchema } from "@/lib/validations/recommendation-feedback";

/**
 * v1.4.16 phase B5e — POST /api/insights/feedback.
 *
 * Per-recommendation thumbs-up / thumbs-down. The body contains the
 * rec id + snapshot text + severity + metric-source attributes the
 * client just rendered. Server-side fills providerType + promptVersion
 * via `resolveFeedbackAttribution()` so the client cannot tamper with
 * the slice the daily aggregator computes.
 *
 * The endpoint is idempotent via `withIdempotency()` — a retry with
 * the same `Idempotency-Key` for the same `(userId, method, path)`
 * replays the cached response with `X-Idempotent-Replay: true`.
 *
 * 201 on insert; 409 on the `(userId, recommendationId,
 * recommendationText)` unique violation (the user already rated this
 * exact rec text). 422 on a validation failure.
 */
async function handlePost(request: NextRequest) {
  const { user } = await requireAuth();

  // v1.4.16 phase D reconcile (code-review H5 / security M1) — bound
  // the per-user write rate. Without this, a single client can
  // distort the daily aggregator's bucket slice by varying
  // recommendationId/text per request (the unique index only catches
  // exact replays). 60/h is generous: a comprehensive insight rarely
  // has >10 recs, so ≥6 regenerations/h before throttle hits.
  const rl = await checkRateLimit(
    `insights-feedback:${user.id}`,
    60,
    60 * 60 * 1000,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "insights.recommendation.feedback" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many feedback submissions, try again later", 429);
  }

  const { data: rawBody, error } = await safeJson<unknown>(request, {
    maxBytes: 64 * 1024,
  });
  if (error) return error;

  const parsed = recommendationFeedbackRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "insights.recommendation.feedback" },
      meta: { outcome: "validation_failed" },
    });
    return apiValidationError(
      "Invalid feedback payload",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }
  const body = parsed.data;

  const attribution = await resolveFeedbackAttribution(user.id);

  try {
    const created = await prisma.recommendationFeedback.create({
      data: {
        userId: user.id,
        recommendationId: body.recommendationId,
        recommendationText: body.recommendationText,
        recommendationSeverity: body.recommendationSeverity,
        metricSourceType: body.metricSourceType,
        metricSourceTimeRange: body.metricSourceTimeRange,
        helpful: body.helpful,
        providerType: attribution.providerType,
        promptVersion: attribution.promptVersion,
      },
      select: { id: true, createdAt: true },
    });

    await auditLog("insights.recommendation.feedback", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        feedbackId: created.id,
        recommendationId: body.recommendationId,
        severity: body.recommendationSeverity,
        helpful: body.helpful,
        providerType: attribution.providerType,
        promptVersion: attribution.promptVersion,
      },
    });

    annotate({
      action: { name: "insights.recommendation.feedback" },
      meta: {
        outcome: "created",
        severity: body.recommendationSeverity,
        helpful: body.helpful,
        providerType: attribution.providerType,
      },
    });

    return apiSuccess({ id: created.id, createdAt: created.createdAt }, 201);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      annotate({
        action: { name: "insights.recommendation.feedback" },
        meta: { outcome: "already_rated" },
      });
      return apiError("already_rated", 409);
    }
    throw err;
  }
}

export const POST = apiHandler(withIdempotency(handlePost));
