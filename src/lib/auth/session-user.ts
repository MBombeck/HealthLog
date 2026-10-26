import type { Prisma } from "@/generated/prisma/client";

/**
 * The columns of `User` that ride on every authenticated request.
 *
 * Every cookie session and every Bearer token resolves its caller through one
 * of the lookups in `session.ts` / `bearer.ts`, so whatever this projection
 * names is read once per request, for every request the app serves. The row it
 * replaced was the whole `users` record, and that record carries a profile
 * picture of up to a few megabytes, the cached briefing text, the encrypted
 * home location and air-quality history, and every stored integration
 * credential. None of that is needed to answer "who is calling", and all of it
 * was copied into a fresh buffer on each request.
 *
 * So the projection is an allowlist: small scalars that the request path reads
 * (identity, role, locale and display preferences, the onboarding and MFA
 * flags, the small preference documents). Anything else is read by the one
 * route that needs it, with its own `select`, at the moment it needs it:
 *
 *   - bytes and large text: `avatarBytes`, `insightsCachedTextEncrypted`,
 *     `homeLocationEncrypted`,
 *     `environmentAqHistoryJson`, `dawarichPrefsEncrypted`;
 *   - credentials and secrets: `passwordHash`, `totpSecretEncrypted`,
 *     `totpLastStep`, `telegramBotToken`, every `*Encrypted` integration and
 *     provider key, `insuranceNumberEncrypted`.
 *
 * `src/__tests__/session-user-projection-guard.test.ts` holds both halves: no
 * caller lookup may load the full row, and none of the columns above may join
 * this list.
 */
export const SESSION_USER_SELECT = {
  id: true,
  username: true,
  email: true,
  role: true,
  oidcIssuer: true,
  oidcSub: true,
  createdAt: true,
  updatedAt: true,
  managedProfileAt: true,
  // Pending deletion: the session and Bearer resolvers refuse the account,
  // and the acting-account resolver refuses it as a record.
  deletionRequestedAt: true,
  heightCm: true,
  dateOfBirth: true,
  gender: true,
  timezone: true,
  homeTimezone: true,
  homeSince: true,
  environmentAirQualityEnabled: true,
  codexTokenExpiresAt: true,
  codexConnectedAt: true,
  codexConnectionStatus: true,
  useCentralCodex: true,
  insightsPrivacyMode: true,
  insightsCachedAt: true,
  insightsCachedLocale: true,
  insightsSnapshotHash: true,
  insightsWarmFailedAt: true,
  insightsBriefingRerollDate: true,
  morningDigestRefreshedOn: true,
  telegramChatId: true,
  telegramEnabled: true,
  nightscoutAllowPrivateHost: true,
  dawarichAllowPrivateHost: true,
  ouraScopeDenied: true,
  stravaAthleteId: true,
  stravaLastActivityAt: true,
  stravaBackfillCompletedAt: true,
  stravaBackfillResumeBefore: true,
  locale: true,
  thresholdsJson: true,
  dashboardWidgetsJson: true,
  insightsLayoutJson: true,
  medicationListLayoutJson: true,
  documentsLayoutJson: true,
  moodTagLayoutJson: true,
  glucoseUnit: true,
  hasDiabetes: true,
  labsLocalOcrEnabled: true,
  unitPreference: true,
  timeFormat: true,
  dateFormat: true,
  aiProvider: true,
  aiModel: true,
  aiBaseUrl: true,
  aiCompatBaseUrl: true,
  aiCompatModel: true,
  aiProviderChain: true,
  aiResponseTimeoutSeconds: true,
  documentsAutoAiRead: true,
  onboardingCompletedAt: true,
  onboardingTourCompleted: true,
  onboardingTourProgressJson: true,
  disclaimerAcknowledgedAt: true,
  disclaimerAcknowledgedVersion: true,
  healthKitConfigJson: true,
  healthKitLastSyncedAt: true,
  healthKitLastSyncTrigger: true,
  healthKitLastBackgroundSyncAt: true,
  displayName: true,
  lastReportPracticeName: true,
  coachPrefsJson: true,
  sourcePriorityJson: true,
  lastSyncedAt: true,
  syncResetAt: true,
  moodReminderEnabled: true,
  reportSelectionJson: true,
  notificationPrefs: true,
  disableCoach: true,
  aiUsageLevel: true,
  modulePreferencesJson: true,
  healthScoreConfigJson: true,
  documentQuotaBytes: true,
  coachLastSeenAt: true,
  avatarContentType: true,
  avatarUpdatedAt: true,
  totpConfirmedAt: true,
  mfaEnforced: true,
  passkeyUpgradeNudgeDismissed: true,
  fullName: true,
  insurerName: true,
  insurerIkNumber: true,
} as const satisfies Prisma.UserSelect;

/** The caller as every authenticated request sees them. */
export type SessionUser = Prisma.UserGetPayload<{
  select: typeof SESSION_USER_SELECT;
}>;
