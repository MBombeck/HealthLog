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

export function getWithingsWebhookCallbackUrl(): string {
  const baseUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/withings/webhook`;
  const secret = process.env.WITHINGS_WEBHOOK_SECRET;
  if (!secret) return baseUrl;

  const url = new URL(baseUrl);
  url.searchParams.set("secret", secret);
  return url.toString();
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
 */
export async function syncUserMeasurements(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
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

  const measures = await fetchMeasurements(tokenInfo.accessToken, startDate);

  let imported = 0;

  for (const m of measures) {
    // Upsert to avoid duplicates (unique on userId+type+measuredAt+source)
    const measType = m.type as MeasurementType;
    try {
      await prisma.measurement.upsert({
        where: {
          userId_type_measuredAt_source: {
            userId,
            type: measType,
            measuredAt: m.measuredAt,
            source: "WITHINGS",
          },
        },
        update: { value: m.value },
        create: {
          userId,
          type: measType,
          value: m.value,
          unit: getUnitForType(m.type),
          measuredAt: m.measuredAt,
          source: "WITHINGS",
        },
      });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(`Failed to upsert measure: ${err}`);
    }
  }

  // Update last synced timestamp
  await prisma.withingsConnection.update({
    where: { userId },
    data: { lastSyncedAt: new Date() },
  });

  return imported;
}

/**
 * Subscribe to Withings webhook for a user.
 */
export async function setupWebhook(userId: string): Promise<void> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return;

  try {
    await subscribeWebhook(
      tokenInfo.accessToken,
      getWithingsWebhookCallbackUrl(),
    );
    getEvent()?.addMeta("webhook_subscribed", userId);
  } catch (err) {
    getEvent()?.addWarning(
      `Webhook subscribe failed for user ${userId}: ${err}`,
    );
  }
}
