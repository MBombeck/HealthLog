/**
 * The verdict for every `User` column that is not a setting.
 *
 * Part of the account-settings domain: `account-settings-backup.ts` composes
 * these with the settings its codec table declares into
 * `USER_COLUMN_BACKUP_CLASS`.
 */
/**
 * Every column of the `User` row, and whether it travels.
 *
 * The models (`backup-plan.ts`) are decided one table at a time. The account row cannot
 * be: it holds the person's own choices next to their sign-in credentials,
 * the integration keys, the operator's policy for the account and a dozen
 * cursors, and a single verdict for the whole row would either leave the
 * choices behind or carry the credentials with them. Before this table the
 * row was simply not in the backup, so a restore brought the record back and
 * dropped units, language, time zone, modules, reminder thresholds and the
 * rest of how the account had been set up.
 *
 * `SETTING`     — something the person chose. Exported in the
 *                 `accountSettings` section and written back to the account
 *                 being restored, column by column, after the same checks
 *                 the settings routes apply. A setting is a column with a
 *                 codec in `ACCOUNT_SETTING_CODECS`
 *                 (`account-settings-backup.ts`), which is where its verdict
 *                 comes from; this file holds every other verdict.
 * `CREDENTIAL`  — a secret, a token, a provider registration or an external
 *                 identity binding, and the state that only means something
 *                 next to one. A backup file is not a credential store; the
 *                 same reasoning as `ApiToken` in the backup plan.
 * `IDENTITY`    — what the account IS rather than how it is set up: its key,
 *                 its sign-in name, its role, whether it is a managed record,
 *                 and the limits the operator set for it. A restore puts data
 *                 back into an account; it never changes which account that
 *                 is or what the operator allowed it.
 * `OPERATIONAL` — cursors, caches and timestamps this host wrote while
 *                 working for the account. Carrying them would assert work
 *                 the receiving host never did, the reason `IntegrationStatus`
 *                 and `ProviderHealth` are excluded from the backup.
 *
 * `src/__tests__/user-column-backup-classification.test.ts` reads the
 * schema and fails on a column that is missing here, so a new column gets a
 * decision rather than a default.
 */
export type UserColumnBackupClass =
  "SETTING" | "CREDENTIAL" | "IDENTITY" | "OPERATIONAL";

