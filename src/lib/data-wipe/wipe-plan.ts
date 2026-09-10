/**
 * The one declaration of what "Delete All Data" means.
 *
 * The route this feeds used to carry its delete calls inline. That list was
 * correct on the day it was written and then stopped being correct, silently,
 * every time a model was added to `prisma/schema.prisma` — a new table is
 * user-scoped from birth and outside the wipe by default, and nothing anywhere
 * noticed. Sixty-odd tables accumulated on the wrong side of a confirmation
 * dialog that says "permanently delete all your health data".
 *
 * So the list lives here, next to its own exemption list, and
 * `src/__tests__/data-wipe-completeness.test.ts` enumerates the schema and
 * fails when a model belongs to neither. Adding a model to the schema now
 * forces a decision instead of granting a default.
 *
 * ── The boundary ───────────────────────────────────────────────────────────
 *
 * This action erases everything the account owns EXCEPT what is needed to sign
 * in again. Removing the sign-in credentials too would not be data deletion,
 * it would be account deletion — and that has its own route
 * (`src/app/api/settings/account/route.ts`, which deletes the `User` row and
 * lets the schema's `onDelete: Cascade` do the rest).
 *
 * Everything in {@link WIPE_MODELS} is hard-deleted, including rows that were
 * only soft-deleted before: `deleteMany({ where: { userId } })` carries no
 * `deletedAt` filter, so a tombstone goes with the record.
 *
 * ── Why the list is ordered ────────────────────────────────────────────────
 *
 * Correctness does not depend on the order — every child of a wiped model
 * cascades at the database level. The order exists so the per-model counts in
 * the audit row are truthful: delete a parent first and its children are gone
 * before their own `deleteMany` runs, which would report 0 for rows that did
 * exist. Children therefore come before their parents, and the completeness
 * test asserts that property rather than trusting the author.
 */
import { Prisma } from "@/generated/prisma/client";

/**
 * Every user-scoped model this action deletes, children before parents.
 *
 * Names are Prisma model names; {@link wipeDelegateKey} maps each to its
 * client delegate. Keeping model names (not delegate keys) is what lets the
 * completeness test compare this list against `schema.prisma` literally.
 */
