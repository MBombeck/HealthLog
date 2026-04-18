/**
 * POST /api/admin/feedback/[id]/github — promote feedback to a GitHub Issue.
 *
 * Reuses publishFeedbackToGithub() so the issue body matches the legacy
 * /api/bugreport flow. Idempotent: if gitHubIssueUrl is already set we return
 * the existing URL instead of creating a duplicate.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  publishFeedbackToGithub,
  GithubPublishError,
} from "@/lib/feedback/publish-github";
import type { NextRequest } from "next/server";

export const POST = apiHandler(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { user: admin } = await requireAdmin();
    const { id } = await ctx.params;

    const feedback = await prisma.feedback.findUnique({
      where: { id },
      select: {
        id: true,
        category: true,
        subject: true,
        description: true,
        gitHubIssueUrl: true,
        screenshotBase64: true,
        metadata: true,
        user: { select: { username: true } },
      },
    });
    if (!feedback) return apiError("Feedback not found", 404);

    if (feedback.gitHubIssueUrl) {
      return apiSuccess({
        issueUrl: feedback.gitHubIssueUrl,
        alreadyPublished: true,
      });
    }

    try {
      const result = await publishFeedbackToGithub({
        category: feedback.category,
        subject: feedback.subject,
        description: feedback.description,
        username: feedback.user?.username ?? "anonymous",
        hasScreenshot: Boolean(feedback.screenshotBase64),
        metadata: feedback.metadata,
      });

      await prisma.feedback.update({
        where: { id },
        data: { gitHubIssueUrl: result.issueUrl },
      });

      await auditLog("admin.feedback.github_publish", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { feedbackId: id, issueNumber: result.issueNumber },
      });

      annotate({
        action: { name: "admin.feedback.github_publish" },
        meta: { feedback_id: id, issue_number: result.issueNumber },
      });

      return apiSuccess({ issueUrl: result.issueUrl, alreadyPublished: false });
    } catch (err) {
      if (err instanceof GithubPublishError) {
        return apiError(err.message, err.status);
      }
      throw err;
    }
  },
);
