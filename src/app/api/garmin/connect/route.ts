import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { markReconnected } from "@/lib/integrations/status";
import { GARMIN_SYNC_QUEUE } from "@/lib/jobs/integration-poll-queues";
import { GARMIN_BACKFILL_QUEUE } from "@/lib/jobs/garmin-backfill-queue";
import { integrationBackfillSourceOptions } from "@/lib/jobs/integration-backfill-admission";
import { enqueueWhenBossReady } from "@/lib/jobs/boss-ready";
import {
  clearGarminTokenCache,
  exchangeGarminKey,
  GarminApiError,
  type GarminToken,
} from "@/lib/garmin/client";
import {
  estimateGarminKeyExpiry,
  resolveGarminKeyExpiry,
} from "@/lib/garmin/key-expiry";
import { garminConnectSchema } from "@/lib/validations/garmin";

/**
 * Connect (or replace) the caller's Garmin Personal API key (#1333).
 *
 * The key is validated by buying a token with it before anything is stored:
 * a mistyped, revoked or expired key answers here, not on the first cron
 * tick. Garmin runs a separate service for accounts in China; the person
 * picks one, only that host is contacted, and the choice is kept so the
 * sync talks to the same host.
 *
 * On success the key is sealed at rest, the expiry is noted (Garmin's own
 * when the token reveals it, else the validity the person picked), the
 * history backfill is reopened, the `garmin` ledger is reset to connected,
 * and a first sync plus the backfill are sent best-effort. The key is never
 * logged, audited or echoed: the audit row carries only the region.
 *
 * Rate-limited 10/60 s per user: every attempt is an outbound exchange.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "garmin.connect" } });

  const rl = await checkRateLimit(`garmin-connect:${user.id}`, 10, 60_000);
  if (!rl.allowed) {
    return apiError("Too many connection attempts", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const parsed = await parseJsonBody(request, garminConnectSchema, {
    maxBytes: 16 * 1024,
    message: "A valid Garmin Personal API key is required",
  });
  if (!parsed.ok) return parsed.error;

  const { apiKey, region, validityDays } = parsed.data;

  // Only the service the person chose is asked: the key is theirs to send,
  // and a key for one service means nothing to the other.
  let token: GarminToken | null = null;
  let lastError: unknown = null;
  try {
    token = await exchangeGarminKey(apiKey, region);
  } catch (err) {
    lastError = err;
  }

  if (!token) {
    annotate({
      meta: {
        "garmin.connect.refused":
          lastError instanceof GarminApiError ? lastError.reason : "network",
      },
    });
    if (lastError instanceof GarminApiError && lastError.keyRefused) {
      return apiError(
        "Garmin did not accept this key. Check that it was copied whole and has not expired or been revoked.",
        422,
        { errorCode: "garmin.key_refused" },
      );
    }
    if (lastError instanceof GarminApiError && lastError.httpStatus === 429) {
      return apiError(
        "Garmin is limiting requests right now. Try again in a few minutes.",
        422,
        { errorCode: "garmin.rate_limited" },
      );
    }
    return apiError(
      "Could not reach Garmin. Try again in a few minutes.",
      422,
      { errorCode: "garmin.unreachable" },
    );
  }

  const connectedAt = new Date();
  const keyExpiresAt =
    token.keyExpiresAt !== null
      ? new Date(token.keyExpiresAt)
      : validityDays
        ? estimateGarminKeyExpiry(connectedAt, validityDays)
        : null;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      // Field by field; never the parsed body.
      garminApiKeyEncrypted: encrypt(apiKey),
      garminRegion: region,
      garminConnectedAt: connectedAt,
      garminKeyExpiresAt: keyExpiresAt,
      // A new key reopens the history walk from today.
      garminBackfillProgress: Prisma.DbNull,
      garminBackfillCompletedAt: null,
    },
  });
  clearGarminTokenCache(user.id);

  await markReconnected(user.id, "garmin");
  await auditLog("garmin.connect", { userId: user.id, details: { region } });

  await enqueueWhenBossReady("garmin-sync", async (boss) => {
    await boss
      .send(GARMIN_SYNC_QUEUE, { userId: user.id })
      .catch((err) =>
        getEvent()?.addWarning(`garmin-sync connect enqueue failed: ${err}`),
      );
    await boss
      .send(
        GARMIN_BACKFILL_QUEUE,
        { userId: user.id, enqueuedAt: new Date().toISOString() },
        integrationBackfillSourceOptions(`garmin-backfill|${user.id}`),
      )
      .catch((err) =>
        getEvent()?.addWarning(
          `garmin-backfill connect enqueue failed: ${err}`,
        ),
      );
  });

  return apiSuccess({
    connected: true,
    region,
    keyExpiry: resolveGarminKeyExpiry(keyExpiresAt),
  });
});