export const WIPE_MODELS = [
  // ── Measurements and their derived tiers ────────────────────────────────
  "Measurement",
  // The rollup tier is a per-day, per-metric reconstruction of the same
  // history. A wipe that leaves it behind is not a wipe.
  "MeasurementRollup",
  // The intraday cumulative profile is the hourly shape of a day that the
  // fold kept after deleting the samples it came from. It is that day's
  // record and nothing else holds it, so a wipe that leaves it behind leaves
  // behind an account's activity pattern.
  "IntradayCumulativeProfile",
  // The health score as it was shown, one row per local day. Not a cache of
  // the live computation — nothing can rebuild a past day once the readings
  // behind it have moved — so leaving it behind leaves behind a record of how
  // the account was doing, day by day, after a confirmation that said
  // otherwise.
  "HealthScoreRecord",
  // The completion ledger before the reminder it hangs off: it cascades either
  // way, but the child deleted first is what keeps its own count truthful on
  // the audit row (v1.37.20, #223 / iOS #68).
  "MeasurementReminderEvent",
  "MeasurementReminder",

  // ── Medication ──────────────────────────────────────────────────────────
  "MedicationIntakeEvent",
  "MedicationPauseEra",
  "MedicationSideEffect",
  "MedicationInventoryItem",
  "MedicationIntakeImportJob",
  "MedicationComplianceRollup",

  // ── Mood ────────────────────────────────────────────────────────────────
  // The day context, before the entry it hangs off: it cascades either way,
  // but a parent deleted first leaves the child's own count reporting zero for
  // rows that existed, and the confirmation screen quotes those counts.
  "MoodContext",
  // Derived, and wiped anyway. The forecast rows are recomputable from the
  // entries above — which is why they stay out of the backup — but they are
  // still a day-by-day statement about somebody's mood, and leaving them
  // behind after a screen that promised to delete all health data would leave
  // the shape of the record standing where the record used to be.
  "MoodPrediction",
  "MoodEntry",
  "MoodEntryRollup",
  "MoodReminderDispatch",
  "MoodTagHidden",

  // ── Visits ──────────────────────────────────────────────────────────────
  // The three link tables cascade from the encounter AND from the far side
  // they point at — a lab result, a document, a condition episode — so they
  // are deleted before any of those, or their per-model counts read zero on an
  // audit row that claims to say what was removed. The encounter follows its
  // own links; the address book it points at is a parent and goes last.
  "EncounterDocumentLink",
  "EncounterLabLink",
  "EncounterConditionLink",
  "Encounter",

  // ── Vaccinations ────────────────────────────────────────────────────────
  // Same ordering argument as the visit links: the document link cascades
  // from the dose AND from the stored document, so it is deleted before
  // either or its count reads zero on the audit row. The dose points at a
  // practitioner and an encounter with SetNull, which is why it goes here,
  // ahead of both.
  "VaccinationDocumentLink",
  "VaccinationRecord",

  // ── Clinical record ─────────────────────────────────────────────────────
  "MentalHealthAssessment",
  "LabResult",
  "Biomarker",
  "CustomMetricEntry",
  "MenstrualCycle",
  "CycleDayLog",
  "CycleSymptom",
  "CycleProfile",
  "CyclePrediction",
  "Allergy",
  "FamilyHistoryEntry",
  "IllnessDayLog",
  "EcgRecording",
  "NutrientIntakeDay",

  // ── Activity ────────────────────────────────────────────────────────────
  "WorkoutInsight",
  "WorkoutInsightGenerationClaim",
  "PersonalRecord",
  "StrainTrimpCache",

  // ── Context and engagement ──────────────────────────────────────────────
  "EnvironmentContext",
  "EnvironmentTravelLocation",
  "HealthProfileFactRevision",
  "CorrelationPattern",
  "UserHealthProfile",
  "UserAchievement",
  "ArrivalReaction",
  "DismissedPriorityItem",
  "RecommendationFeedback",

  // ── Documents ───────────────────────────────────────────────────────────
  "DocumentContentIndex",
  "DocumentThumbnail",
  "DocumentConditionLink",
  "ExtractedFact",
  "ImportJob",

  // ── AI ──────────────────────────────────────────────────────────────────
  "CoachConversation",
  "CoachFact",
  "CoachPlan",
  "CoachReminder",
  "CoachUsage",
  "InsightNarrative",
  "ProviderHealth",

  // ── Sharing ─────────────────────────────────────────────────────────────
  // Deleting the row is the revocation: `resolveShareToken` /
  // `resolveShareGateState` both resolve an unknown `tokenHash` to `null`, and
  // null is the same blunt 404 a revoked link gets.
  "ClinicianShareLink",
  // v1.36.0 — account grants, on BOTH sides (see WIPE_OWNER_FIELDS): the ones
  // this account made over its own record, and the ones it holds over someone
  // else's.
  //
  // Deleting rather than revoking, and the difference is worth stating because
  // the domain module refuses to delete these rows anywhere else. Revocation
  // preserves the row precisely because the row is the consent record — but a
  // person who types the confirmation on "Delete All Data" is asking for the
  // record itself to be gone, and the same request already takes their entire
  // audit history and their consent receipts with it. Leaving a grant behind
  // would also leave a delegate holding live access to an account that just
  // erased everything it had.
  "AccountGrant",

  // ── Integrations ────────────────────────────────────────────────────────
  "WithingsConnection",
  "WithingsOAuthState",
  "WhoopConnection",
  "WhoopOAuthState",
  "WhoopConnectTicket",
  "FitbitConnection",
  "FitbitOAuthState",
  "GoogleHealthConnection",
  "GoogleHealthOAuthState",
  "McpOAuthConnection",
  "IntegrationStatus",

  // ── Notification transports ─────────────────────────────────────────────
  "NotificationChannel",
  "PushSubscription",
  "PushAttempt",
  "NotificationEvent",
  // A Guardian egress claim belongs to both the record whose data prompted
  // the notification and the recipient whose channel would receive it. A
  // wipe by either account must remove it; see WIPE_OWNER_FIELDS below.
  "NotificationEgressAuthorization",
  "Device",
  "TelegramScheduledDeletion",
  "TelegramPromptContext",

  // ── API surface and operational trails ──────────────────────────────────
  "StepUpElevation",
  // Cached response envelopes — the bodies are the health payloads the API
  // just returned.
  "IdempotencyKey",
  "DataBackup",
  // What this host last put in the operator's bucket for this account. The
  // objects themselves stay — the worker holds no DeleteObject grant and the
  // bucket's lifecycle rule owns their retirement — but the row saying when
  // they were written is about this account and goes with it.
  "OffhostBackupState",
  "AuditLog",
  "ConsentReceipt",
  "UserKnownDevice",
  // v1.39 — the setup answers and the step ledger. The USER_RESET block below
  // already puts the wizard of today back to the start; this is the same
  // decision for the needs-based flow, and it belongs on the same side of the
  // line for the same reason: the record the answers were about is gone, so
  // the answers describe nothing.
  "OnboardingRecord",

  // ── Parents, last ───────────────────────────────────────────────────────
  "Medication",
  "MoodTag",
  "MoodTagCategory",
  "CustomMetric",
  "IllnessEpisode",
  "Workout",
  "InboundDocument",
  // Encounters point here with SetNull, so the address book outlives the
  // visits it is attached to and is removed after them.
  "Practitioner",
  "ApiToken",
] as const;

