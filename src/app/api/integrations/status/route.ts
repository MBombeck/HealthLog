/**
 * Combined status endpoint for the Settings → Integrations card.
 *
 * Returns a snapshot per integration containing:
 *   - the IntegrationStatus row (state, last-success, last-attempt,
 *     decrypted last-error, per-kind failure buckets, threshold)
 *   - integration-specific extras the UI already shows (Withings:
 *     credentials configured, token expiry, OAuth-connected; moodLog:
 *     credentials configured, enabled flag)
 *
 * This is the single fetch the Settings → Integrations cards read off
 * — it carries every field the four cards render (Withings activity
 * scope, WHOOP/Fitbit backfill state, moodLog webhook secret + entry
 * count) so the per-card /api/<provider>/status round-trips are gone
 * from the web. The legacy per-provider routes stay for the iOS/test
 * callers; the web cards no longer hit them.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  getIntegrationStatus,
  getPersistentFailureThreshold,
  type IntegrationKey,
} from "@/lib/integrations/status";
import {
  getSourceMetricFreshness,
  type MetricFreshnessEntry,
} from "@/lib/integrations/metric-freshness";
import { getOuraClientCredentials } from "@/lib/oura/credentials";
import { getPolarClientCredentials } from "@/lib/polar/credentials";
import { getStravaClientCredentials } from "@/lib/strava/credentials";
import { hasActivityScope } from "@/lib/withings/client";
import { readMoodLogSecret } from "@/lib/moodlog-secret";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.status" } });

  const [
    withingsStatus,
    moodLogStatus,
    whoopStatus,
    fitbitStatus,
    googleHealthStatus,
    polarStatus,
    ouraStatus,
    stravaStatus,
    dbUser,
    withingsConn,
    whoopConn,
    fitbitConn,
    googleHealthConn,
    moodLogEntryCount,
    // v1.17.1 — `available` reports whether usable OAuth credentials resolve
    // (per-user BYO first, then the shared env app), mirroring the per-card
    // /api/<provider>/status the consolidated envelope now replaces.
    polarAvailable,
    ouraAvailable,
    stravaAvailable,
  ] = await Promise.all([
    getIntegrationStatus(user.id, "withings"),
    getIntegrationStatus(user.id, "moodlog"),
    getIntegrationStatus(user.id, "whoop"),
    getIntegrationStatus(user.id, "fitbit"),
    getIntegrationStatus(user.id, "google-health"),
    getIntegrationStatus(user.id, "polar"),
    getIntegrationStatus(user.id, "oura"),
    getIntegrationStatus(user.id, "strava"),
    prisma.user.findUnique({
      where: { id: user.id },
      select: {
        withingsClientIdEncrypted: true,
        withingsClientSecretEncrypted: true,
        whoopClientIdEncrypted: true,
        whoopClientSecretEncrypted: true,
        fitbitClientIdEncrypted: true,
        fitbitClientSecretEncrypted: true,
        googleHealthClientIdEncrypted: true,
        googleHealthClientSecretEncrypted: true,
        polarAccessTokenEncrypted: true,
        polarClientIdEncrypted: true,
        polarClientSecretEncrypted: true,
        ouraAccessTokenEncrypted: true,
        ouraClientIdEncrypted: true,
        ouraClientSecretEncrypted: true,
        stravaAccessTokenEncrypted: true,
        stravaClientIdEncrypted: true,
        stravaClientSecretEncrypted: true,
        moodLogUrlEncrypted: true,
        moodLogApiKeyEncrypted: true,
        moodLogEnabled: true,
        moodLogLastSyncedAt: true,
        moodLogWebhookSecret: true,
      },
    }),
    prisma.withingsConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        lastSyncedAt: true,
        createdAt: true,
        scope: true,
      },
    }),
    prisma.whoopConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        whoopUserId: true,
        lastSyncedAt: true,
        createdAt: true,
        backfillCompletedAt: true,
      },
    }),
    prisma.fitbitConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        lastSyncedAt: true,
        createdAt: true,
        backfillCompletedAt: true,
      },
    }),
    prisma.googleHealthConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        lastSyncedAt: true,
        createdAt: true,
        backfillCompletedAt: true,
        needsReauth: true,
      },
    }),
    // v1.7.0 sync — exclude tombstoned rows from the entry count.
    prisma.moodEntry.count({
      where: { userId: user.id, deletedAt: null },
    }),
    getPolarClientCredentials(user.id).then((c) => !!c),
    getOuraClientCredentials(user.id).then((c) => !!c),
    getStravaClientCredentials(user.id).then((c) => !!c),
  ]);

  // F-SYNC-1 — per-metric-type last-value timestamps so the card can show that a
  // single metric type has gone silent even while the integration reads green
  // ("connected · 5 min ago"). Fail-soft: this is an honesty signal, never worth
  // 500-ing the whole Settings card, so a groupBy hiccup degrades to no data.
  const metricFreshness = await getSourceMetricFreshness(user.id).catch(
    () => ({}) as Partial<Record<IntegrationKey, MetricFreshnessEntry[]>>,
  );

  const now = Date.now();
  const whoopConnected = !!whoopConn?.whoopUserId;

  return apiSuccess({
    threshold: getPersistentFailureThreshold(),
    integrations: [
      {
        ...withingsStatus,
        configured:
          !!dbUser?.withingsClientIdEncrypted &&
          !!dbUser?.withingsClientSecretEncrypted,
        connected: !!withingsConn,
        connectedAt: withingsConn?.createdAt?.toISOString() ?? null,
        // Surface the connection row's success time too so the UI
        // can fall back to it when no IntegrationStatus row exists
        // yet (legacy connections established before this feature).
        legacyLastSyncedAt: withingsConn?.lastSyncedAt?.toISOString() ?? null,
        tokenExpiresAt: withingsConn?.tokenExpiresAt?.toISOString() ?? null,
        tokenExpired: withingsConn
          ? withingsConn.tokenExpiresAt.getTime() <= now
          : null,
        // v1.4.25 W5d — `scope` is the comma-separated OAuth scope string;
        // `hasActivityScope` is the derived flag the reconnect banner reads.
        // Null `scope` = legacy connection that predates activity-scope reads.
        scope: withingsConn?.scope ?? null,
        hasActivityScope: hasActivityScope(withingsConn?.scope ?? null),
        metricFreshness: metricFreshness.withings ?? [],
      } satisfies IntegrationViewModel & WithingsExtras,
      {
        ...moodLogStatus,
        // moodLog "configured" tracks the URL alone (the API key is
        // optional for the webhook-only path), matching the legacy
        // /api/integrations/moodlog/status contract the card relied on.
        configured: !!dbUser?.moodLogUrlEncrypted,
        enabled: dbUser?.moodLogEnabled ?? false,
        legacyLastSyncedAt: dbUser?.moodLogLastSyncedAt?.toISOString() ?? null,
        // V3 audit STILL-V2-C-2: stored secret is AES-GCM encrypted at rest;
        // decrypt for the settings page (legacy plaintext is also handled).
        webhookSecret: readMoodLogSecret(dbUser?.moodLogWebhookSecret ?? null),
        entryCount: moodLogEntryCount,
      } satisfies IntegrationViewModel & MoodLogExtras,
      {
        ...whoopStatus,
        configured:
          !!dbUser?.whoopClientIdEncrypted &&
          !!dbUser?.whoopClientSecretEncrypted,
        connected: whoopConnected,
        connectedAt: whoopConnected
          ? (whoopConn?.createdAt.toISOString() ?? null)
          : null,
        legacyLastSyncedAt: whoopConnected
          ? (whoopConn?.lastSyncedAt?.toISOString() ?? null)
          : null,
        tokenExpiresAt: whoopConnected
          ? (whoopConn?.tokenExpiresAt.toISOString() ?? null)
          : null,
        tokenExpired: whoopConnected
          ? (whoopConn?.tokenExpiresAt.getTime() ?? 0) <= now
          : null,
        backfillCompleted: whoopConnected
          ? !!whoopConn?.backfillCompletedAt
          : null,
        metricFreshness: metricFreshness.whoop ?? [],
      } satisfies IntegrationViewModel & WhoopExtras,
      {
        ...fitbitStatus,
        configured:
          !!dbUser?.fitbitClientIdEncrypted &&
          !!dbUser?.fitbitClientSecretEncrypted,
        connected: !!fitbitConn,
        connectedAt: fitbitConn?.createdAt?.toISOString() ?? null,
        legacyLastSyncedAt: fitbitConn?.lastSyncedAt?.toISOString() ?? null,
        tokenExpiresAt: fitbitConn?.tokenExpiresAt?.toISOString() ?? null,
        tokenExpired: fitbitConn
          ? fitbitConn.tokenExpiresAt.getTime() <= now
          : null,
        backfillCompleted: fitbitConn ? !!fitbitConn.backfillCompletedAt : null,
        metricFreshness: metricFreshness.fitbit ?? [],
      } satisfies IntegrationViewModel & FitbitExtras,
      {
        ...googleHealthStatus,
        configured:
          !!dbUser?.googleHealthClientIdEncrypted &&
          !!dbUser?.googleHealthClientSecretEncrypted,
        connected: !!googleHealthConn,
        connectedAt: googleHealthConn?.createdAt?.toISOString() ?? null,
        legacyLastSyncedAt:
          googleHealthConn?.lastSyncedAt?.toISOString() ?? null,
        tokenExpiresAt: googleHealthConn?.tokenExpiresAt?.toISOString() ?? null,
        tokenExpired: googleHealthConn
          ? googleHealthConn.tokenExpiresAt.getTime() <= now
          : null,
        backfillCompleted: googleHealthConn
          ? !!googleHealthConn.backfillCompletedAt
          : null,
        // v1.27.0 — `needsReauth` is the 7-day Testing-mode refresh expiry (or a
        // user-revoked grant) surfaced from the connection row; the card reads it
        // to raise a distinct "Reconnect" CTA separate from parked/disconnected.
        needsReauth: googleHealthConn ? googleHealthConn.needsReauth : false,
        metricFreshness: metricFreshness["google-health"] ?? [],
      } satisfies IntegrationViewModel & GoogleHealthExtras,
      {
        ...polarStatus,
        // `connected` = a stored access token; `configured` mirrors it (the
        // OAuth card has no separate "credentials saved but disconnected" view
        // beyond `hasOwnCredentials`). The card greys out the connect button
        // when no usable credentials resolve (`available`).
        connected: !!dbUser?.polarAccessTokenEncrypted,
        configured: !!dbUser?.polarAccessTokenEncrypted,
        available: polarAvailable,
        hasOwnCredentials:
          !!dbUser?.polarClientIdEncrypted &&
          !!dbUser?.polarClientSecretEncrypted,
        metricFreshness: metricFreshness.polar ?? [],
      } satisfies IntegrationViewModel & OAuthProviderExtras,
      {
        ...ouraStatus,
        connected: !!dbUser?.ouraAccessTokenEncrypted,
        configured: !!dbUser?.ouraAccessTokenEncrypted,
        available: ouraAvailable,
        hasOwnCredentials:
          !!dbUser?.ouraClientIdEncrypted &&
          !!dbUser?.ouraClientSecretEncrypted,
        metricFreshness: metricFreshness.oura ?? [],
      } satisfies IntegrationViewModel & OAuthProviderExtras,
      {
        ...stravaStatus,
        connected: !!dbUser?.stravaAccessTokenEncrypted,
        configured: !!dbUser?.stravaAccessTokenEncrypted,
        available: stravaAvailable,
        hasOwnCredentials:
          !!dbUser?.stravaClientIdEncrypted &&
          !!dbUser?.stravaClientSecretEncrypted,
        // Strava writes Workout rows, not Measurements, so it has no
        // per-metric measurement freshness (like moodLog).
        metricFreshness: metricFreshness.strava ?? [],
      } satisfies IntegrationViewModel & OAuthProviderExtras,
    ],
  });
});

interface IntegrationViewModel {
  integration: IntegrationKey;
  state: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /**
   * F-SYNC-1 — per-metric-type last-value timestamps for the integration's
   * synced measurements. Present on the measurement-backed integrations;
   * omitted for moodLog (which writes MoodEntry rows, not Measurements). Lets
   * the card flag a silently-dead metric the green integration state hides.
   */
  metricFreshness?: MetricFreshnessEntry[];
}

interface WithingsExtras {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  legacyLastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
  scope: string | null;
  hasActivityScope: boolean;
}

interface MoodLogExtras {
  configured: boolean;
  enabled: boolean;
  legacyLastSyncedAt: string | null;
  webhookSecret: string | null;
  entryCount: number;
}

interface WhoopExtras {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  legacyLastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
  backfillCompleted: boolean | null;
}

interface FitbitExtras {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  legacyLastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
  backfillCompleted: boolean | null;
}

// v1.27.0 — Google Health mirrors the Fitbit shape plus `needsReauth`: Google
// expires the refresh token after 7 days in "Testing" publishing mode, so a
// connected user is periodically pushed back through OAuth. The card reads the
// flag to raise a distinct reconnect banner.
interface GoogleHealthExtras {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  legacyLastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
  backfillCompleted: boolean | null;
  needsReauth: boolean;
}

// v1.17.1 — Polar / Oura fold into the consolidated envelope. They carry the
// per-user BYO-key flags the shared OAuth card reads instead of the dedicated
// /api/<provider>/status round-trip the page used to fire per card.
interface OAuthProviderExtras {
  connected: boolean;
  configured: boolean;
  available: boolean;
  hasOwnCredentials: boolean;
}
