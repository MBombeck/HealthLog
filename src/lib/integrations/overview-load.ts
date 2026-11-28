/**
 * Gather what `./overview` resolves, for one account, in one round.
 *
 * Reads the shared connection facts (the same loader every other health
 * surface uses), the stored-credential markers, the delivery-channel rows and
 * what the operator offers. Read-only.
 */
import { prisma } from "@/lib/db";
import { getGlobalServiceAvailability } from "@/lib/app-settings";
import { documentSourcesAvailable } from "@/lib/documents/sources/origins";
import { isModuleEnabled } from "@/lib/modules/gate";
import { isEmailConfigured } from "@/lib/notifications/senders/email-config";
import { getOuraClientCredentials } from "@/lib/oura/credentials";
import { getPolarClientCredentials } from "@/lib/polar/credentials";
import { getStravaClientCredentials } from "@/lib/strava/credentials";

import { loadConnectionFacts } from "./connection-health-load";
import {
  CHANNEL_KEY_TYPE,
  OVERVIEW_CHANNEL_KEYS,
  OVERVIEW_SOURCE_KEYS,
  resolveChannelItem,
  resolveSourceItem,
  type IntegrationOverview,
  type OverviewChannelKey,
  type SourceInput,
} from "./overview";

export async function loadIntegrationOverview(
  userId: string,
  now: Date = new Date(),
): Promise<IntegrationOverview> {
  const [
    facts,
    user,
    folder,
    documentConnections,
    channelRows,
    services,
    polarAvailable,
    ouraAvailable,
    stravaAvailable,
    environmentOn,
    documentsOn,
  ] = await Promise.all([
    loadConnectionFacts(userId),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        withingsClientIdEncrypted: true,
        withingsClientSecretEncrypted: true,
        whoopClientIdEncrypted: true,
        whoopClientSecretEncrypted: true,
        googleHealthClientIdEncrypted: true,
        googleHealthClientSecretEncrypted: true,
        fitbitRemovalNoticeAt: true,
      },
    }),
    prisma.healthConnectRemoteSource.findUnique({
      where: { userId },
      select: { enabled: true },
    }),
    prisma.documentSourceConnection.count({ where: { userId } }),
    prisma.notificationChannel.findMany({
      where: { userId },
      select: {
        type: true,
        enabled: true,
        disabledReason: true,
        consecutiveFailures: true,
        lastSuccessAt: true,
        lastFailureAt: true,
        nextRetryAt: true,
      },
    }),
    getGlobalServiceAvailability(),
    getPolarClientCredentials(userId).then((c) => !!c),
    getOuraClientCredentials(userId).then((c) => !!c),
    getStravaClientCredentials(userId).then((c) => !!c),
    isModuleEnabled(userId, "environment"),
    isModuleEnabled(userId, "inboundDocuments"),
  ]);

  const storedPair = {
    withings:
      !!user?.withingsClientIdEncrypted &&
      !!user?.withingsClientSecretEncrypted,
    whoop: !!user?.whoopClientIdEncrypted && !!user?.whoopClientSecretEncrypted,
    "google-health":
      !!user?.googleHealthClientIdEncrypted &&
      !!user?.googleHealthClientSecretEncrypted,
  };
  const sharedApp = {
    polar: polarAvailable,
    oura: ouraAvailable,
    strava: stravaAvailable,
  };

  const sources = OVERVIEW_SOURCE_KEYS.map((key) => {
    if (key === "document-sources") {
      return resolveSourceItem({
        key,
        connected: documentConnections > 0,
        configured: documentConnections > 0,
        health: null,
        offered: documentsOn && documentSourcesAvailable(),
      });
    }
    const fact = facts.get(key);
    const input: SourceInput = {
      key,
      connected: fact?.connected ?? false,
      configured: false,
      health: fact?.health ?? null,
      offered: true,
    };
    if (key === "withings" || key === "whoop" || key === "google-health") {
      input.configured = storedPair[key];
      input.needsOwnCredentials = !storedPair[key];
    } else if (key === "polar" || key === "oura" || key === "strava") {
      input.needsOwnCredentials = !sharedApp[key];
    } else if (key === "dawarich") {
      input.offered = environmentOn;
    } else if (key === "health-connect-app") {
      // A paired Android device is the whole setup; there is nothing short of it.
      input.configured = input.connected;
    } else if (key === "health-connect-remote") {
      input.configured = folder !== null;
      input.paused = folder !== null && !folder.enabled;
    }
    return resolveSourceItem(input);
  });

  const rows = new Map(channelRows.map((row) => [row.type, row]));
  const channelOffered: Record<OverviewChannelKey, boolean> = {
    telegram: services.telegramGlobal,
    ntfy: services.ntfyGlobal,
    "web-push": services.webPushGlobal,
    webhook: true,
    email: isEmailConfigured(),
    // Set up by the iPhone app, never from here.
    apns: false,
  };
  const channels = OVERVIEW_CHANNEL_KEYS.map((key) =>
    resolveChannelItem({
      key,
      row: rows.get(CHANNEL_KEY_TYPE[key]) ?? null,
      offered: channelOffered[key],
      now,
    }),
  );

  return {
    items: [...sources, ...channels],
    fitbitRemovalNotice: !!user?.fitbitRemovalNoticeAt,
  };
}