/**
 * User-scoped models this action deliberately keeps, each with the reason.
 *
 * The rule is narrow and stated in the confirmation copy: what the account
 * needs to sign in again survives. Anything added here that is not a sign-in
 * credential needs a reason that survives being read aloud to the person who
 * typed the confirmation.
 */
export const WIPE_EXEMPT: Readonly<Record<string, string>> = {
  Session:
    "the signed-in session performing the wipe; deleting it signs the person out mid-action and the account is preserved",
  RefreshToken:
    "per-device sign-in continuity; deleting it signs every paired device out and is account deletion by another name",
  Passkey: "a sign-in credential — without it the account may be unreachable",
  WebauthnMfaCredential:
    "a second-factor credential; removing it weakens the account rather than clearing data",
  MfaRecoveryCode:
    "the second-factor recovery path; removing it can lock the account out permanently",
  MfaChallenge:
    "an in-flight authentication challenge, seconds-lived and swept by its own expiry",
  AuthChallenge:
    "an in-flight WebAuthn challenge, seconds-lived and swept by its own expiry",
  TrustedDevice:
    "the remember-this-device grant that suppresses a second-factor prompt; a sign-in credential",
  OidcNativeHandoff:
    "an in-flight one-time sign-in code, minutes-lived and swept by its own expiry",
  InviteRedemption:
    "the instance's registration ledger, not the person's record; even account deletion only detaches it (onDelete: SetNull) rather than removing it",
};

/**
 * Models that carry no `userId` and belong to the instance rather than to any
 * account, so no wipe of a single account may touch them.
 *
 * Everything else without a `userId` reaches a wiped or exempt model through a
 * chain of `onDelete: Cascade` relations and needs no entry here; the
 * completeness test proves that reachability rather than assuming it.
 */
export const INSTANCE_SCOPED: Readonly<Record<string, string>> = {
  AppSettings: "instance-wide configuration singleton",
  RateLimit: "instance-wide rate-limit buckets, keyed by string, self-expiring",
  HostMetric: "instance-wide host telemetry, not attributable to an account",
  CycleSymptomCategory:
    "seeded catalogue shared by every account; a user's custom symptoms live on CycleSymptom",
  IllnessSymptom: "seeded symptom catalogue shared by every account",
  InviteToken:
    "the instance's invite ledger; the creator relation cascades on account deletion, and a data wipe keeps the account",
  User: "the account itself — preserved by definition; its columns are handled by USER_RESET / USER_KEPT_FIELDS",
};

/**
 * The `User` columns this action clears, and the value each is reset to.
 *
 * The same rot applies here: a column added to `User` is personal data from
 * birth and outside the reset by default. The completeness test compares these
 * keys against the model's scalar columns, so a new column has to be
 * classified.
 *
 * `Prisma.DbNull` rather than `null` for the JSON columns — on a nullable JSON
 * field `null` is the JSON value `null`, not SQL NULL.
 */
