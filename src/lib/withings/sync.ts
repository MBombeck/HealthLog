/**
 * Withings sync service — handles fetching and storing measurements,
 * token refresh, and webhook subscription management.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType, Prisma } from "@/generated/prisma/client";
import { encrypt, decrypt } from "@/lib/crypto";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  fetchMeasurements,
  refreshAccessToken,
  subscribeWebhook,
} from "./client";
import { getUserWithingsCredentials } from "./credentials";
import { annotate, getEvent } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  classifyError,
  WithingsApiError,
  type WithingsClassification,
} from "./response-classifier";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import { invalidateUserDashboardSnapshot } from "@/lib/cache/invalidate";
import {
  acquireProviderTokenRefreshLock,
  PROVIDER_REFRESH_TRANSACTION_OPTIONS,
} from "@/lib/integrations/oauth-refresh";

/**
 * Build the callback URL handed to Withings at `Notify.subscribe` time.
 *
 * v1.4.25 W17a moved the shared secret from `?secret=…` (query
 * parameter, captured by every reverse-proxy access log) to a path
 * segment (`/api/withings/webhook/<secret>`). Withings has no
 * mechanism for setting custom HTTP headers on outgoing notifications
 * and never signs the body, so the callback URL is the only
 * authenticity surface a subscriber controls — the path-segment form
 * is the largest practical shift away from the loggable query string.
 *
 * When `WITHINGS_WEBHOOK_SECRET` is unset (dev / new install before
 * provisioning) we fall back to the bare legacy URL so subscribe
 * doesn't 500 — the route handler will then reject every inbound
 * delivery with 401 anyway.
 */
