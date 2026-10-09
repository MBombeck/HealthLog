import type { ModuleKey } from "@/lib/modules/registry";

/**
 * Every Settings card the command palette lists on its own, with the anchor
 * that lands on it (`/settings/<section>#<anchor>`).
 *
 * Most anchors are the `anchor` prop of the card's `SettingsCardHeader`; a
 * few are older wrapper ids (the integration providers, `#channels`,
 * `#sharing`, `#thresholds`, the reminder and Coach memory cards). The test
 * `settings-cards.test.ts` reads the settings sources and fails when an
 * anchor listed here exists nowhere, so a renamed card cannot quietly turn
 * into a link to the top of its page.
 *
 * Left out on purpose: notices that come and go (the passkey nudge, a
 * pending handover decision, score change notices, the AI operator notice),
 * cards that only exist when the operator configured a channel (Telegram,
 * ntfy, Web Push, email, document sources, the central Codex switch), and
 * sections that are a single card, where the section entry is the card.
 */
export interface SettingsCardEntry {
  /** The settings section slug, or a `layout/<module>` sub-page. */
  section: string;
  anchor: string;
  /** i18n key of the card title, as the card itself renders it. */
  titleKey: string;
  /** Shown only while one of these modules is on. */
  modules?: ReadonlyArray<ModuleKey>;
}

