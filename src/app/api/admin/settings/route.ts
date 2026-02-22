import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { adminSettingsSchema } from "@/lib/validations/admin";
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
    webPushVapidPublicKey: settings?.webPushVapidPublicKey ?? null,
    webPushVapidSubject: settings?.webPushVapidSubject ?? null,
    webPushVapidConfigured: Boolean(
      settings?.webPushVapidPublicKey &&
        settings?.webPushVapidPrivateKeyEncrypted &&
        settings?.webPushVapidSubject,
    ),
    apiGlobal: settings?.apiGlobal ?? true,
    umamiEnabled: settings?.umamiEnabled ?? false,
    umamiScriptUrl: settings?.umamiScriptUrl ?? null,
    umamiWebsiteId: settings?.umamiWebsiteId ?? null,
    glitchtipEnabled: settings?.glitchtipEnabled ?? false,
    glitchtipDsn: settings?.glitchtipDsn ?? null,
    glitchtipEnvironment: settings?.glitchtipEnvironment ?? "production",
    bugReportRepo: settings?.githubIssueRepo ?? null,
    bugReportConfigured: Boolean(
      settings?.githubIssueRepo && settings?.githubIssueTokenEncrypted,
    ),
    reminderLateMinutes: settings?.reminderLateMinutes ?? 120,
    reminderMissedMinutes: settings?.reminderMissedMinutes ?? 240,
    moodLogGlobal: settings?.moodLogGlobal ?? true,
  });
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  try {
    const body = await request.json();
    const parsed = adminSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const data = parsed.data;
    const updates: Record<string, unknown> = {};
    const auditDetails: Record<string, unknown> = {};

    // Boolean fields — direct mapping
    const booleanFields = [
      "registrationEnabled",
      "telegramGlobal",
      "ntfyGlobal",
      "webPushGlobal",
      "apiGlobal",
      "umamiEnabled",
      "glitchtipEnabled",
      "moodLogGlobal",
    ] as const;
    for (const field of booleanFields) {
      if (data[field] !== undefined) {
        updates[field] = data[field];
        auditDetails[field] = data[field];
      }
    }

    if (data.defaultLocale !== undefined) {
      updates.defaultLocale = data.defaultLocale;
      auditDetails.defaultLocale = data.defaultLocale;
    }

    // String fields that map directly (with empty → null)
    if (data.webPushVapidPublicKey !== undefined) {
      const value = data.webPushVapidPublicKey.trim();
      updates.webPushVapidPublicKey = value || null;
      auditDetails.webPushVapidPublicKey = value ? "configured" : null;
    }

    if (data.webPushVapidSubject !== undefined) {
      const value = data.webPushVapidSubject.trim();
      updates.webPushVapidSubject = value || null;
      auditDetails.webPushVapidSubject = value || null;
    }

    // Encrypted fields
    if (data.webPushVapidPrivateKey !== undefined) {
      const value = data.webPushVapidPrivateKey.trim();
      if (value) {
        updates.webPushVapidPrivateKeyEncrypted = encrypt(value);
        auditDetails.webPushVapidPrivateKeyUpdated = true;
      }
    }
    if (data.clearWebPushVapidPrivateKey === true) {
      updates.webPushVapidPrivateKeyEncrypted = null;
      auditDetails.webPushVapidPrivateKeyUpdated = false;
    }

    // URL fields with normalization
    if (data.umamiScriptUrl !== undefined) {
      const value = data.umamiScriptUrl.trim();
      if (!value) {
        updates.umamiScriptUrl = null;
        auditDetails.umamiScriptUrl = null;
      } else {
        const parsed = new URL(value);
        if (parsed.pathname === "/" || parsed.pathname === "") {
          parsed.pathname = "/script.js";
        }
        updates.umamiScriptUrl = parsed.toString();
        auditDetails.umamiScriptUrl = parsed.toString();
      }
    }

    if (data.umamiWebsiteId !== undefined) {
      const value = data.umamiWebsiteId.trim();
      updates.umamiWebsiteId = value || null;
      auditDetails.umamiWebsiteId = value || null;
    }

    if (data.glitchtipDsn !== undefined) {
      const value = data.glitchtipDsn.trim();
      if (!value) {
        updates.glitchtipDsn = null;
        auditDetails.glitchtipDsn = null;
      } else {
        updates.glitchtipDsn = new URL(value).toString();
        auditDetails.glitchtipDsn = "configured";
      }
    }

    if (data.glitchtipEnvironment !== undefined) {
      const value = data.glitchtipEnvironment.trim();
      updates.glitchtipEnvironment = value || null;
      auditDetails.glitchtipEnvironment = value || null;
    }

    // Bug report
    if (data.bugReportRepo !== undefined) {
      const repo = data.bugReportRepo.trim();
      updates.githubIssueRepo = repo || null;
      auditDetails.bugReportRepo = repo || null;
    }
    if (data.bugReportToken !== undefined) {
      const token = data.bugReportToken.trim();
      if (token) {
        updates.githubIssueTokenEncrypted = encrypt(token);
        auditDetails.bugReportTokenUpdated = true;
      }
    }
    if (data.clearBugReportToken === true) {
      updates.githubIssueTokenEncrypted = null;
      auditDetails.bugReportTokenUpdated = false;
    }

    // Numeric thresholds
    if (data.reminderLateMinutes !== undefined) {
      updates.reminderLateMinutes = data.reminderLateMinutes;
      auditDetails.reminderLateMinutes = data.reminderLateMinutes;
    }
    if (data.reminderMissedMinutes !== undefined) {
      updates.reminderMissedMinutes = data.reminderMissedMinutes;
      auditDetails.reminderMissedMinutes = data.reminderMissedMinutes;
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
      webPushVapidPublicKey: settings.webPushVapidPublicKey,
      webPushVapidSubject: settings.webPushVapidSubject,
      webPushVapidConfigured: Boolean(
        settings.webPushVapidPublicKey &&
          settings.webPushVapidPrivateKeyEncrypted &&
          settings.webPushVapidSubject,
      ),
      apiGlobal: settings.apiGlobal,
      umamiEnabled: settings.umamiEnabled,
      umamiScriptUrl: settings.umamiScriptUrl,
      umamiWebsiteId: settings.umamiWebsiteId,
      glitchtipEnabled: settings.glitchtipEnabled,
      glitchtipDsn: settings.glitchtipDsn,
      glitchtipEnvironment:
        settings.glitchtipEnvironment ?? "production",
      bugReportRepo: settings.githubIssueRepo,
      bugReportConfigured: Boolean(
        settings.githubIssueRepo && settings.githubIssueTokenEncrypted,
      ),
      reminderLateMinutes: settings.reminderLateMinutes,
      reminderMissedMinutes: settings.reminderMissedMinutes,
      moodLogGlobal: settings.moodLogGlobal,
    });
  } catch (err) {
    console.error("Admin settings update error:", err);
    return apiError("Einstellungen konnten nicht gespeichert werden", 500);
  }
}
