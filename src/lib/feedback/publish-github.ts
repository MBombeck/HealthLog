/**
 * GitHub publisher for feedback items.
 *
 * Centralises the GitHub Issues API interaction so /api/bugreport (legacy
 * direct-submit) and /api/admin/feedback/[id]/github (admin-promotes-feedback)
 * share one implementation. Reads the configured token + repo from AppSettings
 * (encrypted) with env-var fallback.
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";

export interface FeedbackInput {
  category: string;
  subject: string;
  description: string;
  username: string;
  hasScreenshot: boolean;
  metadata?: unknown;
}

export interface PublishResult {
  issueNumber: number;
  issueUrl: string;
}

export class GithubPublishError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "GithubPublishError";
  }
}

/**
 * Resolves the configured GitHub token + repo from AppSettings (or env).
 * Returns null if no configuration is present (caller should treat as 503).
 */
export async function getGithubConfig(): Promise<{
  token: string;
  repo: string;
} | null> {
  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      githubIssueTokenEncrypted: true,
      githubIssueRepo: true,
    },
  });

  let configuredToken: string | null = null;
  if (appSettings?.githubIssueTokenEncrypted) {
    try {
      configuredToken = decrypt(appSettings.githubIssueTokenEncrypted);
    } catch {
      getEvent()?.addWarning("Failed to decrypt GitHub issue token");
    }
  }

  const token = configuredToken || process.env.GITHUB_ISSUE_TOKEN || "";
  const repo = appSettings?.githubIssueRepo || process.env.GITHUB_ISSUE_REPO || "";

  if (!token || !repo) return null;
  return { token, repo };
}

/**
 * Sanitise a free-text field for GitHub markdown (strip control chars,
 * neutralise fenced code blocks, hard-cap length).
 */
function sanitize(text: string, max = 5000): string {
  return text.replace(/```/g, "\\`\\`\\`").slice(0, max);
}

/**
 * Publishes a feedback item as a GitHub Issue. Returns issue number + URL.
 * Throws GithubPublishError on API failure.
 */
export async function publishFeedbackToGithub(
  input: FeedbackInput,
): Promise<PublishResult> {
  const config = await getGithubConfig();
  if (!config) {
    throw new GithubPublishError(
      "GitHub publishing is not configured (missing token or repository)",
      503,
    );
  }

  const now = new Date();
  const dateStr = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const safeUsername = input.username.replace(/[`*_~<>\[\]|]/g, "");
  const safeSubject = sanitize(input.subject, 200);
  const safeDescription = sanitize(input.description);

  const categoryLabelMap: Record<string, string> = {
    BUG: "bug",
    FEATURE_REQUEST: "enhancement",
    QUESTION: "question",
    OTHER: "feedback",
  };
  const categoryLabel = categoryLabelMap[input.category] ?? "feedback";

  let body = `**Reported by:** ${safeUsername}\n`;
  body += `**Category:** ${input.category}\n`;
  body += `**Date:** ${dateStr}\n\n`;
  body += `## Description\n\n${safeDescription}\n`;

  if (input.metadata && typeof input.metadata === "object") {
    const meta = input.metadata as Record<string, unknown>;
    const lines: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
      if (value == null) continue;
      const v = String(value).slice(0, 200);
      lines.push(`- **${key}:** ${v.replace(/[`<>]/g, "")}`);
    }
    if (lines.length > 0) {
      body += `\n## Context\n\n${lines.join("\n")}\n`;
    }
  }

  if (input.hasScreenshot) {
    body += `\n**Screenshot:** A screenshot was attached in the original report.`;
  }

  body += `\n\n---\n*Created via HealthLog feedback*`;

  const title = `[${categoryLabel}] ${safeSubject || `Feedback – ${dateStr}`}`;

  const res = await fetch(`https://api.github.com/repos/${config.repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify({
      title,
      body,
      labels: [categoryLabel, "user-reported"],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    getEvent()?.addWarning("GitHub issue creation failed: " + errBody.slice(0, 500));
    throw new GithubPublishError(
      `Failed to create GitHub issue (HTTP ${res.status})`,
      res.status === 401 || res.status === 403 ? res.status : 502,
    );
  }

  const issue = (await res.json()) as { number: number; html_url: string };
  return { issueNumber: issue.number, issueUrl: issue.html_url };
}
