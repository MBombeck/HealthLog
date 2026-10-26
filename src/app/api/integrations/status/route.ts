/**
 * Combined status endpoint for the Settings → Integrations card.
 *
 * Returns a snapshot per integration containing:
 *   - the IntegrationStatus row (state, last-success, last-attempt,
 *     decrypted last-error, per-kind failure buckets, threshold)
 *   - integration-specific extras the UI already shows (Withings:
 *     credentials configured, token expiry, OAuth-connected)
 *
 * This is the single fetch the Settings → Integrations cards read off
 * — it carries every field the cards render (Withings activity scope,
 * WHOOP/Fitbit backfill state) so the per-card /api/<provider>/status
 * round-trips are gone
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
  type IntegrationStatusSnapshot,
} from "@/lib/integrations/status";
import {
  getSourceMetricFreshness,
  type MetricFreshnessEntry,
  type MetricFreshnessSample,
} from "@/lib/integrations/metric-freshness";
import {
  classifyMetricFreshness,
  INTEGRATION_CADENCE,
  resolveSyncVerdict,
  type SyncHealth,
} from "@/lib/integrations/sync-verdict";
import {
  getOuraClientCredentials,
  readOuraScopeDenied,
} from "@/lib/oura/credentials";
import {
  ouraScopeReconnectList,
  type OuraScopeGatedCollection,
} from "@/lib/oura/scope";
import { parseWithingsApiPlanState } from "@/lib/withings/api-plan";
import {
  withingsPlanUnavailableFeatures,
  type WithingsPlanFeature,
} from "@/lib/withings/plan-features";
import { getPolarClientCredentials } from "@/lib/polar/credentials";
import { getStravaClientCredentials } from "@/lib/strava/credentials";
import { hasActivityScope } from "@/lib/withings/oauth";
import { loadConnectionHealth } from "@/lib/integrations/connection-health-load";
import {
  googleHealthBackfillEndedList,
  type GoogleHealthBackfillEndedEntry,
} from "@/lib/google-health/backfill-progress";
import type { ConnectionHealth } from "@/lib/integrations/connection-health";
import {
  fitbitRetirement,
  type PublishedFitbitRetirement,
} from "@/lib/fitbit/retirement";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.status" } });

  // One round: the per-provider rows, the unified connection health and the
  // per-metric freshness do not depend on each other. Awaited one after
  // another, a cold first visit paid the three latencies end to end.
  let metricFreshnessDegraded = false;
  const [
    [
      withingsStatus,
      whoopStatus,
      fitbitStatus,
      googleHealthStatus,
      polarStatus,
      ouraStatus,
      stravaStatus,
      nightscoutStatus,
      dawarichStatus,
      dbUser,
      withingsConn,
      whoopConn,
      fitbitConn,
      googleHealthConn,
      // v1.17.1 — `available` reports whether usable OAuth credentials resolve
      // (per-user BYO first, then the shared env app), mirroring the per-card
      // /api/<provider>/status the consolidated envelope now replaces.
      polarAvailable,
      ouraAvailable,
      stravaAvailable,
    ],
    health,
    metricFreshness,
  ] = await Promise.all([
    Promise.all([
      getIntegrationStatus(user.id, "withings"),
      getIntegrationStatus(user.id, "whoop"),
      getIntegrationStatus(user.id, "fitbit"),
      getIntegrationStatus(user.id, "google-health"),
      getIntegrationStatus(user.id, "polar"),
      getIntegrationStatus(user.id, "oura"),
      getIntegrationStatus(user.id, "strava"),
      getIntegrationStatus(user.id, "nightscout"),
      getIntegrationStatus(user.id, "dawarich"),
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
          ouraScopeDenied: true,
          stravaAccessTokenEncrypted: true,
          stravaClientIdEncrypted: true,
          stravaClientSecretEncrypted: true,
          // Nightscout folds onto the envelope; the card reads these three off
          // it instead of its own /api/nightscout/status round-trip.
          nightscoutUrlEncrypted: true,
          nightscoutTokenEncrypted: true,
          nightscoutAllowPrivateHost: true,
          dawarichUrlEncrypted: true,
        },
      }),
      prisma.withingsConnection.findUnique({
        where: { userId: user.id },
        select: {
          tokenExpiresAt: true,
          lastSyncedAt: true,
          createdAt: true,
          scope: true,
          apiPlanState: true,
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
          backfillProgress: true,
          needsReauth: true,
        },
      }),
      getPolarClientCredentials(user.id).then((c) => !!c),
      getOuraClientCredentials(user.id).then((c) => !!c),
      getStravaClientCredentials(user.id).then((c) => !!c),
    ]),
    // The unified per-connection state. Resolved by the same loader the
    // per-provider routes and the integration watchdog use, so the envelope
    // and every other surface say the same thing about a connection.
    loadConnectionHealth(user.id, [
      "withings",
      "whoop",
      "fitbit",
      "google-health",
      "polar",
      "oura",
      "strava",
      "nightscout",
      "dawarich",
    ]),
    // See `metricFreshnessDegraded` below.
    getSourceMetricFreshness(user.id).catch(() => {
      metricFreshnessDegraded = true;
      return {} as Partial<Record<IntegrationKey, MetricFreshnessSample[]>>;
    }),
  ]);

  // Per-metric-type last-value timestamps so the card can show that a
  // single metric type has gone silent even while the integration reads green
  // ("connected · 5 min ago"). Fail-soft: this is an honesty signal, never worth
  // 500-ing the whole Settings card, so a groupBy hiccup degrades to no data.
  //
  // The degradation is REPORTED rather than swallowed. Falling back to `{}`
  // makes every entry's `metricFreshness` an empty array, which is exactly what
  // a user with nothing recorded also sees — so "no metric has gone quiet" and
  // "we could not tell whether a metric has gone quiet" were the same answer on
  // the wire, and the honesty signal quietly became the thing it was built to
  // prevent. `metricFreshnessDegraded` separates them. One flag rather than a
  // nullable array per entry, because this is ONE query for all eight providers
  // — it fails for all of them or for none. (Read in the round above.)

  const now = Date.now();
  const whoopConnected = !!whoopConn?.whoopUserId;

  /**
   * The ledger fields the envelope publishes, named one by one.
   *
   * `failingSince` is deliberately not among them. It is the input to
   * `syncHealth.since`, which every consumer already reads, and putting both on
   * the wire would be two names for one fact — the second of which nothing
   * renders.
   */
  function publish(snapshot: IntegrationStatusSnapshot) {
    return {
      integration: snapshot.integration,
      state: snapshot.state,
      lastSuccessAt: snapshot.lastSuccessAt,
      lastAttemptAt: snapshot.lastAttemptAt,
      lastError: snapshot.lastError,
      consecutiveFailuresByKind: snapshot.consecutiveFailuresByKind,
    };
  }

  /**
   * The sync-health verdict + the per-metric staleness flags, resolved from
   * data already in hand — no additional query. Every entry carries it,
   * whether or not a card exists for the provider: a card-level verdict misses
   * a card-less provider by construction, which is how a month-dead sync went
   * unnoticed.
   */
  function resolve(
    integration: IntegrationKey,
    snapshot: {
      state: string;
      lastSuccessAt: string | null;
      lastAttemptAt: string | null;
      failingSince: string | null;
    },
    opts: {
      connected?: boolean;
      configured?: boolean;
      legacyLastSyncedAt?: string | null;
    },
  ): { syncHealth: SyncHealth; metricFreshness: MetricFreshnessEntry[] } {
    const syncHealth = resolveSyncVerdict({
      connected: opts.connected,
      configured: opts.configured,
      state: snapshot.state,
      lastSuccessAt: snapshot.lastSuccessAt,
      lastAttemptAt: snapshot.lastAttemptAt,
      failingSinceAt: snapshot.failingSince,
      legacyLastSyncedAt: opts.legacyLastSyncedAt ?? null,
      cadence: INTEGRATION_CADENCE[integration],
      now,
    });
    return {
      syncHealth,
      metricFreshness: classifyMetricFreshness(
        metricFreshness[integration] ?? [],
        syncHealth.verdict,
        now,
      ),
    };
  }

  const withingsConfigured =
    !!dbUser?.withingsClientIdEncrypted &&
    !!dbUser?.withingsClientSecretEncrypted;
  const withingsLegacyLastSyncedAt =
    withingsConn?.lastSyncedAt?.toISOString() ?? null;
  const whoopConfigured =
    !!dbUser?.whoopClientIdEncrypted && !!dbUser?.whoopClientSecretEncrypted;
  const whoopLegacyLastSyncedAt = whoopConnected
    ? (whoopConn?.lastSyncedAt?.toISOString() ?? null)
    : null;
  const fitbitConnected = !!fitbitConn;
  const fitbitConfigured =
    !!dbUser?.fitbitClientIdEncrypted && !!dbUser?.fitbitClientSecretEncrypted;
  const fitbitLegacyLastSyncedAt =
    fitbitConn?.lastSyncedAt?.toISOString() ?? null;
  // Once the Web API is gone the Fitbit card only explains the move to an
  // account that had something to move: a connection, its own Fitbit app, or
  // imported Fitbit data. Anyone else is shown no dead card. The data probe
  // runs only after the turndown, for an account with neither of the others.
  const retirementNow = fitbitRetirement();
  const fitbitOffered =
    !retirementNow.ended ||
    fitbitConnected ||
    fitbitConfigured ||
    (await prisma.measurement.findFirst({
      where: { userId: user.id, source: "FITBIT", deletedAt: null },
      select: { id: true },
    })) !== null;
  const googleHealthConnected = !!googleHealthConn;
  const googleHealthConfigured =
    !!dbUser?.googleHealthClientIdEncrypted &&
    !!dbUser?.googleHealthClientSecretEncrypted;
  const googleHealthLegacyLastSyncedAt =
    googleHealthConn?.lastSyncedAt?.toISOString() ?? null;
  const polarConnected = !!dbUser?.polarAccessTokenEncrypted;
  const ouraConnected = !!dbUser?.ouraAccessTokenEncrypted;
  const stravaConnected = !!dbUser?.stravaAccessTokenEncrypted;
  const nightscoutConfigured = !!dbUser?.nightscoutUrlEncrypted;
  const dawarichConfigured = !!dbUser?.dawarichUrlEncrypted;

  if (metricFreshnessDegraded) {
    annotate({ meta: { integrations_metric_freshness_degraded: true } });
  }

  return apiSuccess({
    threshold: getPersistentFailureThreshold(),
    metricFreshnessDegraded,
    integrations: [
      {
        ...publish(withingsStatus),
        configured: withingsConfigured,
        connected: !!withingsConn,
        connectedAt: withingsConn?.createdAt?.toISOString() ?? null,
        // Surface the connection row's success time too so the UI
        // can fall back to it when no IntegrationStatus row exists
        // yet (legacy connections established before this feature).
        legacyLastSyncedAt: withingsLegacyLastSyncedAt,
        tokenExpiresAt: withingsConn?.tokenExpiresAt?.toISOString() ?? null,
        tokenExpired: withingsConn
          ? withingsConn.tokenExpiresAt.getTime() <= now
          : null,
        // v1.4.25 — `scope` is the comma-separated OAuth scope string;
        // `hasActivityScope` is the derived flag the reconnect banner reads.
        // Null `scope` = legacy connection that predates activity-scope reads.
        scope: withingsConn?.scope ?? null,
        hasActivityScope: hasActivityScope(withingsConn?.scope ?? null),
        // What this connection's Withings API plan withholds (status 277),
        // resolved here so the card only renders it.
        planUnavailable: withingsConn
          ? withingsPlanUnavailableFeatures(
              parseWithingsApiPlanState(withingsConn.apiPlanState),
            )
          : [],
        health: health["withings"],
        ...resolve("withings", withingsStatus, {
          connected: !!withingsConn,
          configured: withingsConfigured,
          legacyLastSyncedAt: withingsLegacyLastSyncedAt,
        }),
      } satisfies IntegrationViewModel & WithingsExtras,
      {
        ...publish(whoopStatus),
        configured: whoopConfigured,
        connected: whoopConnected,
        connectedAt: whoopConnected
          ? (whoopConn?.createdAt.toISOString() ?? null)
          : null,
        legacyLastSyncedAt: whoopLegacyLastSyncedAt,
        tokenExpiresAt: whoopConnected
          ? (whoopConn?.tokenExpiresAt.toISOString() ?? null)
          : null,
        tokenExpired: whoopConnected
          ? (whoopConn?.tokenExpiresAt.getTime() ?? 0) <= now
          : null,
        backfillCompleted: whoopConnected
          ? !!whoopConn?.backfillCompletedAt
          : null,
        health: health["whoop"],
        ...resolve("whoop", whoopStatus, {
          connected: whoopConnected,
          configured: whoopConfigured,
          legacyLastSyncedAt: whoopLegacyLastSyncedAt,
        }),
      } satisfies IntegrationViewModel & WhoopExtras,
      {
        ...publish(fitbitStatus),
        configured: fitbitConfigured,
        connected: fitbitConnected,
        connectedAt: fitbitConn?.createdAt?.toISOString() ?? null,
        legacyLastSyncedAt: fitbitLegacyLastSyncedAt,
        tokenExpiresAt: fitbitConn?.tokenExpiresAt?.toISOString() ?? null,
        tokenExpired: fitbitConn
          ? fitbitConn.tokenExpiresAt.getTime() <= now
          : null,
        backfillCompleted: fitbitConn ? !!fitbitConn.backfillCompletedAt : null,
        retirement: { ...retirementNow, offered: fitbitOffered },
        health: health["fitbit"],
        ...resolve("fitbit", fitbitStatus, {
          connected: fitbitConnected,
          configured: fitbitConfigured,
          legacyLastSyncedAt: fitbitLegacyLastSyncedAt,
        }),
      } satisfies IntegrationViewModel & FitbitExtras,
      {
        ...publish(googleHealthStatus),
        configured: googleHealthConfigured,
        connected: googleHealthConnected,
        connectedAt: googleHealthConn?.createdAt?.toISOString() ?? null,
        legacyLastSyncedAt: googleHealthLegacyLastSyncedAt,
        tokenExpiresAt: googleHealthConn?.tokenExpiresAt?.toISOString() ?? null,
        tokenExpired: googleHealthConn
          ? googleHealthConn.tokenExpiresAt.getTime() <= now
          : null,
        backfillCompleted: googleHealthConn
          ? !!googleHealthConn.backfillCompletedAt
          : null,
        backfillEnded: googleHealthConn
          ? googleHealthBackfillEndedList(googleHealthConn.backfillProgress)
          : [],
        // v1.27.0 — `needsReauth` is the 7-day Testing-mode refresh expiry (or a
        // user-revoked grant) surfaced from the connection row; the card reads it
        // to raise a distinct "Reconnect" CTA separate from parked/disconnected.
        needsReauth: googleHealthConn ? googleHealthConn.needsReauth : false,
        health: health["google-health"],
        ...resolve("google-health", googleHealthStatus, {
          connected: googleHealthConnected,
          configured: googleHealthConfigured,
          legacyLastSyncedAt: googleHealthLegacyLastSyncedAt,
        }),
      } satisfies IntegrationViewModel & GoogleHealthExtras,
      {
        ...publish(polarStatus),
        // `connected` = a stored access token; `configured` mirrors it (the
        // OAuth card has no separate "credentials saved but disconnected" view
        // beyond `hasOwnCredentials`). The card greys out the connect button
        // when no usable credentials resolve (`available`).
        connected: polarConnected,
        configured: polarConnected,
        available: polarAvailable,
        hasOwnCredentials:
          !!dbUser?.polarClientIdEncrypted &&
          !!dbUser?.polarClientSecretEncrypted,
        health: health["polar"],
        ...resolve("polar", polarStatus, {
          connected: polarConnected,
          configured: polarConnected,
        }),
      } satisfies IntegrationViewModel & OAuthProviderExtras,
      {
        ...publish(ouraStatus),
        connected: ouraConnected,
        configured: ouraConnected,
        available: ouraAvailable,
        hasOwnCredentials:
          !!dbUser?.ouraClientIdEncrypted &&
          !!dbUser?.ouraClientSecretEncrypted,
        // Collections the stored grant does not cover; one reconnect asks for
        // the missing scopes. Not a failure, so it never colours the pill.
        scopeReconnect: ouraConnected
          ? ouraScopeReconnectList(readOuraScopeDenied(dbUser?.ouraScopeDenied))
          : [],
        health: health["oura"],
        ...resolve("oura", ouraStatus, {
          connected: ouraConnected,
          configured: ouraConnected,
        }),
      } satisfies IntegrationViewModel &
        OAuthProviderExtras & { scopeReconnect: OuraScopeGatedCollection[] },
      {
        ...publish(stravaStatus),
        connected: stravaConnected,
        configured: stravaConnected,
        available: stravaAvailable,
        hasOwnCredentials:
          !!dbUser?.stravaClientIdEncrypted &&
          !!dbUser?.stravaClientSecretEncrypted,
        // Strava writes Workout rows, not Measurements — its freshness list
        // carries the `WORKOUTS` pseudo-entry alone.
        health: health["strava"],
        ...resolve("strava", stravaStatus, {
          connected: stravaConnected,
          configured: stravaConnected,
        }),
      } satisfies IntegrationViewModel & OAuthProviderExtras,
      {
        ...publish(nightscoutStatus),
        // Nightscout is a URL the self-hoster pastes once; `configured` (a
        // stored URL) is the connect marker, and a fully-public instance has
        // no token. The card reads these off the envelope now instead of its
        // own status round-trip, so the whole page reads from one source.
        connected: nightscoutConfigured,
        configured: nightscoutConfigured,
        hasToken: !!dbUser?.nightscoutTokenEncrypted,
        allowPrivateHost: dbUser?.nightscoutAllowPrivateHost ?? false,
        health: health["nightscout"],
        ...resolve("nightscout", nightscoutStatus, {
          connected: nightscoutConfigured,
          configured: nightscoutConfigured,
        }),
      } satisfies IntegrationViewModel & NightscoutExtras,
      {
        ...publish(dawarichStatus),
        // Dawarich, read by the card through `health`. The ledger core rides
        // along like on every entry.
        connected: dawarichConfigured,
        configured: dawarichConfigured,
        health: health["dawarich"],
        ...resolve("dawarich", dawarichStatus, {
          connected: dawarichConfigured,
          configured: dawarichConfigured,
        }),
      } satisfies IntegrationViewModel & DawarichExtras,
    ],
  });
});

