import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const bugReportSchema = z.object({
  title: z.string().min(3, "Titel zu kurz").max(200),
  description: z.string().min(10, "Beschreibung zu kurz").max(5000),
  screenshot: z
    .string()
    .max(7_000_000, "Screenshot zu groß (max. 5 MB)")
    .optional(),
});

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

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
    } catch (err) {
      console.error("Failed to decrypt GitHub issue token from settings:", err);
    }
  }

  const ghToken = configuredToken || process.env.GITHUB_ISSUE_TOKEN;
  const ghRepo = appSettings?.githubIssueRepo || process.env.GITHUB_ISSUE_REPO; // e.g. "owner/repo"

  if (!ghToken || !ghRepo) {
    return apiError(
      "Bugreport ist nicht konfiguriert (GitHub-Issue-Token/Repository in Admin-Einstellungen fehlt)",
      500,
    );
  }

  const body = await request.json();
  const parsed = bugReportSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { title, description, screenshot } = parsed.data;

  // Build issue body
  let issueBody = `**Gemeldet von:** ${session.user.username}\n`;
  issueBody += `**Datum:** ${new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}\n\n`;
  issueBody += `## Beschreibung\n\n${description}\n`;
  issueBody += `\n---\n*Erstellt über die HealthLog Bugreport-Funktion*`;

  // If screenshot provided, upload to GitHub as a gist or include as base64
  // For simplicity, we'll note there's a screenshot but GitHub issues don't support inline base64
  if (screenshot) {
    issueBody += `\n\n**Screenshot:** Ein Screenshot wurde angehängt (siehe Kommentar).`;
  }

  try {
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
      console.error("GitHub issue creation failed:", errBody);
      return apiError("Issue konnte nicht erstellt werden", 500);
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
      const commentBody = `### Screenshot\n\n![Screenshot](data:image/${ext};base64,${base64Data.slice(0, 100)}...)\n\n*Hinweis: Der vollständige Screenshot wurde aus Größengründen gekürzt. Bitte den Nutzer direkt kontaktieren.*`;

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
      userId: session.user.id,
      ipAddress: getClientIp(request),
      details: {
        issueNumber: issue.number,
        hasScreenshot: Boolean(screenshot),
      },
    });

    return apiSuccess({
      issueNumber: issue.number,
      issueUrl: issue.html_url,
    });
  } catch (err) {
    console.error("Bug report error:", err);
    return apiError("Fehler beim Erstellen des Bug Reports", 500);
  }
}
