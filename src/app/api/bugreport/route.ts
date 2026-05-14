import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

// Strict image/* data URL (no SVG — it can carry inline JS).
const SCREENSHOT_DATA_URL =
  /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const bugReportSchema = z.object({
  description: z.string().min(10, "Description too short").max(5000),
  screenshot: z
    .string()
    .max(7_000_000, "Screenshot too large (max 5 MB)")
    .regex(
      SCREENSHOT_DATA_URL,
      "Screenshot must be a base64-encoded PNG/JPEG/WEBP/GIF data URL",
    )
    .optional(),
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`bugreport:${user.id}`, 3, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 3 bug reports per hour", 429);
  }

  annotate({ action: { name: "bugreport.submit" } });

  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      githubIssueTokenEncrypted: true,
      githubIssueRepo: true,
      bugReportEnabled: true,
    },
  });

  // v1.4.3: explicit toggle. When the admin disables bug reports we
  // return 503 immediately — the client already renders a "not
  // configured" UI for that status, so the report button gracefully
  // disappears without needing additional client-side wiring.
  if (appSettings && appSettings.bugReportEnabled === false) {
    return apiError("Bug reports are disabled by the administrator", 503);
  }

  let configuredToken: string | null = null;
  if (appSettings?.githubIssueTokenEncrypted) {
    try {
      configuredToken = decrypt(appSettings.githubIssueTokenEncrypted);
    } catch {
      getEvent()?.addWarning("Failed to decrypt GitHub issue token");
    }
  }

  const ghToken = configuredToken || process.env.GITHUB_ISSUE_TOKEN;
  const ghRepo = appSettings?.githubIssueRepo || process.env.GITHUB_ISSUE_REPO; // e.g. "owner/repo"

  if (!ghToken || !ghRepo) {
    // 503 instead of 500: the client keys off status to render the "not
    // configured" screen. The user also sees a clear message rather than
    // "Internal server error".
    return apiError(
      "Bug report not configured (GitHub issue token/repository missing in admin settings)",
      503,
    );
  }

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = bugReportSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { description, screenshot } = parsed.data;

  // GitHub issues are maintainer-facing and the repo's primary language is English.
  // Use an ISO-8601 timestamp so titles are unambiguous and sortable.
  const now = new Date();
  const dateStr = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const title = `Bug Report – ${dateStr}`;

  // Sanitize user-provided content for GitHub markdown. Strip HTML tags
  // entirely (prevents `<img onerror=>` etc.) and neutralise markdown link
  // targets that start with dangerous schemes like javascript: or data:.
  const safeUsername = user.username.replace(/[`*_~<>\[\]|]/g, "");
  const safeDescription = description
    .replace(/<[^>]*>/g, "") // strip HTML tags
    .replace(/\]\(\s*(javascript|data|vbscript|file):/gi, "](about:blank#") // neutralise dangerous markdown link schemes
    .replace(/```/g, "\\`\\`\\`")
    .slice(0, 5000);

  // Wrap the user's description in a fenced code block so any residual
  // markdown renders literally rather than as executable markup.
  let issueBody = `**Reported by:** ${safeUsername}\n`;
  issueBody += `**Date:** ${dateStr}\n\n`;
  issueBody += `## Description\n\n\`\`\`\n${safeDescription}\n\`\`\`\n`;
  issueBody += `\n---\n*Created via HealthLog bug report*`;

  // If screenshot provided, upload to GitHub as a gist or include as base64
  // For simplicity, we'll note there's a screenshot but GitHub issues don't support inline base64
  if (screenshot) {
    issueBody += `\n\n**Screenshot:** A screenshot was attached (see comment).`;
  }

  // Create the issue
  const issueRes = await fetch(
    `https://api.github.com/repos/${ghRepo}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
      },
      body: JSON.stringify({
        title: `[Bug] ${title}`,
        body: issueBody,
        labels: ["bug", "user-reported"],
      }),
    },
  );

  if (!issueRes.ok) {
    const errBody = await issueRes.text();
    getEvent()?.addWarning("GitHub issue creation failed: " + errBody);
    return apiError("Failed to create issue", 500);
  }

  const issue = (await issueRes.json()) as {
    number: number;
    html_url: string;
  };

  // If screenshot, upload as a comment
  if (screenshot) {
    // Extract just the base64 part
    const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
    const ext = screenshot.startsWith("data:image/png") ? "png" : "jpg";

    // Upload screenshot as issue comment with embedded image
    // GitHub doesn't support base64 in comments, so we note the limitation
    const commentBody = `### Screenshot\n\n![Screenshot](data:image/${ext};base64,${base64Data.slice(0, 100)}...)\n\n*Note: The full screenshot was truncated due to size limits. Please contact the user directly.*`;

    await fetch(
      `https://api.github.com/repos/${ghRepo}/issues/${issue.number}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghToken}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github.v3+json",
        },
        body: JSON.stringify({ body: commentBody }),
      },
    );
  }

  await auditLog("bugreport.submit", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      issueNumber: issue.number,
      hasScreenshot: Boolean(screenshot),
    },
  });

  annotate({ meta: { issue_number: issue.number } });

  return apiSuccess({
    issueNumber: issue.number,
    issueUrl: issue.html_url,
  });
});
