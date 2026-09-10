import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { adminSettingsSchema } from "@/lib/validations/admin";
import { NextRequest } from "next/server";
import {
  invalidateServerDefaultTimezone,
  isValidTimezone,
} from "@/lib/tz/resolver";
import { summariseGlitchtipDelivery } from "@/lib/monitoring/glitchtip-delivery";

export const dynamic = "force-dynamic";

/** The delivery verdict, flattened onto the settings payload. */
function summariseGlitchtipDeliveryFields(state: {
  lastOkAt?: Date | null;
  lastFailureAt?: Date | null;
  lastFailureReason?: string | null;
}) {
  const summary = summariseGlitchtipDelivery(
    {
      lastOkAt: state.lastOkAt ?? null,
      lastFailureAt: state.lastFailureAt ?? null,
      lastFailureReason: state.lastFailureReason ?? null,
    },
    new Date(),
  );
  return {
    glitchtipReportsDelivering: summary.reportsDelivering,
    glitchtipEverDelivered: summary.everDelivered,
    glitchtipLastFailureReason: summary.lastFailureReason,
    glitchtipDeliveryWindowHours: summary.windowHours,
  };
}

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.settings.get" } });

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  return apiSuccess({
    registrationEnabled: settings?.registrationEnabled ?? true,
    mfaRequired: settings?.mfaRequired ?? false,
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
    // The delivery outcome, not the intent, and resolved here rather than on
    // the client: a DSN that is set and parses says a target was typed, only
    // this says something left the host, and whether it left recently enough
    // is a question about a clock that belongs with the ledger.
    ...summariseGlitchtipDeliveryFields({
      lastOkAt: settings?.glitchtipLastOkAt ?? null,
      lastFailureAt: settings?.glitchtipLastFailureAt ?? null,
      lastFailureReason: settings?.glitchtipLastFailureReason ?? null,
    }),
    reminderLateMinutes: settings?.reminderLateMinutes ?? 120,
    reminderMissedMinutes: settings?.reminderMissedMinutes ?? 240,
    // Document vault limits (per-file cap + per-user quota default). BigInt
    // column → Number for the JSON envelope (values are far below 2^53).
    documentMaxFileBytes: settings?.documentMaxFileBytes ?? 26_214_400,
    documentQuotaBytes:
      settings?.documentQuotaBytes !== undefined
        ? Number(settings.documentQuotaBytes)
        : 1_073_741_824,
    // v1.4.25 W7 — null means "fall back to Europe/Berlin in the
    // resolver"; surfacing the raw value lets the admin UI render
    // an empty picker placeholder until they opt in.
    defaultUserTimezone: settings?.defaultUserTimezone ?? null,
    // Raw column values, not the resolved matrix — the master flag is
    // applied to the sub-flags by `/settings/assistant-flags`, which owns
    // that shape. Echoed here so a write over this route reads back.
    assistantEnabled: settings?.assistantEnabled ?? true,
    assistantCoachEnabled: settings?.assistantCoachEnabled ?? true,
    assistantBriefingEnabled: settings?.assistantBriefingEnabled ?? true,
    assistantInsightStatusEnabled:
      settings?.assistantInsightStatusEnabled ?? true,
    assistantCorrelationsEnabled:
      settings?.assistantCorrelationsEnabled ?? true,
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.settings.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = adminSettingsSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  const data = parsed.data;
  const updates: Record<string, unknown> = {};
  const auditDetails: Record<string, unknown> = {};

  // Boolean fields — direct mapping.
  //
  // The five assistant flags belong here and not only on the dedicated
  // `/settings/assistant-flags` endpoint: `adminSettingsSchema` accepts them
  // so an operator scripting their settings over a single route can carry
  // them, and a schema that accepts a field and then drops it is worse than
  // one that refuses it.
  const booleanFields = [
    "registrationEnabled",
    "mfaRequired",
    "telegramGlobal",
    "ntfyGlobal",
    "webPushGlobal",
    "apiGlobal",
    "umamiEnabled",
    "glitchtipEnabled",
    "assistantEnabled",
    "assistantCoachEnabled",
    "assistantBriefingEnabled",
    "assistantInsightStatusEnabled",
    "assistantCorrelationsEnabled",
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

  // Numeric thresholds
  if (data.reminderLateMinutes !== undefined) {
    updates.reminderLateMinutes = data.reminderLateMinutes;
    auditDetails.reminderLateMinutes = data.reminderLateMinutes;
  }
  if (data.reminderMissedMinutes !== undefined) {
    updates.reminderMissedMinutes = data.reminderMissedMinutes;
    auditDetails.reminderMissedMinutes = data.reminderMissedMinutes;
  }

  // Document vault limits (schema already bounds both; the upload-time
  // resolver clamps the cap to the hard ceiling again as defence-in-depth).
  if (data.documentMaxFileBytes !== undefined) {
    updates.documentMaxFileBytes = data.documentMaxFileBytes;
    auditDetails.documentMaxFileBytes = data.documentMaxFileBytes;
  }
  if (data.documentQuotaBytes !== undefined) {
    updates.documentQuotaBytes = BigInt(data.documentQuotaBytes);
    auditDetails.documentQuotaBytes = data.documentQuotaBytes;
  }

  // v1.4.25 W7 — server-default timezone for new signups.
  // Empty string clears the override (resolver falls back to
  // Europe/Berlin); a non-empty string must pass Intl validation
  // upstream of the column write.
  let didTouchTimezone = false;
  if (data.defaultUserTimezone !== undefined) {
    const trimmed = data.defaultUserTimezone.trim();
    if (trimmed === "") {
      updates.defaultUserTimezone = null;
      auditDetails.defaultUserTimezone = null;
      didTouchTimezone = true;
    } else if (isValidTimezone(trimmed)) {
      updates.defaultUserTimezone = trimmed;
      auditDetails.defaultUserTimezone = trimmed;
      didTouchTimezone = true;
    } else {
      return apiError("Not a valid IANA timezone.", 422);
    }
  }

  if (Object.keys(updates).length === 0) {
    return apiError("No valid fields", 422);
  }

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: updates,
    create: { id: "singleton", ...updates },
  });

  if (didTouchTimezone) {
    invalidateServerDefaultTimezone();
  }

  await auditLog("admin.settings.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: auditDetails,
  });

  return apiSuccess({
    registrationEnabled: settings.registrationEnabled,
    mfaRequired: settings.mfaRequired,
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
    glitchtipEnvironment: settings.glitchtipEnvironment ?? "production",
    ...summariseGlitchtipDeliveryFields({
      lastOkAt: settings.glitchtipLastOkAt,
      lastFailureAt: settings.glitchtipLastFailureAt,
      lastFailureReason: settings.glitchtipLastFailureReason,
    }),
    reminderLateMinutes: settings.reminderLateMinutes,
    reminderMissedMinutes: settings.reminderMissedMinutes,
    documentMaxFileBytes: settings.documentMaxFileBytes,
    documentQuotaBytes: Number(settings.documentQuotaBytes),
    defaultUserTimezone: settings.defaultUserTimezone,
    assistantEnabled: settings.assistantEnabled,
    assistantCoachEnabled: settings.assistantCoachEnabled,
    assistantBriefingEnabled: settings.assistantBriefingEnabled,
    assistantInsightStatusEnabled: settings.assistantInsightStatusEnabled,
    assistantCorrelationsEnabled: settings.assistantCorrelationsEnabled,
  });
});