export const USER_RESET = {
  // Body and identity-of-the-record
  heightCm: null,
  dateOfBirth: null,
  gender: null,
  hasDiabetes: false,
  fullName: null,
  displayName: null,
  insurerName: null,
  insuranceNumberEncrypted: null,
  insurerIkNumber: null,
  lastReportPracticeName: null,
  avatarBytes: null,
  avatarContentType: null,
  avatarUpdatedAt: null,

  // Where the person lives — an environment-context input, and a location
  homeLat: null,
  homeLon: null,
  homeLabel: null,
  homeTimezone: null,
  homeSince: null,

  // Derived AI output cached on the row
  insightsPrivacyMode: "aggregated",
  insightsCachedAt: null,
  insightsCachedText: null,
  insightsCachedLocale: null,
  insightsSnapshotHash: null,
  insightsWarmFailedAt: null,
  insightsBriefingRerollDate: null,
  morningDigestRefreshedOn: null,
  insightsExcludeMetrics: [],
  insightsLayoutJson: Prisma.DbNull,

  // AI provider configuration and keys
  aiProvider: null,
  aiModel: null,
  aiBaseUrl: null,
  aiAnthropicKeyEncrypted: null,
  aiLocalKeyEncrypted: null,
  aiOpenaiKeyEncrypted: null,
  aiCompatBaseUrl: null,
  aiCompatKeyEncrypted: null,
  aiCompatModel: null,
  aiProviderChain: Prisma.DbNull,
  aiResponseTimeoutSeconds: null,
  disableCoach: false,
  coachPrefsJson: Prisma.DbNull,
  coachLastSeenAt: null,
  documentsAutoAiRead: false,
  labsLocalOcrEnabled: false,
  codexAccessTokenEncrypted: null,
  codexRefreshTokenEncrypted: null,
  codexTokenExpiresAt: null,
  codexConnectedAt: null,
  codexConnectionStatus: "disconnected",
  useCentralCodex: false,

  // Integration credentials and per-integration state
  telegramBotToken: null,
  telegramChatId: null,
  telegramEnabled: false,
  withingsClientIdEncrypted: null,
  withingsClientSecretEncrypted: null,
  whoopClientIdEncrypted: null,
  whoopClientSecretEncrypted: null,
  fitbitClientIdEncrypted: null,
  fitbitClientSecretEncrypted: null,
  googleHealthClientIdEncrypted: null,
  googleHealthClientSecretEncrypted: null,
  nightscoutUrlEncrypted: null,
  nightscoutTokenEncrypted: null,
  nightscoutAllowPrivateHost: false,
  polarAccessTokenEncrypted: null,
  polarUserIdEncrypted: null,
  polarClientIdEncrypted: null,
  polarClientSecretEncrypted: null,
  ouraAccessTokenEncrypted: null,
  ouraRefreshTokenEncrypted: null,
  ouraClientIdEncrypted: null,
  ouraClientSecretEncrypted: null,
  stravaClientIdEncrypted: null,
  stravaClientSecretEncrypted: null,
  stravaAccessTokenEncrypted: null,
  stravaRefreshTokenEncrypted: null,
  stravaAthleteId: null,
  stravaLastActivityAt: null,
  stravaBackfillCompletedAt: null,
  healthKitConfigJson: Prisma.DbNull,
  healthKitLastSyncedAt: null,
  healthKitLastSyncTrigger: null,
  healthKitLastBackgroundSyncAt: null,
  lastSyncedAt: null,
  sourcePriorityJson: Prisma.DbNull,

  // Choices that describe the record rather than the interface
  thresholdsJson: Prisma.DbNull,
  dashboardWidgetsJson: Prisma.DbNull,
  medicationListLayoutJson: Prisma.DbNull,
  moodTagLayoutJson: Prisma.DbNull,
  reportSelectionJson: Prisma.DbNull,
  modulePreferencesJson: Prisma.DbNull,
  healthScoreConfigJson: Prisma.DbNull,
  globalExcludedInjectionSites: [],
  moodReminderEnabled: false,
  notificationPrefs: Prisma.DbNull,

  // Back to the start of the tour — the record it was built around is gone
  onboardingCompletedAt: null,
  onboardingTourCompleted: false,
  onboardingTourProgressJson: Prisma.DbNull,
} satisfies Prisma.UserUpdateInput;