export const SETTINGS_CARDS: ReadonlyArray<SettingsCardEntry> = [
  // ── Account ──
  { section: "account", anchor: "avatar", titleKey: "settings.avatar.title" },
  { section: "account", anchor: "profile", titleKey: "settings.profile" },
  {
    section: "account",
    anchor: "display",
    titleKey: "settings.displayCard.title",
  },
  // ── Security ──
  {
    section: "security",
    anchor: "two-factor",
    titleKey: "settings.security.totp.title",
  },
  {
    section: "security",
    anchor: "security-keys",
    titleKey: "settings.security.keys.title",
  },
  { section: "security", anchor: "passkeys", titleKey: "settings.passkeys" },
  {
    section: "security",
    anchor: "password",
    titleKey: "settings.passwordTitle",
  },
  // ── Access ──
  {
    section: "access",
    anchor: "share-invite",
    titleKey: "recordSharing.invite.title",
  },
  {
    section: "access",
    anchor: "managed-profiles",
    titleKey: "recordSharing.managed.title",
  },
  {
    section: "access",
    anchor: "shared-by-you",
    titleKey: "recordSharing.given.title",
  },
  {
    section: "access",
    anchor: "shared-with-you",
    titleKey: "recordSharing.received.title",
  },
  {
    section: "access",
    anchor: "record-activity",
    titleKey: "recordSharing.activity.title",
  },
  // ── Privacy ──
  {
    section: "privacy",
    anchor: "encryption",
    titleKey: "settings.privacy.encryption.title",
  },
  {
    section: "privacy",
    anchor: "stored-data",
    titleKey: "settings.privacy.stored.title",
  },
  {
    section: "privacy",
    anchor: "retention",
    titleKey: "settings.privacy.retention.title",
  },
  {
    section: "privacy",
    anchor: "your-data-export",
    titleKey: "settings.privacy.export.title",
  },
  {
    section: "privacy",
    anchor: "delete-data",
    titleKey: "settings.privacy.delete.title",
  },
  {
    section: "privacy",
    anchor: "privacy-posture",
    titleKey: "settings.privacy.posture.title",
  },
  {
    section: "privacy",
    anchor: "sessions",
    titleKey: "settings.security.sessionsTitle",
  },
  {
    section: "privacy",
    anchor: "trusted-devices",
    titleKey: "settings.security.trustedDevices.title",
  },
  {
    section: "privacy",
    anchor: "security-activity",
    titleKey: "settings.security.activityTitle",
  },
  // ── Integrations: connections (wrapper ids) ──
  {
    section: "integrations",
    anchor: "withings",
    titleKey: "settings.withings",
  },
  { section: "integrations", anchor: "whoop", titleKey: "settings.whoop" },
  { section: "integrations", anchor: "fitbit", titleKey: "settings.fitbit" },
  {
    section: "integrations",
    anchor: "google-health",
    titleKey: "settings.googleHealth",
  },
  {
    section: "integrations",
    anchor: "apple-health",
    titleKey: "settings.appleHealth.title",
  },
  { section: "integrations", anchor: "polar", titleKey: "settings.polar" },
  { section: "integrations", anchor: "oura", titleKey: "settings.oura" },
  { section: "integrations", anchor: "strava", titleKey: "settings.strava" },
  {
    section: "integrations",
    anchor: "nightscout",
    titleKey: "settings.nightscout",
  },
  {
    section: "integrations",
    anchor: "garmin",
    titleKey: "settings.garminInfo.title",
  },
  {
    section: "integrations",
    anchor: "nutrient-intake",
    titleKey: "settings.sections.sources.nutrients.title",
    modules: ["nutrients"],
  },
  // ── Integrations: channels ──
  {
    section: "integrations",
    anchor: "channels",
    titleKey: "settings.sections.integrations.channelsHeading",
  },
  {
    section: "integrations",
    anchor: "delivery-status",
    titleKey: "settings.notificationStatus.title",
  },
  { section: "integrations", anchor: "webhook", titleKey: "settings.webhook" },
  // ── Health record ──
  {
    section: "gesundheitsakte",
    anchor: "health-record",
    titleKey: "settings.healthRecord.title",
  },
  {
    section: "gesundheitsakte",
    anchor: "share-link-create",
    titleKey: "settings.sharing.createTitle",
  },
  {
    section: "gesundheitsakte",
    anchor: "share-links-active",
    titleKey: "settings.sharing.activeTitle",
  },
  // ── Export and import ──
  {
    section: "export",
    anchor: "measurements-csv",
    titleKey: "settings.sections.export.cards.measurementsCsv.title",
  },
  {
    section: "export",
    anchor: "medications-csv",
    titleKey: "settings.sections.export.cards.medicationsCsv.title",
  },
  {
    section: "export",
    anchor: "mood-csv",
    titleKey: "settings.sections.export.cards.moodCsv.title",
  },
  {
    section: "export",
    anchor: "full-backup",
    titleKey: "settings.sections.export.cards.fullBackup.title",
  },
  {
    section: "export",
    anchor: "import-apple-health",
    titleKey: "settings.sections.export.import.appleHealth.title",
  },
  {
    section: "export",
    anchor: "import-health-connect",
    titleKey: "settings.sections.export.import.healthConnect.title",
  },
  {
    section: "export",
    anchor: "import-json",
    titleKey: "settings.sections.export.import.json.title",
  },
  {
    section: "export",
    anchor: "import-csv",
    titleKey: "settings.sections.export.import.csv.title",
  },
  {
    section: "export",
    anchor: "import-dose-history",
    titleKey: "settings.sections.export.import.doseHistory.title",
  },
  // ── Thresholds ──
  {
    section: "thresholds",
    anchor: "glucose-reference",
    titleKey: "settings.glucoseReference.title",
  },
  {
    section: "thresholds",
    anchor: "thresholds",
    titleKey: "thresholds.cardTitle",
  },
  // ── Notifications ──
  {
    section: "notifications",
    anchor: "mood-reminder",
    titleKey: "notifications.moodReminder.title",
    modules: ["mood"],
  },
  {
    section: "notifications",
    anchor: "low-stock",
    titleKey: "notifications.lowStock.title",
    modules: ["medications"],
  },
  // ── Anamnesis ──
  {
    section: "anamnesis",
    anchor: "ai-inclusion",
    titleKey: "records.aiInclusion.cardTitle",
    modules: ["coach", "insights"],
  },
  {
    section: "anamnesis",
    anchor: "conditions",
    titleKey: "records.conditions.cardTitle",
    modules: ["coach"],
  },
  {
    section: "anamnesis",
    anchor: "about-me",
    titleKey: "settings.ai.aboutMe.title",
    modules: ["coach", "insights"],
  },
  {
    section: "anamnesis",
    anchor: "profile-facts",
    titleKey: "records.profileFacts.cardTitle",
  },
  {
    section: "anamnesis",
    anchor: "allergies",
    titleKey: "records.allergies.cardTitle",
  },
  {
    section: "anamnesis",
    anchor: "family-history",
    titleKey: "records.family.cardTitle",
  },
  {
    section: "anamnesis",
    anchor: "emergency",
    titleKey: "records.emergency.cardTitle",
  },
  // ── Environment ──
  {
    section: "environment",
    anchor: "home-location",
    titleKey: "settings.sections.environment.home.title",
    modules: ["environment"],
  },
  {
    section: "environment",
    anchor: "travel",
    titleKey: "settings.sections.environment.travel.title",
    modules: ["environment"],
  },
  {
    section: "environment",
    anchor: "weather-backfill",
    titleKey: "settings.sections.environment.backfill.title",
    modules: ["environment"],
  },
  {
    section: "environment",
    anchor: "air-quality",
    titleKey: "settings.sections.environment.airQuality.title",
    modules: ["environment"],
  },
  // ── AI ──
  {
    section: "ai",
    anchor: "ai-provider",
    titleKey: "settings.ai.activeProviderHeading",
  },
  {
    section: "ai",
    anchor: "provider-chain",
    titleKey: "settings.ai.providerChain.title",
  },
  {
    section: "ai",
    anchor: "response-timeout",
    titleKey: "settings.ai.responseTimeoutHeading",
  },
  {
    section: "ai",
    anchor: "auto-read",
    titleKey: "settings.ai.autoRead.title",
  },
  {
    section: "ai",
    anchor: "ai-consent",
    titleKey: "settings.ai.consent.title",
  },
  { section: "ai", anchor: "ai-runtime", titleKey: "settings.ai.runtimeTitle" },
  // ── Coach ──
  {
    section: "coach",
    anchor: "coach-activate",
    titleKey: "settings.coach.activate.title",
  },
  {
    section: "coach",
    anchor: "coach-preferences",
    titleKey: "insights.coach.settingsTitle",
  },
  {
    section: "coach",
    anchor: "coach-nudge",
    titleKey: "notifications.coachNudge.title",
  },
  {
    section: "coach",
    anchor: "coach-memory",
    titleKey: "settings.ai.coachMemory.title",
  },
  {
    section: "coach",
    anchor: "coach-conversations",
    titleKey: "settings.ai.coachConversations.title",
  },
  // ── API ──
  {
    section: "api",
    anchor: "api-endpoints",
    titleKey: "settings.apiEndpointsTitle",
  },
  {
    section: "api",
    anchor: "measurements-token",
    titleKey: "settings.measurementsToken.title",
  },
  {
    section: "api",
    anchor: "workouts-token",
    titleKey: "settings.workoutsToken.title",
  },
  {
    section: "api",
    anchor: "documents-token",
    titleKey: "settings.documentsToken.title",
  },
  { section: "api", anchor: "api-tokens", titleKey: "settings.apiTokens" },
  // ── MCP ──
  {
    section: "mcp",
    anchor: "mcp-enable",
    titleKey: "settings.mcp.enableTitle",
  },
  {
    section: "mcp",
    anchor: "mcp-connections",
    titleKey: "settings.mcp.connectionsTitle",
  },
  {
    section: "mcp",
    anchor: "mcp-tokens",
    titleKey: "settings.mcp.tokensTitle",
  },
  // ── Advanced ──
  {
    section: "advanced",
    anchor: "danger-zone",
    titleKey: "settings.dangerZone",
  },
  {
    section: "advanced",
    anchor: "delete-account",
    titleKey: "settings.deleteAccountCardTitle",
  },
];

/**
 * The Appearance hub's sub-pages, each its own entry. A module's page shows
 * only while the module is on.
 */
export const SETTINGS_LAYOUT_PAGES: ReadonlyArray<{
  slug: string;
  titleKey: string;
  module?: ModuleKey;
}> = [
  { slug: "dashboard", titleKey: "settings.sections.layout.dashboard.title" },
  { slug: "insights", titleKey: "settings.sections.layout.insights.title" },
  {
    slug: "medications",
    titleKey: "settings.sections.layout.medications.title",
    module: "medications",
  },
  {
    slug: "mood",
    titleKey: "settings.sections.layout.mood.title",
    module: "mood",
  },
  {
    slug: "labs",
    titleKey: "settings.sections.layout.labs.title",
    module: "labs",
  },
  {
    slug: "illness",
    titleKey: "settings.sections.layout.illness.title",
    module: "illness",
  },
  {
    slug: "documents",
    titleKey: "settings.sections.layout.documents.title",
    module: "inboundDocuments",
  },
  { slug: "vorsorge", titleKey: "settings.sections.layout.vorsorge.title" },
];
