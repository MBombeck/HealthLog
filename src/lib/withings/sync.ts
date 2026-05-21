/**
 * Withings sync service — handles fetching and storing measurements,
 * token refresh, and webhook subscription management.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { encrypt, decrypt } from "@/lib/crypto";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  fetchMeasurements,
  refreshAccessToken,
  subscribeWebhook,
} from "./client";
import { getUserWithingsCredentials } from "./credentials";
import { getEvent } from "@/lib/logging/context";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";

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

/**
 * Get valid access token for a user, refreshing if expired.
 */
export async function getValidToken(userId: string): Promise<{
  accessToken: string;
  connection: { id: string; withingsUserId: string };
} | null> {
  const connection = await prisma.withingsConnection.findUnique({
    where: { userId },
  });

  if (!connection) return null;

  const accessToken = decrypt(connection.accessToken);
  const refreshToken = decrypt(connection.refreshToken);

  // Check if token is expired (with 5 min buffer)
  if (connection.tokenExpiresAt.getTime() - 5 * 60 * 1000 < Date.now()) {
    try {
      const creds = await getUserWithingsCredentials(userId);
      if (!creds) {
        getEvent()?.addWarning(
          `No credentials found for user ${userId} during token refresh`,
        );
        // Without credentials we cannot refresh OR re-authenticate — the
        // user has to re-enter the client_id/secret. Mark as reauth so
        // scheduled syncs back off.
        await recordSyncFailure({
          userId,
          integration: "withings",
          kind: "reauth_required",
          message: "Withings credentials missing — token refresh skipped",
          errorCode: "credentials_missing",
        });
        return null;
      }

      const newTokens = await refreshAccessToken(refreshToken, creds);

      const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);
      await prisma.withingsConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: encrypt(newTokens.access_token),
          refreshToken: encrypt(newTokens.refresh_token),
          tokenExpiresAt: expiresAt,
        },
      });

      return {
        accessToken: newTokens.access_token,
        connection: {
          id: connection.id,
          withingsUserId: connection.withingsUserId,
        },
      };
    } catch (err) {
      getEvent()?.addWarning(`Token refresh failed for user ${userId}: ${err}`);
      // Withings refresh failures expose the upstream `status` code in
      // the error message (see refreshAccessToken). We treat any of the
      // documented permanent-revoke statuses (100, 101, 102, 200..299
      // for invalid_grant) as reauth-required and everything else as a
      // transient retryable failure.
      const message = err instanceof Error ? err.message : String(err);
      const isReauth = isWithingsRefreshReauthFailure(message);
      await recordSyncFailure({
        userId,
        integration: "withings",
        kind: isReauth ? "reauth_required" : "transient",
        message,
        errorCode: extractWithingsStatus(message),
      });
      return null;
    }
  }

  return {
    accessToken,
    connection: {
      id: connection.id,
      withingsUserId: connection.withingsUserId,
    },
  };
}

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
      ? new Date(connection.lastSyncedAt.getTime() - 60 * 1000) // overlap 1 min to avoid gaps
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days back

  let measures: Awaited<ReturnType<typeof fetchMeasurements>>;
  try {
    measures = await fetchMeasurements(tokenInfo.accessToken, startDate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSyncFailure({
      userId,
      integration: "withings",
      kind: isWithingsRefreshReauthFailure(message)
        ? "reauth_required"
        : "transient",
      message,
      errorCode: extractWithingsStatus(message),
    });
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
          data: { value: m.value },
        });
      } else {
        await prisma.measurement.create({
          data: {
            userId,
            type: measType,
            value: m.value,
            unit: getUnitForType(m.type),
            measuredAt: m.measuredAt,
            source: "WITHINGS",
          },
        });
      }
      touched.push({ type: measType, measuredAt: m.measuredAt });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(`Failed to upsert measure: ${err}`);
    }
  }

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
  } catch (err) {
    getEvent()?.addWarning(
      `withings: rollup recompute failed for ${userId}: ${err}`,
    );
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
 * Withings notify appli categories HealthLog cares about today. Each
 * category requires its own subscribe call.
 *
 * - 1 — weight + body composition (meastypes 1, 5, 6, 8, 88)
 * - 2 — temperature (meastypes 12, 71, 73)
 * - 4 — pressure family (BP dia 9, BP sys 10, pulse 11, SpO2 54)
 * - 16 — activity (steps, distance, active energy, floors climbed);
 *        v1.4.25 W17b webhook-primary trigger for the new
 *        `syncUserActivity` routine.
 * - 44 — sleep v2 (per-stage segments + nightly summary); v1.4.25 W17c
 *        webhook-primary trigger for the new `syncUserSleep` routine.
 *
 * Without 2 and 4, BP and temperature readings flow only through the
 * hourly poll fallback. Adding them removes up to an hour of latency
 * on a freshly-taken BP reading without changing the OAuth scope. The
 * activity + sleep categories require the `user.activity` scope from
 * W5d; legacy connections that never reconnected sit on `user.metrics`
 * only and the subscribe call returns 503/293 — `setupWebhook` logs
 * the failure and keeps the remaining appli subscriptions.
 */
export const WITHINGS_NOTIFY_APPLIS = [1, 2, 4, 16, 44] as const;

/**
 * Subscribe to every Withings notify category HealthLog ingests. Each
 * appli is its own subscribe call upstream; a failure on one category
 * is logged and we continue with the rest, because losing one webhook
 * is strictly better than rolling back all three.
 */
export async function setupWebhook(userId: string): Promise<void> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return;

  const callbackUrl = getWithingsWebhookCallbackUrl();
  for (const appli of WITHINGS_NOTIFY_APPLIS) {
    try {
      await subscribeWebhook(tokenInfo.accessToken, callbackUrl, appli);
      getEvent()?.addMeta(`webhook_subscribed_${appli}`, userId);
    } catch (err) {
      getEvent()?.addWarning(
        `Webhook subscribe (appli=${appli}) failed for user ${userId}: ${err}`,
      );
    }
  }
}
