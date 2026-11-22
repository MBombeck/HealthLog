/**
 * Every `AppSettings` column with its backup verdict, one table both backup
 * ends read.
 *
 * The export used to spread the whole row into the file and the restore wrote
 * back a list kept by hand, so the two ends disagreed in both directions: the
 * operator's AI usage bounds left in the file and came back as defaults, and
 * any column added to the row, a secret included, rode into every
 * disaster-recovery file without anyone deciding it should. Now the export
 * and the restore both walk this table, the payload schema
 * (`app-settings-backup-schema.ts`) is held to the same set of keys by
 * `app-settings-backup-classification.test.ts`, and the `satisfies` below
 * refuses to compile while a column has no verdict or a codec that does not
 * fit its type.
 *
 * - SETTING: an operator decision. Travels, and the restore writes it back.
 * - CREDENTIAL: an instance key, sealed at rest. Travels the same way: the
 *   disaster-recovery file carries the instance's sealed keys as stored
 *   (`docs/ops/backup-restore.md`), and only that file has an instance
 *   section at all.
 * - OPERATIONAL: this host's own bookkeeping. Never in the file; the restore
 *   leaves the target's value alone.
 */
import type { AppSettings } from "@/generated/prisma/client";
import { DEFAULT_REASONING_MAX_EFFORT } from "@/lib/ai/reasoning/levels";

type Carried<T> = {
  class: "SETTING" | "CREDENTIAL";
  /** How the value is made JSON-safe, fixed by the column's type. */
  codec: [T] extends [Date | null]
    ? "date"
    : [T] extends [bigint]
      ? "bigint"
      : "plain";
  /**
   * What the restore writes when a file older than the column carries
   * nothing for it: the column's default, the value the host ran on when
   * the file was written. Without it, a missing value is not written.
   */
  whenAbsent?: T;
};

type NotCarried = { class: "OPERATIONAL"; reason: string };

export type AppSettingsColumnVerdict<T = unknown> = Carried<T> | NotCarried;

export const APP_SETTINGS_COLUMNS = {
  id: { class: "SETTING", codec: "plain" },
  registrationEnabled: { class: "SETTING", codec: "plain" },
  mfaRequired: { class: "SETTING", codec: "plain" },
  defaultLocale: { class: "SETTING", codec: "plain" },
  telegramGlobal: { class: "SETTING", codec: "plain" },
  ntfyGlobal: { class: "SETTING", codec: "plain" },
  webPushGlobal: { class: "SETTING", codec: "plain" },
  webPushVapidPublicKey: { class: "SETTING", codec: "plain" },
  webPushVapidPrivateKeyEncrypted: { class: "CREDENTIAL", codec: "plain" },
  webPushVapidSubject: { class: "SETTING", codec: "plain" },
  apiGlobal: { class: "SETTING", codec: "plain" },
  umamiEnabled: { class: "SETTING", codec: "plain" },
  umamiScriptUrl: { class: "SETTING", codec: "plain" },
  umamiWebsiteId: { class: "SETTING", codec: "plain" },
  glitchtipEnabled: { class: "SETTING", codec: "plain" },
  glitchtipDsn: { class: "CREDENTIAL", codec: "plain" },
  glitchtipEnvironment: { class: "SETTING", codec: "plain" },
  glitchtipLastOkAt: {
    class: "OPERATIONAL",
    reason:
      "delivery outcome of this host's last error report; a restored value would report deliveries the target never made",
  },
  glitchtipLastFailureAt: {
    class: "OPERATIONAL",
    reason: "delivery outcome, as glitchtipLastOkAt",
  },
  glitchtipLastFailureReason: {
    class: "OPERATIONAL",
    reason: "delivery outcome, as glitchtipLastOkAt",
  },
  reminderLateMinutes: { class: "SETTING", codec: "plain" },
  reminderMissedMinutes: { class: "SETTING", codec: "plain" },
  adminAiKeyEncrypted: { class: "CREDENTIAL", codec: "plain" },
  adminAiModel: { class: "SETTING", codec: "plain" },
  adminAiBaseUrl: { class: "SETTING", codec: "plain" },
  adminCodexAccessTokenEncrypted: { class: "CREDENTIAL", codec: "plain" },
  adminCodexRefreshTokenEncrypted: { class: "CREDENTIAL", codec: "plain" },
  adminCodexAccountIdEncrypted: { class: "CREDENTIAL", codec: "plain" },
  adminCodexTokenExpiresAt: { class: "CREDENTIAL", codec: "date" },
  adminCodexConnectedAt: { class: "CREDENTIAL", codec: "date" },
  adminCodexConnectionStatus: { class: "CREDENTIAL", codec: "plain" },
  adminAiInsightsFeedbackSummary: { class: "SETTING", codec: "plain" },
  defaultUserTimezone: { class: "SETTING", codec: "plain" },
  assistantEnabled: { class: "SETTING", codec: "plain" },
  assistantCoachEnabled: { class: "SETTING", codec: "plain" },
  assistantBriefingEnabled: { class: "SETTING", codec: "plain" },
  assistantInsightStatusEnabled: { class: "SETTING", codec: "plain" },
  assistantDocumentAiEnabled: {
    class: "SETTING",
    codec: "plain",
    whenAbsent: true,
  },
  aiUsageMaxLevel: { class: "SETTING", codec: "plain", whenAbsent: "STANDARD" },
  aiUsageDefaultLevel: {
    class: "SETTING",
    codec: "plain",
    whenAbsent: "STANDARD",
  },
  aiSyncRegenGapHours: { class: "SETTING", codec: "plain", whenAbsent: null },
  aiReasoningEnabled: { class: "SETTING", codec: "plain", whenAbsent: true },
  aiReasoningMaxEffort: {
    class: "SETTING",
    codec: "plain",
    whenAbsent: DEFAULT_REASONING_MAX_EFFORT,
  },
  moduleAvailabilityJson: { class: "SETTING", codec: "plain" },
  documentMaxFileBytes: { class: "SETTING", codec: "plain" },
  documentQuotaBytes: { class: "SETTING", codec: "bigint" },
  correlationSeasonalEngineSince: {
    class: "OPERATIONAL",
    reason:
      "when this host's discovery engine switched; it dates the patterns this host computed, not the file's",
  },
  pulseDayMeanMethod: {
    class: "OPERATIONAL",
    reason:
      "switched only by the admin apply step, which rebuilds every account's stored day means against it; written back without that rebuild, the method and the stored means would disagree for every other account on the host",
  },
  pulseDayMeanAppliedAt: {
    class: "OPERATIONAL",
    reason: "stamp of the apply step on this host, as pulseDayMeanMethod",
  },
  pulseDayMeanDryRunJson: {
    class: "OPERATIONAL",
    reason: "a dry run measured against this host's data",
  },
  workoutClimbBackfillCursor: {
    class: "OPERATIONAL",
    reason: "this host's backfill position",
  },
} as const satisfies {
  [K in keyof AppSettings]-?: AppSettingsColumnVerdict<AppSettings[K]>;
};

export type AppSettingsColumn = keyof typeof APP_SETTINGS_COLUMNS;

/** The columns that travel, in table order. */
export const APP_SETTINGS_CARRIED_COLUMNS: readonly AppSettingsColumn[] = (
  Object.keys(APP_SETTINGS_COLUMNS) as AppSettingsColumn[]
).filter((column) => APP_SETTINGS_COLUMNS[column].class !== "OPERATIONAL");
