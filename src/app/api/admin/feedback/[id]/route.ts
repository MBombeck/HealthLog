/**
 * PATCH /api/admin/feedback/[id] — change status or admin note.
 * DELETE /api/admin/feedback/[id] — archive (soft: sets status to ARCHIVED).
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
  getClientIp,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { updateFeedbackSchema } from "@/lib/validations/feedback";
import type { NextRequest } from "next/server";

export const PATCH = apiHandler(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAdmin();
    const { id } = await ctx.params;

    const { data: body, error: jsonError } = await safeJson(request);
    if (jsonError) return jsonError;

    const parsed = updateFeedbackSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
    }

    const before = await prisma.feedback.findUnique({ where: { id } });
    if (!before) return apiError("Feedback not found", 404);

    const updated = await prisma.feedback.update({
      where: { id },
      data: parsed.data,
      select: {
        id: true,
        status: true,
        adminNote: true,
        updatedAt: true,
      },
    });

    await auditLog("admin.feedback.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        feedbackId: id,
        before: { status: before.status, adminNote: before.adminNote },
        after: parsed.data,
      },
    });

    annotate({
      action: { name: "admin.feedback.update" },
      meta: { feedback_id: id },
    });

    return apiSuccess(updated);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAdmin();
    const { id } = await ctx.params;

    const updated = await prisma.feedback.update({
      where: { id },
      data: { status: "ARCHIVED" },
      select: { id: true, status: true },
    });

    await auditLog("admin.feedback.archive", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { feedbackId: id },
    });

    return apiSuccess(updated);
  },
);