export function getWithingsWebhookCallbackUrl(): string {
  const baseUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/withings/webhook`;
  const secret = process.env.WITHINGS_WEBHOOK_SECRET;
  if (!secret) return baseUrl;
  // Path-segment form. Withings preserves the full callback URL on
  // every notification, so once a subscription is created with this
  // URL every delivery carries the secret in the path rather than the
  // query string. Encode for safety even though we expect a strong
  // random secret.
  return `${baseUrl}/${encodeURIComponent(secret)}`;
}

export interface WithingsValidToken {
  accessToken: string;
  connection: { id: string; withingsUserId: string };
}

export interface GetValidWithingsTokenOptions {
  throwOnRefreshFailure?: boolean;
}

/**
 * Get valid access token for a user, refreshing if expired.
 */
export async function getValidToken(
  userId: string,
  options: GetValidWithingsTokenOptions = {},
): Promise<WithingsValidToken | null> {
  const connection = await prisma.withingsConnection.findUnique({
    where: { userId },
  });

  if (!connection) return null;

  if (connection.tokenExpiresAt.getTime() - 5 * 60 * 1000 >= Date.now()) {
    return {
      accessToken: decrypt(connection.accessToken),
      connection: {
        id: connection.id,
        withingsUserId: connection.withingsUserId,
      },
    };
  }

  const creds = await getUserWithingsCredentials(userId);
  if (!creds) {
    getEvent()?.addWarning(
      `No credentials found for user ${userId} during token refresh`,
    );
    await recordSyncFailure({
      userId,
      integration: "withings",
      kind: "reauth_required",
      message: "Withings credentials missing — token refresh skipped",
      errorCode: "credentials_missing",
    });
    return null;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await acquireProviderTokenRefreshLock(tx, "withings", userId);

      const current = await tx.withingsConnection.findUnique({
        where: { userId },
      });
      if (!current) return null;

      if (current.tokenExpiresAt.getTime() - 5 * 60 * 1000 >= Date.now()) {
        return {
          accessToken: decrypt(current.accessToken),
          connection: {
            id: current.id,
            withingsUserId: current.withingsUserId,
          },
        };
      }

      const newTokens = await refreshAccessToken(
        decrypt(current.refreshToken),
        creds,
      );
      const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

      await tx.withingsConnection.update({
        where: { id: current.id },
        data: {
          accessToken: encrypt(newTokens.access_token),
          refreshToken: encrypt(newTokens.refresh_token),
          tokenExpiresAt: expiresAt,
        },
      });

      return {
        accessToken: newTokens.access_token,
        connection: {
          id: current.id,
          withingsUserId: current.withingsUserId,
        },
      };
    }, PROVIDER_REFRESH_TRANSACTION_OPTIONS);
  } catch (err) {
    getEvent()?.addWarning(`Token refresh failed for user ${userId}`);
    await recordWithingsSyncFailure(userId, err);
    if (options.throwOnRefreshFailure) throw err;
    return null;
  }
}

/**
 * Incremental overlap window (ms). Withings backdates some readings (a scale
 * step syncs to the cloud minutes after the reading's timestamp), and
 * `lastSyncedAt` advances on every success — including a healthy 200-with-0
 * cycle (F-SYNC-1). A too-tight overlap let a reading that landed just before
 * the next cycle's `now()` slip through the gap. 10 minutes is comfortably wider
 * than the observed backdating skew while staying far short of a full re-scan;
 * the upserts are idempotent, so a wider overlap only re-touches a handful of
 * rows. (Still narrower than Google's 24h / Oura's 7-day because Withings is
 * webhook-primary — this overlap is the poll-catch-up safety net, not the main
 * path.)
 */
export const WITHINGS_INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000;

/**
 * Sync measurements from Withings for a given user.
 * Fetches data since last sync (or last 30 days if first sync).
 *
 * Status-tracking contract:
 *   - On any failure (refresh failure, fetch failure, downstream
 *     measurement-upsert that fails ALL items) we call
 *     `recordSyncFailure` so the IntegrationStatus row + audit log
 *     reflect the burst, and so the persistent-failure threshold can
 *     trip an admin alert.
 *   - On full success we call `recordSyncSuccess` to clear the streak.
 *   - If the connection is parked at `error_reauth` we short-circuit
 *     immediately — the user has to reconnect first.
 */
export async function syncUserMeasurements(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  // Park: if the last burst said reauth_required, do nothing until
  // the OAuth callback flips state back to "connected". Returning 0
  // matches the existing contract for "no-op sync".
  if (await isReauthRequired(userId, "withings")) {
    getEvent()?.addWarning(
      `withings sync skipped for ${userId}: parked at error_reauth`,
    );
    return 0;
  }

  const tokenInfo = await getValidToken(userId);
  // Note: getValidToken already calls recordSyncFailure on the refresh
  // path, so we don't double-record here.
  if (!tokenInfo) return 0;

  const connection = await prisma.withingsConnection.findUnique({
    where: { userId },
  });
  if (!connection) return 0;

  const startDate = opts.fullSync
    ? undefined
    : connection.lastSyncedAt
      ? new Date(
          connection.lastSyncedAt.getTime() - WITHINGS_INCREMENTAL_OVERLAP_MS,
        )
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days back

  let measures: Awaited<ReturnType<typeof fetchMeasurements>>;
  try {
    measures = await fetchMeasurements(tokenInfo.accessToken, startDate);
  } catch (err) {
    await recordWithingsSyncFailure(userId, err);
    throw err;
  }

  let imported = 0;
  // v1.4.39.1 — track every (type, measuredAt) we touched so the
  // persistent rollup tier can be re-folded at the end of the sync.
  // Pre-fix, Withings-ingested BP / weight / pulse / body-fat rows
  // skipped the rollup write hook entirely: subsequent dashboard chart
  // fetches with `source=rollup` saw fewer DAY buckets than the live
  // measurements table, painting the "Noch nicht genug Daten" empty
  // state for the 30-day range on accounts whose recent data only came
  // through Withings. We collect first, fold once at the end so a 100-
  // row monthly catch-up costs at most ~N (type, day) recomputes rather
  // than N per-row hooks. Best-effort: a populator hiccup never fails
  // the user's sync.
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  const insertedArrivals: Array<{
    id: string;
    type: MeasurementType;
    measuredAt: Date;
  }> = [];

  // v1.28.39 — hold-watermark-on-hard-failure (mirrors google-health /
  // fitbit's `hardFailStorage` verdict). A per-row write that HARD-fails
  // (anything but a benign P2002 idempotent-write collision) must not let
  // `lastSyncedAt` advance past the unpersisted reading — the 10-min overlap
  // window would otherwise never re-cover it and the reading is stranded
  // forever. Track any hard failure so the watermark stamp + `recordSyncSuccess`
  // below are held and the failure is recorded for the next tick to retry.
  let anyRowFailed = false;
  let firstRowError: unknown = null;

  for (const m of measures) {
    const measType = m.type as MeasurementType;
    try {
      // v1.4.25 W17b/c — Migration 0055 added `sleepStage` to the
      // composite unique with `NULLS NOT DISTINCT`, so a non-sleep
      // upsert keyed on (userId, type, measuredAt, source) with
      // sleepStage IS NULL is still safe. But Prisma's typed compound
      // input requires a non-null `sleepStage`, so we model the
      // idempotent write as a `findFirst` + `create`/`update`. The
      // unique index still serializes concurrent inserts, so the worst
      // case is a Prisma P2002 we catch and ignore.
      const existing = await prisma.measurement.findFirst({
        where: {
          userId,
          type: measType,
          measuredAt: m.measuredAt,
          source: "WITHINGS",
          sleepStage: null,
        },
        select: { id: true },
      });
      if (existing) {
        await prisma.measurement.update({
          where: { id: existing.id },
          // `deletedAt: null` is a no-op on a live row, a deliberate
          // RESURRECTION on a tombstoned one — Withings is the source of
          // truth for its own rows, so a re-fetched measure brings the row
          // back (mirrors Google / Fitbit).
          data: { value: m.value, deletedAt: null },
        });
      } else {
        const created = await prisma.measurement.create({
          data: {
            userId,
            type: measType,
            value: m.value,
            unit: getUnitForType(m.type),
            measuredAt: m.measuredAt,
            source: "WITHINGS",
          },
          select: { id: true, type: true, measuredAt: true },
        });
        insertedArrivals.push(created);
      }
      touched.push({ type: measType, measuredAt: m.measuredAt });
      imported++;
    } catch (err) {
      if (isP2002(err)) {
        // Benign: the composite unique index serialised a concurrent insert of
        // this exact reading — the row is present, nothing is lost. Warn and
        // continue WITHOUT holding the watermark (this is the expected
        // idempotent-write race the findFirst+create models around).
        getEvent()?.addWarning(
          `Withings measure upsert hit an idempotent P2002 (row already present): ${err}`,
        );
      } else {
        // A genuine write failure strands this reading. Flag the cycle so the
        // watermark is held and the next scheduled tick refetches the overlap
        // window and retries.
        anyRowFailed = true;
        if (firstRowError === null) firstRowError = err;
        getEvent()?.addWarning(`Failed to upsert measure: ${err}`);
      }
    }
  }

  void emitInsertedMeasurementArrivals(
    userId,
    insertedArrivals,
    "withings",
  ).catch(() => {});

  // v1.4.39.1 — refresh the persistent rollup table for every distinct
  // (type, day) the sync touched. The chart-data + analytics read paths
  // consume these buckets via `source=rollup`; without this hook,
  // Withings-only metrics stayed off the rollup tier and the dashboard
  // chart at the 30-day range under-counted recent days.
  try {
    const keys = collapseToTypeDayKeys(touched);
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }

    // v1.8.0 — a Withings sync that lands new weight / BP / pulse /
    // body-comp rows dirties the matching per-metric assessment caches.
    // Drop them so the next mount / nightly warm pass regenerates
    // against the new data. Fire-and-forget: never fails the sync.
    invalidateStatusInsightsForTypes(
      userId,
      keys.map((k) => k.type),
    ).catch((err) => {
      getEvent()?.addWarning(
        `withings: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });

    // v1.18.9 (#38) — hard-evict the dashboard snapshot so a focus-refetch
    // after this server-side sync returns the freshly-imported readings.
    // The server-side Withings path produces no client mutation event, so
    // without this the snapshot's `cachedSwr` entry kept serving the
    // pre-sync body until its ~180 s TTL lapsed.
    if (keys.length > 0) {
      invalidateUserDashboardSnapshot(userId);
    }
  } catch (err) {
    getEvent()?.addWarning(
      `withings: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  // v1.28.39 — HOLD the watermark on any hard row failure. Implements the
  // documented status-tracking contract above ("downstream measurement-upsert
  // that fails ALL items → recordSyncFailure"), extended to a partial hard
  // failure: a single hard-failed row must not advance `lastSyncedAt` past the
  // reading it failed to persist, or the 10-min overlap window loses it. Record
  // the failure (classified transient by default → the connection stays live
  // and the next tick retries from the un-advanced watermark) and return
  // WITHOUT stamping the watermark or success. The rows that DID write kept
  // their rollup recompute above.
  if (anyRowFailed) {
    annotate({
      action: {
        name: "withings.sync.watermark_held",
        details: { imported },
      },
    });
    await recordWithingsSyncFailure(
      userId,
      firstRowError ?? new Error("Withings measure row write failed"),
    );
    return imported;
  }

  // Update last synced timestamp
  await prisma.withingsConnection.update({
    where: { userId },
    data: { lastSyncedAt: new Date() },
  });

  // Record success — even when measures.length === 0, completing the
  // round-trip is the signal "the connection is healthy". A user who
  // doesn't weigh themselves for a week shouldn't see "error" on
  // their settings page.
  await recordSyncSuccess(userId, "withings");

  return imported;
}

/**
 * Map a Withings response classification onto the `FailureKind` carried
 * into `recordSyncFailure`. Pure function — no IO, no state.
 *
 *   `success`         → not a failure; callers must not invoke this.
 *   `transient`       → `transient` (retry next sync)
 *   `reauth_required` → `reauth_required` (park at `error_reauth`)
 *   `persistent`      → `persistent` (audited; next sync still runs)
 */
/**
 * v1.4.42 — shared failure-recording shape for the two Withings sync
 * catch-blocks. The typed `WithingsApiError` carries the classification
 * verdict directly; `classifyError`'s regex fallback handles plain
 * `Error` instances (e.g. a pg-boss job retry that lost the prototype
 * during the JSON round-trip).
 */
export async function recordWithingsSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: "withings",
    kind: classificationToFailureKind(classifyError(err)),
    message,
    errorCode:
      err instanceof WithingsApiError
        ? err.withingsStatus?.toString()
        : extractWithingsStatus(message),
  });
}

export function classificationToFailureKind(
  classification: WithingsClassification,
): FailureKind {
  switch (classification) {
    case "reauth_required":
      return "reauth_required";
    case "persistent":
      return "persistent";
    case "transient":
      return "transient";
    case "success":
      // Defensive: a caller asking for the FailureKind of a success
      // is a contract bug. Default to `transient` so the audit log
      // still surfaces the bug rather than silently ignoring it.
      return "transient";
  }
}

/**
 * Withings status codes that indicate a permanent-revoke condition
 * (the refresh_token will not work again — the user has to redo OAuth).
 *
 * Documented values per
 * https://developer.withings.com/api-reference#tag/oauth2/operation/oauth2-getaccesstoken :
 *
 *   100 → "Authentication failed"
 *   101 → "Invalid token"
 *   102 → "User does not exist"
 *   200..299 → various OAuth/grant failures (treated as reauth-required
 *              by Withings' own libraries)
 *
 * The error message format from `refreshAccessToken()` is
 * "Withings refresh error: <status> - <error>".
 *
 * v1.4.42 W6 — superseded for new code paths by
 * `classifyError`/`classifyWithingsResponse` in `response-classifier.ts`.
 * Kept for the W17b/c sync-activity + sync-sleep catch-blocks that
 * haven't yet been migrated; both paths now also benefit from the
 * typed-error throw upstream because `classifyError` falls back to the
 * same regex.
 */
export function isWithingsRefreshReauthFailure(message: string): boolean {
  const status = extractWithingsStatus(message);
  if (!status) return false;
  const n = Number.parseInt(status, 10);
  if (!Number.isFinite(n)) return false;
  if (n === 100 || n === 101 || n === 102) return true;
  if (n >= 200 && n <= 299) return true;
  return false;
}

export function extractWithingsStatus(message: string): string | undefined {
  // Captures the digit run after "Withings <verb> error:" — same shape
  // exchangeCode and refreshAccessToken use.
  const m = /Withings\s+\w+\s+error:\s*(\d+)/.exec(message);
  return m?.[1];
}

/**
 * Withings notify appli categories HealthLog ingests. Each category requires
 * an independent upstream subscription.
 */
export const WITHINGS_NOTIFY_APPLIS = [1, 2, 4, 16, 44] as const;

export type WithingsNotifyAppli = (typeof WITHINGS_NOTIFY_APPLIS)[number];
export type WithingsNotifyAppliKey = `${WithingsNotifyAppli}`;
export type WithingsWebhookSubscriptionStatus =
  "pending" | "success" | "transient" | "persistent" | "reauth_required";

export interface WithingsWebhookSubscriptionOutcome {
  status: WithingsWebhookSubscriptionStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  withingsStatus: number | null;
}

export interface WithingsWebhookSubscriptionStateV1 {
  version: 1;
  outcomes: Record<WithingsNotifyAppliKey, WithingsWebhookSubscriptionOutcome>;
}

export const WITHINGS_SUBSCRIPTION_BASE_RETRY_MS = 5 * 60 * 1000;
export const WITHINGS_SUBSCRIPTION_MAX_RETRY_MS = 24 * 60 * 60 * 1000;

const WITHINGS_SUBSCRIPTION_STATUSES: Record<
  WithingsWebhookSubscriptionStatus,
  true
> = {
  pending: true,
  success: true,
  transient: true,
  persistent: true,
  reauth_required: true,
};

function createPendingSubscriptionOutcome(
  now: Date,
): WithingsWebhookSubscriptionOutcome {
  return {
    status: "pending",
    attemptCount: 0,
    lastAttemptAt: null,
    nextRetryAt: now.toISOString(),
    withingsStatus: null,
  };
}

export function createPendingWithingsWebhookSubscriptionState(
  now: Date = new Date(),
): WithingsWebhookSubscriptionStateV1 {
  return {
    version: 1,
    outcomes: Object.fromEntries(
      WITHINGS_NOTIFY_APPLIS.map((appli) => [
        String(appli),
        createPendingSubscriptionOutcome(now),
      ]),
    ) as WithingsWebhookSubscriptionStateV1["outcomes"],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateStringOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}

function parseSubscriptionOutcome(
  value: unknown,
): WithingsWebhookSubscriptionOutcome | null {
  if (!isObject(value)) return null;
  if (
    typeof value.status !== "string" ||
    !WITHINGS_SUBSCRIPTION_STATUSES[
      value.status as WithingsWebhookSubscriptionStatus
    ] ||
    !Number.isSafeInteger(value.attemptCount) ||
    (value.attemptCount as number) < 0 ||
    !isDateStringOrNull(value.lastAttemptAt) ||
    !isDateStringOrNull(value.nextRetryAt) ||
    !(
      value.withingsStatus === null ||
      (typeof value.withingsStatus === "number" &&
        Number.isSafeInteger(value.withingsStatus))
    )
  ) {
    return null;
  }

  const status = value.status as WithingsWebhookSubscriptionStatus;
  if (
    (status === "transient" || status === "pending") &&
    value.nextRetryAt === null
  ) {
    return null;
  }
  if (
    status !== "transient" &&
    status !== "pending" &&
    value.nextRetryAt !== null
  ) {
    return null;
  }

  return {
    status,
    attemptCount: value.attemptCount as number,
    lastAttemptAt: value.lastAttemptAt,
    nextRetryAt: value.nextRetryAt,
    withingsStatus: value.withingsStatus as number | null,
  };
}

/**
 * Persisted JSON is an untrusted compatibility boundary. Unknown versions or
 * malformed outcomes reset to a fully pending v1 state rather than silently
 * treating a category as subscribed.
 */
export function parseWithingsWebhookSubscriptionState(
  value: unknown,
  now: Date = new Date(),
): WithingsWebhookSubscriptionStateV1 {
  const pending = createPendingWithingsWebhookSubscriptionState(now);
  if (!isObject(value) || value.version !== 1 || !isObject(value.outcomes)) {
    return pending;
  }

  const outcomes = { ...pending.outcomes };
  for (const appli of WITHINGS_NOTIFY_APPLIS) {
    const key = String(appli) as WithingsNotifyAppliKey;
    const raw = value.outcomes[key];
    if (raw === undefined) continue;
    const parsed = parseSubscriptionOutcome(raw);
    if (!parsed) return pending;
    outcomes[key] = parsed;
  }
  return { version: 1, outcomes };
}

function subscriptionBackoffMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  return Math.min(
    WITHINGS_SUBSCRIPTION_BASE_RETRY_MS * 2 ** exponent,
    WITHINGS_SUBSCRIPTION_MAX_RETRY_MS,
  );
}

function earliestSubscriptionRetryAt(
  state: WithingsWebhookSubscriptionStateV1,
): Date | null {
  let earliest: number | null = null;
  for (const outcome of Object.values(state.outcomes)) {
    if (
      (outcome.status !== "pending" && outcome.status !== "transient") ||
      outcome.nextRetryAt === null
    ) {
      continue;
    }
    const timestamp = Date.parse(outcome.nextRetryAt);
    if (earliest === null || timestamp < earliest) earliest = timestamp;
  }
  return earliest === null ? null : new Date(earliest);
}

async function persistWithingsWebhookSubscriptionState(
  connectionId: string,
  state: WithingsWebhookSubscriptionStateV1,
): Promise<void> {
  await prisma.withingsConnection.update({
    where: { id: connectionId },
    data: {
      webhookSubscriptionState: state as unknown as Prisma.InputJsonValue,
      webhookSubscriptionRetryAt: earliestSubscriptionRetryAt(state),
    },
  });
}

function subscriptionFailureOutcome(
  previous: WithingsWebhookSubscriptionOutcome,
  err: unknown,
  now: Date,
): WithingsWebhookSubscriptionOutcome {
  const classified = classifyError(err);
  const classification = classified === "success" ? "transient" : classified;
  const attemptCount = previous.attemptCount + 1;
  const withingsStatus =
    err instanceof WithingsApiError &&
    typeof err.withingsStatus === "number" &&
    Number.isSafeInteger(err.withingsStatus)
      ? err.withingsStatus
      : null;
  return {
    status: classification,
    attemptCount,
    lastAttemptAt: now.toISOString(),
    nextRetryAt:
      classification === "transient"
        ? new Date(
            now.getTime() + subscriptionBackoffMs(attemptCount),
          ).toISOString()
        : null,
    withingsStatus,
  };
}

async function reconcileWithingsWebhookSubscriptions(
  userId: string,
  now: Date,
): Promise<void> {
  const connection = await prisma.withingsConnection.findUnique({
    where: { userId },
    select: {
      id: true,
      webhookSubscriptionState: true,
    },
  });
  if (!connection) return;

  const state = parseWithingsWebhookSubscriptionState(
    connection.webhookSubscriptionState,
    now,
  );
  const dueApplis = WITHINGS_NOTIFY_APPLIS.filter((appli) => {
    const outcome = state.outcomes[String(appli) as WithingsNotifyAppliKey];
    return (
      (outcome.status === "pending" || outcome.status === "transient") &&
      outcome.nextRetryAt !== null &&
      Date.parse(outcome.nextRetryAt) <= now.getTime()
    );
  });
  if (dueApplis.length === 0) return;

  let tokenInfo: WithingsValidToken | null;
  try {
    tokenInfo = await getValidToken(userId, { throwOnRefreshFailure: true });
  } catch (err) {
    for (const appli of dueApplis) {
      const key = String(appli) as WithingsNotifyAppliKey;
      state.outcomes[key] = subscriptionFailureOutcome(
        state.outcomes[key],
        err,
        now,
      );
      await persistWithingsWebhookSubscriptionState(connection.id, state);
    }
    return;
  }

  if (!tokenInfo) {
    for (const appli of dueApplis) {
      const key = String(appli) as WithingsNotifyAppliKey;
      const previous = state.outcomes[key];
      state.outcomes[key] = {
        status: "reauth_required",
        attemptCount: previous.attemptCount + 1,
        lastAttemptAt: now.toISOString(),
        nextRetryAt: null,
        withingsStatus: null,
      };
      await persistWithingsWebhookSubscriptionState(connection.id, state);
    }
    return;
  }

  const callbackUrl = getWithingsWebhookCallbackUrl();
  for (const appli of dueApplis) {
    const key = String(appli) as WithingsNotifyAppliKey;
    const previous = state.outcomes[key];
    try {
      await subscribeWebhook(tokenInfo.accessToken, callbackUrl, appli);
      state.outcomes[key] = {
        status: "success",
        attemptCount: previous.attemptCount + 1,
        lastAttemptAt: now.toISOString(),
        nextRetryAt: null,
        withingsStatus: null,
      };
      getEvent()?.addMeta(`webhook_subscribed_${appli}`, userId);
    } catch (err) {
      state.outcomes[key] = subscriptionFailureOutcome(previous, err, now);
      const outcome = state.outcomes[key];
      getEvent()?.addWarning(
        `Webhook subscription failed (appli=${appli}, classification=${outcome.status}, status=${outcome.withingsStatus ?? "unknown"})`,
      );
    }
    await persistWithingsWebhookSubscriptionState(connection.id, state);
  }
}

/**
 * Initial setup and reconnect both reconcile the durable state. Successful
 * categories are retained; reconnect resets the JSON before calling this.
 */
export async function setupWebhook(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await reconcileWithingsWebhookSubscriptions(userId, now);
}

/**
 * Hourly repair discovers only rows whose indexed retry timestamp is due, then
 * narrows again to due pending/transient categories inside the validated JSON.
 */
export async function retryDueWithingsWebhookSubscriptions(
  now: Date = new Date(),
): Promise<number> {
  const connections = await prisma.withingsConnection.findMany({
    where: { webhookSubscriptionRetryAt: { lte: now } },
    select: { userId: true },
  });
  for (const connection of connections) {
    await reconcileWithingsWebhookSubscriptions(connection.userId, now);
  }
  return connections.length;
}
