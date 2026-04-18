/**
 * POST /api/feedback — user submits feedback. Always works, no GitHub needed.
 * GET /api/feedback — user's own feedback history (paginated).
 *
 * Rate-limited at 5 per hour per user. Screenshots are stored as base64 in
 * the database (≤5 MB each).
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { createFeedbackSchema } from "@/lib/validations/feedback";
import { Prisma } from "@/generated/prisma/client";
import type { NextRequest } from "next/server";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`feedback:${user.id}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Too many submissions — please try again later", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = createFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const feedback = await prisma.feedback.create({
    data: {
      userId: user.id,
      email: user.email ?? null,
      category: parsed.data.category,
      subject: parsed.data.subject,
      description: parsed.data.description,
      screenshotBase64: parsed.data.screenshot ?? null,
      metadata:
        parsed.data.metadata !== undefined
          ? (parsed.data.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
    },
    select: { id: true, createdAt: true, category: true, status: true },
  });

  await auditLog("feedback.submit", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      feedbackId: feedback.id,
      category: feedback.category,
      hasScreenshot: Boolean(parsed.data.screenshot),
    },
  });

  annotate({
    action: { name: "feedback.submit" },
    meta: {
      feedback_id: feedback.id,
      category: feedback.category,
    },
  });

  return apiSuccess(feedback, 201);
});

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const url = new URL(request.url);
  const limit = Math.min(
    50,
    Math.max(1, Number(url.searchParams.get("limit") ?? 25)),
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  const [items, total] = await Promise.all([
    prisma.feedback.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        category: true,
        subject: true,
        status: true,
        adminNote: true,
        gitHubIssueUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.feedback.count({ where: { userId: user.id } }),
  ]);

  return apiSuccess({ items, meta: { total, limit, offset } });
});