/**
 * `User` columns the wipe leaves alone, each with the reason. Same contract as
 * {@link WIPE_EXEMPT}: sign-in, identity, and how the interface is rendered.
 */
export const USER_KEPT_FIELDS: Readonly<Record<string, string>> = {
  id: "the account's primary key",
  username: "the account's sign-in identity",
  email: "the account's sign-in identity and recovery address",
  passwordHash: "a sign-in credential — the account password",
  role: "the account's authorisation level, set by the operator",
  oidcIssuer: "a sign-in credential — the external identity binding",
  oidcSub: "a sign-in credential — the external identity binding",
  createdAt: "when the account was created; the account is preserved",
  updatedAt: "row bookkeeping maintained by Prisma",
  managedProfileAt:
    "whether this record is one somebody else runs — account shape, not record content. Clearing it would strip the guardian's reach from a record that has no credentials of its own, leaving an account nobody can open, administer or delete. Emptying a record is not emancipating the person in it.",
  totpSecretEncrypted: "a second-factor credential",
  totpConfirmedAt: "second-factor enrolment state",
  totpLastStep:
    "second-factor replay guard; clearing it re-opens a replay window",
  mfaEnforced: "the operator's per-account second-factor policy",
  passkeyUpgradeNudgeDismissed:
    "an interface nudge the person already dismissed",
  timezone: "an interface preference — how dates and times are rendered",
  locale: "an interface preference — which language the interface speaks",
  unitPreference: "an interface preference — metric or imperial rendering",
  timeFormat: "an interface preference — 12- or 24-hour rendering",
  dateFormat: "an interface preference — date-order rendering",
  glucoseUnit: "an interface preference — mg/dL or mmol/L rendering",
  disclaimerAcknowledgedAt:
    "the account's acknowledgement of the medical disclaimer, which is about the app and not about the record",
  disclaimerAcknowledgedVersion:
    "the version of the medical disclaimer the account acknowledged",
  documentQuotaBytes:
    "a per-account storage quota set by the operator, not by the person",
};

/**
 * Wiped models that do NOT carry a `userId`, and the columns that say the row
 * belongs to an account.
 *
 * The convention is one `userId` column and almost every table keeps it. A
 * table that relates two accounts cannot: an account grant names an owner and
 * a delegate, and a wipe by either of them has to take the row.
 *
 * Declared here rather than at the wipe route, so the route keeps asking for
 * exactly one thing — "delete this model's rows for this account" — and the
 * question of what "for this account" means for a given model stays in the
 * file that already answers every other question about the wipe.
 * {@link resolveWipeDelegate} translates; the route is unaware.
 */
export const WIPE_OWNER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // The record owner owns the import payload. The actor is durable audit
  // attribution and must not let deleting a manager erase another record's
  // import history.
  MedicationIntakeImportJob: ["recordUserId"],
  NotificationEvent: ["recordUserId"],
  NotificationEgressAuthorization: ["recordUserId", "recipientUserId"],
  // Both sides. Wiping only the grantor side would leave the account still
  // holding read access to other people's records after it asked for
  // everything of its own to be deleted.
  AccountGrant: ["grantorId", "granteeId"],
};

/**
 * Models the ADMIN wipe keeps although the per-account wipe deletes them.
 *
 * `DELETE /api/admin/data` is the same action pointed at every account at
 * once: the operator clearing a box before handing it on. It therefore reads
 * {@link WIPE_MODELS} rather than a list of its own — that list was written
 * inline once and had drifted to nine tables against a schema of a hundred and
 * twenty-two by the time anybody counted.
 *
 * The two actions differ in exactly one place, and it is written here rather
 * than folded into the route so the difference has to be argued for.
 */
export const ADMIN_WIPE_EXEMPT: Readonly<Record<string, string>> = {
  AccountGrant:
    "a grant is the only way into a managed profile — that record has no credentials of its own, so deleting every grant at once would leave a set of accounts nobody can open, administer or delete. This action preserves accounts by definition, and an access edge without the record behind it is not personal data: everything those profiles hold is wiped with everyone else's.",
};

