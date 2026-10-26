/**
 * The account settings slice of the backup payload schema.
 *
 * Part of the account settings backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";

/**
 * The account's own settings: the `User` columns `USER_COLUMN_BACKUP_CLASS`
 * calls `SETTING`, by column name. Never a credential, an identity column or
 * the host's own bookkeeping on the row.
 *
 * Every field is optional: a column a file does not carry leaves the account
 * as it is, so a file from a release with fewer setting columns restores
 * what it has. Types are checked here; whether a value is one this host will
 * write (a known language, an allowed AI endpoint, an image the upload would
 * accept) is decided by the restore, which drops and names what it refuses
 * rather than refusing the whole account over one preference.
 *
 * The insurance number arrives as `insuranceNumberEncrypted` (ciphertext) in
 * a disaster-recovery file and as `insuranceNumber` (readable) in a portable
 * one, the split every other sealed column uses.
 */
export const accountSettingsBackupSchema = z
  .object({
    heightCm: z.number().nullable().optional(),
    dateOfBirth: isoDateTime.nullable().optional(),
    gender: z.string().nullable().optional(),
    hasDiabetes: z.boolean().optional(),
    displayName: z.string().nullable().optional(),
    fullName: z.string().nullable().optional(),
    insurerName: z.string().nullable().optional(),
    insuranceNumber: z.string().nullable().optional(),
    insuranceNumberEncrypted: z.string().nullable().optional(),
    insurerIkNumber: z.string().nullable().optional(),
    lastReportPracticeName: z.string().nullable().optional(),
    avatarBytes: base64BytesSchema.nullable().optional(),
    avatarContentType: z.string().nullable().optional(),
    avatarUpdatedAt: isoDateTime.nullable().optional(),
    homeLat: z.number().nullable().optional(),
    homeLon: z.number().nullable().optional(),
    homeLabel: z.string().nullable().optional(),
    homeTimezone: z.string().nullable().optional(),
    homeSince: isoDateTime.nullable().optional(),
    // The sealed home location rides a disaster-recovery file
    // as ciphertext; a portable file carries the readable home above.
    homeLocationEncrypted: base64BytesSchema.nullable().optional(),
    environmentAirQualityEnabled: z.boolean().optional(),
    timezone: z.string().optional(),
    locale: z.string().nullable().optional(),
    unitPreference: z.string().nullable().optional(),
    glucoseUnit: z.string().nullable().optional(),
    timeFormat: z.string().optional(),
    dateFormat: z.string().optional(),
    modulePreferencesJson: z.unknown().optional(),
    thresholdsJson: z.unknown().optional(),
    healthScoreConfigJson: z.unknown().optional(),
    sourcePriorityJson: z.unknown().optional(),
    dashboardWidgetsJson: z.unknown().optional(),
    insightsLayoutJson: z.unknown().optional(),
    medicationListLayoutJson: z.unknown().optional(),
    moodTagLayoutJson: z.unknown().optional(),
    documentsLayoutJson: z.unknown().optional(),
    moduleListLayoutJson: z.unknown().optional(),
    // Retired in v1.46.0 with its column (the preview-feature opt-ins). A file
    // written by v1.44 or v1.45 still carries it; it is accepted and ignored,
    // because no codec reads it, so such a file restores everything else.
    previewFeaturesJson: z.unknown().optional(),
    activityGoalsJson: z.unknown().optional(),
    reportSelectionJson: z.unknown().optional(),
    globalExcludedInjectionSites: z.array(z.string()).optional(),
    healthKitConfigJson: z.unknown().optional(),
    notificationPrefs: z.unknown().optional(),
    moodReminderEnabled: z.boolean().optional(),
    aiProvider: z.string().nullable().optional(),
    aiModel: z.string().nullable().optional(),
    aiBaseUrl: z.string().nullable().optional(),
    aiCompatBaseUrl: z.string().nullable().optional(),
    aiCompatModel: z.string().nullable().optional(),
    aiProviderChain: z.unknown().optional(),
    aiResponseTimeoutSeconds: z.number().int().nullable().optional(),
    useCentralCodex: z.boolean().optional(),
    insightsPrivacyMode: z.string().optional(),
    insightsExcludeMetrics: z.array(z.string()).optional(),
    disableCoach: z.boolean().optional(),
    // The account's AI usage level; the codec checks the value.
    aiUsageLevel: z.string().nullable().optional(),
    coachPrefsJson: z.unknown().optional(),
    documentsAutoAiRead: z.boolean().optional(),
    labsLocalOcrEnabled: z.boolean().optional(),
    storeWorkoutRoutes: z.boolean().optional(),
    onboardingCompletedAt: isoDateTime.nullable().optional(),
    onboardingTourCompleted: z.boolean().optional(),
    onboardingTourProgressJson: z.unknown().optional(),
    disclaimerAcknowledgedAt: isoDateTime.nullable().optional(),
    disclaimerAcknowledgedVersion: z.string().nullable().optional(),
    passkeyUpgradeNudgeDismissed: z.boolean().optional(),
  })
  .passthrough();
