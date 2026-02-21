import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  return apiSuccess({
    registrationEnabled: settings?.registrationEnabled ?? true,
    defaultLocale: settings?.defaultLocale ?? "de",
    telegramGlobal: settings?.telegramGlobal ?? true,
    ntfyGlobal: settings?.ntfyGlobal ?? true,
    webPushGlobal: settings?.webPushGlobal ?? true,
    apiGlobal: settings?.apiGlobal ?? true,
    umamiEnabled: settings?.umamiEnabled ?? false,
    umamiScriptUrl: settings?.umamiScriptUrl ?? "https://cloud.umami.is/script.js",
    umamiWebsiteId: settings?.umamiWebsiteId ?? null,
    glitchtipEnabled: settings?.glitchtipEnabled ?? false,
    glitchtipDsn: settings?.glitchtipDsn ?? null,
    glitchtipEnvironment: settings?.glitchtipEnvironment ?? "production",
    bugReportRepo: settings?.githubIssueRepo ?? null,
    bugReportConfigured: Boolean(
      settings?.githubIssueRepo && settings?.githubIssueTokenEncrypted,
    ),
  });
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  try {
    const body = await request.json();
    const updates: Record<string, unknown> = {};
    const auditDetails: Record<string, unknown> = {};

    if (typeof body.registrationEnabled === "boolean") {
      updates.registrationEnabled = body.registrationEnabled;
      auditDetails.registrationEnabled = body.registrationEnabled;
    }
    if (
      typeof body.defaultLocale === "string" &&
      ["de", "en"].includes(body.defaultLocale)
    ) {
      updates.defaultLocale = body.defaultLocale;
      auditDetails.defaultLocale = body.defaultLocale;
    }
    if (typeof body.telegramGlobal === "boolean") {
      updates.telegramGlobal = body.telegramGlobal;
      auditDetails.telegramGlobal = body.telegramGlobal;
    }
    if (typeof body.ntfyGlobal === "boolean") {
      updates.ntfyGlobal = body.ntfyGlobal;
      auditDetails.ntfyGlobal = body.ntfyGlobal;
    }
    if (typeof body.webPushGlobal === "boolean") {
      updates.webPushGlobal = body.webPushGlobal;
      auditDetails.webPushGlobal = body.webPushGlobal;
    }
    if (typeof body.apiGlobal === "boolean") {
      updates.apiGlobal = body.apiGlobal;
      auditDetails.apiGlobal = body.apiGlobal;
    }
    if (typeof body.umamiEnabled === "boolean") {
      updates.umamiEnabled = body.umamiEnabled;
      auditDetails.umamiEnabled = body.umamiEnabled;
    }
    if (typeof body.umamiScriptUrl === "string") {
      const value = body.umamiScriptUrl.trim();
      if (!value) {
        updates.umamiScriptUrl = null;
        auditDetails.umamiScriptUrl = null;
      } else {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          return apiError("Umami Script-URL ist ungültig", 422);
        }
        if (!["https:", "http:"].includes(parsed.protocol)) {
          return apiError("Umami Script-URL muss mit http:// oder https:// beginnen", 422);
        }
        updates.umamiScriptUrl = parsed.toString();
        auditDetails.umamiScriptUrl = parsed.toString();
      }
    }
    if (typeof body.umamiWebsiteId === "string") {
      const value = body.umamiWebsiteId.trim();
      updates.umamiWebsiteId = value.length > 0 ? value : null;
      auditDetails.umamiWebsiteId = value.length > 0 ? value : null;
    }
    if (typeof body.glitchtipEnabled === "boolean") {
      updates.glitchtipEnabled = body.glitchtipEnabled;
      auditDetails.glitchtipEnabled = body.glitchtipEnabled;
    }
    if (typeof body.glitchtipDsn === "string") {
      const value = body.glitchtipDsn.trim();
      if (!value) {
        updates.glitchtipDsn = null;
        auditDetails.glitchtipDsn = null;
      } else {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          return apiError("Glitchtip DSN ist ungültig", 422);
        }
        if (!["https:", "http:"].includes(parsed.protocol)) {
          return apiError("Glitchtip DSN muss mit http:// oder https:// beginnen", 422);
        }
        updates.glitchtipDsn = parsed.toString();
        auditDetails.glitchtipDsn = "configured";
      }
    }
    if (typeof body.glitchtipEnvironment === "string") {
      const value = body.glitchtipEnvironment.trim();
      updates.glitchtipEnvironment = value.length > 0 ? value : null;
      auditDetails.glitchtipEnvironment = value.length > 0 ? value : null;
    }

    if (typeof body.bugReportRepo === "string") {
      const repo = body.bugReportRepo.trim();
      if (repo.length === 0) {
        updates.githubIssueRepo = null;
        auditDetails.bugReportRepo = null;
      } else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        return apiError("GitHub-Repository muss im Format owner/repo sein", 422);
      } else {
        updates.githubIssueRepo = repo;
        auditDetails.bugReportRepo = repo;
      }
    }

    if (typeof body.bugReportToken === "string") {
      const token = body.bugReportToken.trim();
      if (token.length > 0) {
        updates.githubIssueTokenEncrypted = encrypt(token);
        auditDetails.bugReportTokenUpdated = true;
      }
    }

    if (body.clearBugReportToken === true) {
      updates.githubIssueTokenEncrypted = null;
      auditDetails.bugReportTokenUpdated = false;
    }

    if (Object.keys(updates).length === 0) {
      return apiError("Keine gültigen Felder", 422);
    }

    const settings = await prisma.appSettings.upsert({
      where: { id: "singleton" },
      update: updates,
      create: { id: "singleton", ...updates },
    });

    await auditLog("admin.settings.update", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: auditDetails,
    });

    return apiSuccess({
      registrationEnabled: settings.registrationEnabled,
      defaultLocale: settings.defaultLocale,
      telegramGlobal: settings.telegramGlobal,
      ntfyGlobal: settings.ntfyGlobal,
      webPushGlobal: settings.webPushGlobal,
      apiGlobal: settings.apiGlobal,
      umamiEnabled: settings.umamiEnabled,
      umamiScriptUrl:
        settings.umamiScriptUrl ?? "https://cloud.umami.is/script.js",
      umamiWebsiteId: settings.umamiWebsiteId,
      glitchtipEnabled: settings.glitchtipEnabled,
      glitchtipDsn: settings.glitchtipDsn,
      glitchtipEnvironment:
        settings.glitchtipEnvironment ?? "production",
      bugReportRepo: settings.githubIssueRepo,
      bugReportConfigured: Boolean(
        settings.githubIssueRepo && settings.githubIssueTokenEncrypted,
      ),
    });
  } catch (err) {
    console.error("Admin settings update error:", err);
    return apiError("Einstellungen konnten nicht gespeichert werden", 500);
  }
}