/**
 * Every model the admin wipe deletes, for all accounts, children first.
 *
 * Derived, so a model added to {@link WIPE_MODELS} is in both wipes at once
 * and a model excused from this one has to say why above.
 */
export const ADMIN_WIPE_MODELS: readonly string[] = WIPE_MODELS.filter(
  (model) => !(model in ADMIN_WIPE_EXEMPT),
);

/**
 * Budget for a wipe transaction.
 *
 * Prisma's default interactive-transaction timeout is 5 s, which was already
 * optimistic for thirteen `deleteMany` statements and is not survivable for
 * the full model set on an account with a large import behind it — let alone
 * for the admin wipe, which runs the same set across every account. The whole
 * action is one transaction on purpose: a half-applied wipe is worse than
 * none, because the person is told it succeeded either way.
 */
export const WIPE_TRANSACTION_TIMEOUT_MS = 120_000;
export const WIPE_TRANSACTION_MAX_WAIT_MS = 15_000;

/** Prisma client delegate key for a model name (`MoodEntry` → `moodEntry`). */
export function wipeDelegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * The `where` that selects one account's rows of `model`.
 *
 * `{ userId }` for the convention, an `OR` over the declared owner columns for
 * the models that relate two accounts.
 */
export function wipeWhere(model: string, userId: string): object {
  const fields = WIPE_OWNER_FIELDS[model];
  if (!fields) return { userId };
  return { OR: fields.map((field) => ({ [field]: userId })) };
}

/** The narrow slice of a Prisma delegate the wipe loop uses. */
export interface UserScopedDeleteDelegate {
  deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
}

/** The same slice for the admin wipe, which selects no account at all. */
export interface UnscopedDeleteDelegate {
  deleteMany(args: Record<string, never>): Promise<{ count: number }>;
}

interface RawDeleteDelegate {
  deleteMany(args: { where?: object }): Promise<{ count: number }>;
}

/**
 * The Prisma delegate for a model name, or a thrown error naming the model.
 *
 * One documented cast: {@link WIPE_MODELS} is a literal list of model names
 * checked against `schema.prisma` by the completeness test, and every entry
 * indexes a delegate that exposes `deleteMany`. The test also asserts every
 * entry resolves, so an unresolvable name fails the build rather than the
 * request.
 */
function rawDelegate(client: object, model: string): RawDeleteDelegate {
  const delegate = (client as Record<string, RawDeleteDelegate>)[
    wipeDelegateKey(model)
  ];
  if (!delegate || typeof delegate.deleteMany !== "function") {
    throw new Error(`No Prisma delegate for wipe model "${model}"`);
  }
  return delegate;
}

/**
 * Resolve a model name to its delegate on a client or transaction handle.
 *
 * A model listed in {@link WIPE_OWNER_FIELDS} gets a wrapper that rewrites the
 * caller's `{ userId }` into that model's own ownership predicate. The caller
 * still says "this account's rows" and still gets a count back; only the
 * translation moved, and it moved to the file that declares the columns rather
 * than to the loop that does not know about them.
 */
export function resolveWipeDelegate(
  client: object,
  model: string,
): UserScopedDeleteDelegate {
  const delegate = rawDelegate(client, model);
  if (!WIPE_OWNER_FIELDS[model]) {
    return delegate as UserScopedDeleteDelegate;
  }
  return {
    deleteMany: ({ where }) =>
      delegate.deleteMany({ where: wipeWhere(model, where.userId) }),
  };
}

/**
 * Resolve a model name to a delegate that deletes every row of it.
 *
 * The admin wipe asks a different question from the per-account one — "every
 * row of this model" rather than "this account's rows" — so it gets its own
 * resolver instead of a `where` the caller has to remember to leave out.
 * {@link WIPE_OWNER_FIELDS} is irrelevant here by construction: with no
 * account to select, a row that belongs to two of them is deleted once.
 */
export function resolveGlobalWipeDelegate(
  client: object,
  model: string,
): UnscopedDeleteDelegate {
  const delegate = rawDelegate(client, model);
  return { deleteMany: () => delegate.deleteMany({}) };
}
