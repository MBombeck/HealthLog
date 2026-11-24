/**
 * The app settings slice of the backup payload schema.
 *
 * Part of the app settings backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import { AiUsageLevel } from "@/generated/prisma/enums";
import { REASONING_MAX_EFFORTS } from "@/lib/ai/reasoning/levels";
import { isoDateTime } from "@/lib/export/backup-schema-kit";

export const appSettingsBackupSchema = z
  .object({
    id: z.string().min(1),
    registrationEnabled: z.boolean(),
    mfaRequired: z.boolean(),
    // 1.50. Absent on an older file; the host keeps its own values.
    mfaRequiredForAdmins: z.boolean().optional(),
    mfaGraceDays: z.number().int().min(0).max(90).optional(),
    defaultLocale: z.string(),
    telegramGlobal: z.boolean(),
    ntfyGlobal: z.boolean(),
    webPushGlobal: z.boolean(),
    webPushVapidPublicKey: z.string().nullable(),
    webPushVapidPrivateKeyEncrypted: z.string().nullable(),
    webPushVapidSubject: z.string().nullable(),
    apiGlobal: z.boolean(),
    umamiEnabled: z.boolean(),
    umamiScriptUrl: z.string().nullable(),
    umamiWebsiteId: z.string().nullable(),
    glitchtipEnabled: z.boolean(),
    glitchtipDsn: z.string().nullable(),
    glitchtipEnvironment: z.string().nullable(),
    reminderLateMinutes: z.number().int(),
    reminderMissedMinutes: z.number().int(),
    adminAiKeyEncrypted: z.string().nullable(),
    adminAiModel: z.string(),
    adminAiBaseUrl: z.string(),
    adminCodexAccessTokenEncrypted: z.string().nullable(),
    adminCodexRefreshTokenEncrypted: z.string().nullable(),
    adminCodexAccountIdEncrypted: z.string().nullable(),
    adminCodexTokenExpiresAt: isoDateTime.nullable(),
    adminCodexConnectedAt: isoDateTime.nullable(),
    adminCodexConnectionStatus: z.string(),
    adminAiInsightsFeedbackSummary: z.unknown().nullable(),
    defaultUserTimezone: z.string().nullable(),
    assistantEnabled: z.boolean(),
    assistantCoachEnabled: z.boolean(),
    assistantBriefingEnabled: z.boolean(),
    assistantInsightStatusEnabled: z.boolean(),
    // Optional: a backup written before the switch existed carries none, and
    // restores it at its default. A backup from before the Correlations switch
    // was retired still carries that key; `passthrough` keeps it harmless and
    // the restore writes nothing for it.
    assistantDocumentAiEnabled: z.boolean().optional(),
    // Optional for the same reason.
    aiReasoningEnabled: z.boolean().optional(),
    aiReasoningMaxEffort: z.enum(REASONING_MAX_EFFORTS).optional(),
    // The operator's AI usage bounds. Optional: a file from before 1.49 left
    // them out although the columns existed, and the restore then leaves the
    // host's own values alone (`app-settings-columns.ts`).
    aiUsageMaxLevel: z.enum(AiUsageLevel).optional(),
    aiUsageDefaultLevel: z.enum(AiUsageLevel).optional(),
    // The admin write path's bounds (`adminAiUsageSchema`).
    aiSyncRegenGapHours: z.number().int().min(1).max(48).nullable().optional(),
    moduleAvailabilityJson: z.unknown().nullable(),
    documentMaxFileBytes: z.number().int(),
    documentQuotaBytes: z.string().regex(/^\d+$/),
    // 1.49 — the first-admin server setup's stamp and step states. Absent on
    // a file written before the setup existed; a restore then leaves them as
    // the server has them.
    serverSetupCompletedAt: isoDateTime.nullable().optional(),
    serverSetupStepsJson: z.unknown().nullable().optional(),
    // 1.49 — the operator's answer to the relay question (CHECK in migration
    // 0556). Absent on an older file; the host keeps its own answer.
    pushRelayDecision: z.enum(["on", "off"]).nullable().optional(),
  })
  .passthrough();