interface IntegrationViewModel {
  integration: IntegrationKey;
  /**
   * The one server-resolved state per connection (ok / limited / degraded /
   * action_required), null when the provider is not connected. Every other
   * health-shaped field on this entry (`state`, `lastError`,
   * `consecutiveFailuresByKind`, `syncHealth`, `tokenExpired`, `needsReauth`,
   * `hasActivityScope`, `planUnavailable`, `scopeReconnect`) is folded into
   * it. Those stay on the wire, deprecated in the published document; the
   * cards render `health`, and only their copied diagnostics still read
   * `consecutiveFailuresByKind`. No native client reads this envelope.
   */
  health: ConnectionHealth | null;
  state: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /**
   * The server-resolved liveness verdict. Present on EVERY entry, whether or
   * not a card renders it — the unit of coverage is the envelope entry, not
   * the card.
   */
  syncHealth: SyncHealth;
  /**
   * Per-metric-type last-value timestamps for the integration's synced data,
   * each with the server-computed `stale` flag. Lets the card flag a silently
   * dead metric the green integration state hides.
   */
  metricFreshness: MetricFreshnessEntry[];
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
  planUnavailable: WithingsPlanFeature[];
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
  /** The end of the legacy Fitbit Web API (`@/lib/fitbit/retirement`). */
  retirement: PublishedFitbitRetirement;
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
  backfillEnded: GoogleHealthBackfillEndedEntry[];
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

// Nightscout folds onto the envelope so the card stops firing its own status
// round-trip and so the provider inherits the shared verdict. `hasToken` and
// `allowPrivateHost` are the two fields the card's form placeholders read.
interface NightscoutExtras {
  connected: boolean;
  configured: boolean;
  hasToken: boolean;
  allowPrivateHost: boolean;
}

// v1.43 — Dawarich: the connect marker only; the card reads `health` and its
// own status route.
interface DawarichExtras {
  connected: boolean;
  configured: boolean;
}
