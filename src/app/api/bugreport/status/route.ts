/**
 * Returns whether bug report submission is configured (GitHub token + repo).
 *
 * The bug report page uses this to gate its UI so users don't hit a silent
 * 500 when the admin hasn't set up the GitHub integration.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { githubIssueTokenEncrypted: true, githubIssueRepo: true },
  });

  const hasToken = Boolean(
    appSettings?.githubIssueTokenEncrypted || process.env.GITHUB_ISSUE_TOKEN,
  );
  const hasRepo = Boolean(
    appSettings?.githubIssueRepo || process.env.GITHUB_ISSUE_REPO,
  );

  annotate({
    action: { name: "bugreport.status" },
    meta: { configured: hasToken && hasRepo, isAdmin: user.role === "ADMIN" },
  });

  return apiSuccess({
    configured: hasToken && hasRepo,
    hasToken,
    hasRepo,
    isAdmin: user.role === "ADMIN",
  });
});