/** The `User` columns that are not settings, each with its verdict. */
export const USER_COLUMNS_OUTSIDE_SETTINGS = {
  // ── Identity ──────────────────────────────────────────────────────────────
  id: "IDENTITY",
  username: "IDENTITY",
  email: "IDENTITY",
  role: "IDENTITY",
  createdAt: "IDENTITY",
  updatedAt: "IDENTITY",
  // Whether somebody else runs this record. Account shape, and the gate for
  // the guardian's reach: the wipe keeps it for the same reason.
  managedProfileAt: "IDENTITY",
  // The operator's per-account policy and quota, set by the operator and not
  // by the person; a file from Monday must not undo Tuesday's decision.
  mfaEnforced: "IDENTITY",
  documentQuotaBytes: "IDENTITY",

  // The account's deletion lifecycle on this host: when deletion was asked
  // for, when the purge job erases the account, and who asked. A copy must
  // never carry it: restoring a file taken from a pending account would lock
  // the account it lands in, and one taken before would undo nothing an admin
  // did not mean to undo.
  deletionRequestedAt: "OPERATIONAL",
  deletionPurgeAt: "OPERATIONAL",
  deletionRequestedById: "OPERATIONAL",

  // ── Credentials ───────────────────────────────────────────────────────────
  passwordHash: "CREDENTIAL",
  oidcIssuer: "CREDENTIAL",
  oidcSub: "CREDENTIAL",
  totpSecretEncrypted: "CREDENTIAL",
  totpConfirmedAt: "CREDENTIAL",
  totpLastStep: "CREDENTIAL",
  codexAccessTokenEncrypted: "CREDENTIAL",
  codexRefreshTokenEncrypted: "CREDENTIAL",
  codexTokenExpiresAt: "CREDENTIAL",
  codexConnectedAt: "CREDENTIAL",
  codexConnectionStatus: "CREDENTIAL",
  aiAnthropicKeyEncrypted: "CREDENTIAL",
  aiLocalKeyEncrypted: "CREDENTIAL",
  aiOpenaiKeyEncrypted: "CREDENTIAL",
  aiCompatKeyEncrypted: "CREDENTIAL",
  // The bot token, the chat it is bound to, and the switch that only means
  // something with both: the same reasoning as `NotificationChannel`.
  telegramBotToken: "CREDENTIAL",
  telegramChatId: "CREDENTIAL",
  telegramEnabled: "CREDENTIAL",
  withingsClientIdEncrypted: "CREDENTIAL",
  withingsClientSecretEncrypted: "CREDENTIAL",
  whoopClientIdEncrypted: "CREDENTIAL",
  whoopClientSecretEncrypted: "CREDENTIAL",
  fitbitClientIdEncrypted: "CREDENTIAL",
  fitbitClientSecretEncrypted: "CREDENTIAL",
  googleHealthClientIdEncrypted: "CREDENTIAL",
  googleHealthClientSecretEncrypted: "CREDENTIAL",
  // The address is stored sealed beside its token because it can carry one,
  // and the private-host exemption is a security decision about that one
  // connection, not a preference that should arrive ahead of it.
  nightscoutUrlEncrypted: "CREDENTIAL",
  nightscoutTokenEncrypted: "CREDENTIAL",
  nightscoutAllowPrivateHost: "CREDENTIAL",
  // The Dawarich connection, credentials like the Nightscout pair. The
  // sealed preferences name a place id on that instance, which means nothing
  // without the key, so they stay behind with it.
  dawarichUrlEncrypted: "CREDENTIAL",
  dawarichApiKeyEncrypted: "CREDENTIAL",
  dawarichPrefsEncrypted: "CREDENTIAL",
  dawarichAllowPrivateHost: "CREDENTIAL",
  polarAccessTokenEncrypted: "CREDENTIAL",
  polarUserIdEncrypted: "CREDENTIAL",
  polarClientIdEncrypted: "CREDENTIAL",
  polarClientSecretEncrypted: "CREDENTIAL",
  ouraAccessTokenEncrypted: "CREDENTIAL",
  ouraRefreshTokenEncrypted: "CREDENTIAL",
  ouraClientIdEncrypted: "CREDENTIAL",
  ouraClientSecretEncrypted: "CREDENTIAL",
  // What the Oura grant on this host does not cover; meaningless beside a
  // grant that does not travel, and found out again by the first sync.
  ouraScopeDenied: "CREDENTIAL",
  ouraUserId: "CREDENTIAL",
  // Names the guardian whose provider app the record borrows; the app itself
  // does not travel, so neither does the marker.
  clientAppSharedBy: "CREDENTIAL",
  stravaClientIdEncrypted: "CREDENTIAL",
  stravaClientSecretEncrypted: "CREDENTIAL",
  stravaAccessTokenEncrypted: "CREDENTIAL",
  stravaRefreshTokenEncrypted: "CREDENTIAL",
  stravaAthleteId: "CREDENTIAL",

  // ── Operational ───────────────────────────────────────────────────────────
  insightsCachedAt: "OPERATIONAL",
  insightsCachedTextEncrypted: "OPERATIONAL",
  insightsCachedLocale: "OPERATIONAL",
  insightsSnapshotHash: "OPERATIONAL",
  insightsWarmFailedAt: "OPERATIONAL",
  insightsBriefingRerollDate: "OPERATIONAL",
  morningDigestRefreshedOn: "OPERATIONAL",
  coachLastSeenAt: "OPERATIONAL",
  stravaLastActivityAt: "OPERATIONAL",
  stravaBackfillCompletedAt: "OPERATIONAL",
  stravaBackfillResumeBefore: "OPERATIONAL",
  // The restored account's Oura backfill reads its history again from the
  // provider; a carried note would claim history this host never imported.
  ouraBackfillProgress: "OPERATIONAL",
  ouraBackfillCompletedAt: "OPERATIONAL",
  healthKitLastSyncedAt: "OPERATIONAL",
  healthKitLastSyncTrigger: "OPERATIONAL",
  healthKitLastBackgroundSyncAt: "OPERATIONAL",
  lastSyncedAt: "OPERATIONAL",
  // The restore stamps its own: paired clients' cursors from before it must
  // be refused, which a carried value would undo.
  syncResetAt: "OPERATIONAL",
  // The air-quality history backfill's progress; the restored
  // account's job recounts it on its next run.
  environmentAqHistoryJson: "OPERATIONAL",
} as const satisfies Readonly<
  Record<string, Exclude<UserColumnBackupClass, "SETTING">>
>;
