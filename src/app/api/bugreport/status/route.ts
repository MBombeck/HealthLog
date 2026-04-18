/**
 * Returns whether bug report submission is configured (GitHub token + repo).
 *
 * The bug report page uses this to gate its UI so users don't hit a silent
 * 500 when the admin hasn't set up the GitHub integration. Only two booleans
 * escape: a single `configured` flag and `isAdmin` so the page can render
 * the admin-specific copy + admin link. Token/repo granularity is kept
 * server-side (log annotation only) so we don't hand regular users a probe.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // Light rate limit — the endpoint is cheap, but no reason to let a logged-in
  // client hammer Postgres in a loop.
  const rl = await checkRateLimit(
    `bugreport-status:${user.id}`,
    30,
    60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Rate limit exceeded", 429);
  }

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
  const configured = hasToken && hasRepo;

  annotate({
    action: { name: "bugreport.status" },
    meta: { configured, has_token: hasToken, has_repo: hasRepo },
  });

  return apiSuccess({ configured, isAdmin: user.role === "ADMIN" });
});
