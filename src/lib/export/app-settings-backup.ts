/**
 * The instance settings, the one section of a backup file that is not the
 * account's. Both backup ends in one file.
 *
 * A disaster-recovery payload carries the singleton `app_settings` row —
 * registration, the MFA requirement, the default locale and timezone, module
 * availability, the notification and AI configuration, the document size cap
 * and quota. Writing it back as a side effect of restoring ONE account
 * reconfigures the host for everybody on it, silently and hours or weeks out
 * of date: an operator putting a single record back on Wednesday has no
 * reason to expect Monday's registration switch and Monday's upload cap to
 * come with it. Putting the instance settings themselves back is a real
 * case, so the write stays available — as an answer the operator gives
 * (`restoreInstanceSettings`), not one the account restore assumes. An
 * account copy does not rebuild a lost host; a database dump and the keys do
 * (`docs/ops/disaster-recovery.md`).
 */
import { DEFAULT_REASONING_MAX_EFFORT } from "@/lib/ai/reasoning/levels";
import type {
  BackupExportContext,
  BackupExportPart,
} from "@/lib/export/export-context";
import type { RestoreContext } from "@/lib/export/restore-context";
import { foldLegacyCoachAvailability } from "@/lib/modules/operator-availability";

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * The instance settings slice: the singleton row, in a disaster-recovery
 * payload only, with its timestamps and its quota made JSON-safe.
 */
export async function buildAppSettingsBackupPart(
  ctx: BackupExportContext,
): Promise<BackupExportPart> {
  const appSettings = ctx.disasterRecovery
    ? await ctx.prisma.appSettings.findUnique({ where: { id: "singleton" } })
    : null;
  return {
    section: {
      appSettings:
        ctx.disasterRecovery && appSettings
          ? {
              ...appSettings,
              adminCodexTokenExpiresAt:
                appSettings.adminCodexTokenExpiresAt?.toISOString() ?? null,
              adminCodexConnectedAt:
                appSettings.adminCodexConnectedAt?.toISOString() ?? null,
              documentQuotaBytes: appSettings.documentQuotaBytes.toString(),
            }
          : null,
    },
    counts: {},
  };
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function restoreAppSettings(ctx: RestoreContext): Promise<void> {
  const { tx, payload } = ctx;
  if (!(payload.appSettings && ctx.restoreInstanceSettings)) return;
  const settings = payload.appSettings;
  // A file from before 0343 carries the Coach's operator answer in module
  // availability; carry it into the Coach switch.
  const coachFold = foldLegacyCoachAvailability(
    settings.moduleAvailabilityJson,
    settings.assistantCoachEnabled,
  );
  const settingsData = {
    registrationEnabled: settings.registrationEnabled,
    mfaRequired: settings.mfaRequired,
    defaultLocale: settings.defaultLocale,
    telegramGlobal: settings.telegramGlobal,
    ntfyGlobal: settings.ntfyGlobal,
    webPushGlobal: settings.webPushGlobal,
    webPushVapidPublicKey: settings.webPushVapidPublicKey,
    webPushVapidPrivateKeyEncrypted: settings.webPushVapidPrivateKeyEncrypted,
    webPushVapidSubject: settings.webPushVapidSubject,
    apiGlobal: settings.apiGlobal,
    umamiEnabled: settings.umamiEnabled,
    umamiScriptUrl: settings.umamiScriptUrl,
    umamiWebsiteId: settings.umamiWebsiteId,
    glitchtipEnabled: settings.glitchtipEnabled,
    glitchtipDsn: settings.glitchtipDsn,
    glitchtipEnvironment: settings.glitchtipEnvironment,
    reminderLateMinutes: settings.reminderLateMinutes,
    reminderMissedMinutes: settings.reminderMissedMinutes,
    adminAiKeyEncrypted: settings.adminAiKeyEncrypted,
    adminAiModel: settings.adminAiModel,
    adminAiBaseUrl: settings.adminAiBaseUrl,
    adminCodexAccessTokenEncrypted: settings.adminCodexAccessTokenEncrypted,
    adminCodexRefreshTokenEncrypted: settings.adminCodexRefreshTokenEncrypted,
    adminCodexAccountIdEncrypted: settings.adminCodexAccountIdEncrypted,
    adminCodexTokenExpiresAt: settings.adminCodexTokenExpiresAt
      ? new Date(settings.adminCodexTokenExpiresAt)
      : null,
    adminCodexConnectedAt: settings.adminCodexConnectedAt
      ? new Date(settings.adminCodexConnectedAt)
      : null,
    adminCodexConnectionStatus: settings.adminCodexConnectionStatus,
    adminAiInsightsFeedbackSummary:
      settings.adminAiInsightsFeedbackSummary as never,
    defaultUserTimezone: settings.defaultUserTimezone,
    assistantEnabled: settings.assistantEnabled,
    assistantCoachEnabled: coachFold.assistantCoachEnabled,
    assistantBriefingEnabled: settings.assistantBriefingEnabled,
    assistantInsightStatusEnabled: settings.assistantInsightStatusEnabled,
    assistantDocumentAiEnabled: settings.assistantDocumentAiEnabled ?? true,
    // Absent on a file written before the controls existed, which restores
    // them at their defaults: allowed, no cap.
    aiReasoningEnabled: settings.aiReasoningEnabled ?? true,
    aiReasoningMaxEffort:
      settings.aiReasoningMaxEffort ?? DEFAULT_REASONING_MAX_EFFORT,
    moduleAvailabilityJson: coachFold.moduleAvailabilityJson as never,
    documentMaxFileBytes: settings.documentMaxFileBytes,
    documentQuotaBytes: BigInt(settings.documentQuotaBytes),
  };
  await tx.appSettings.upsert({
    where: { id: settings.id },
    create: { id: settings.id, ...settingsData },
    update: settingsData,
  });
}
