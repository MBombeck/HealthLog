import {
  apiHandler,
  requireGuardianAuth,
  SharingAccessDeniedError,
} from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import {
  getIntegrationStatus,
  type IntegrationKey,
} from "@/lib/integrations/status";
import { loadConnectionHealth } from "@/lib/integrations/connection-health-load";
import { annotate } from "@/lib/logging/context";
import {
  resolveGuardianRecordSettingsAccess,
  resolveManagedIntegrationState,
} from "@/lib/record-settings";

export const dynamic = "force-dynamic";

const MANAGED_INTEGRATIONS: readonly IntegrationKey[] = [
  "withings",
  "whoop",
  "fitbit",
  "nightscout",
  "polar",
  "oura",
  "google-health",
  "strava",
];

/**
 * Whether a managed profile's integrations are connected and how each is
 * doing. No credential projection. A guardian connects and disconnects the
 * profile's OAuth providers through `./[provider]/connect` and
 * `./[provider]/disconnect`, whose state names the profile itself rather than
 * carrying a record selector.
 */
export const GET = apiHandler(async () => {
  const context = await requireGuardianAuth();
  const access = resolveGuardianRecordSettingsAccess(context);
  if (!access) throw new SharingAccessDeniedError();
  const [statuses, withings, whoop, fitbit, googleHealth, credentials] =
    await Promise.all([
      Promise.all(
        MANAGED_INTEGRATIONS.map((integration) =>
          getIntegrationStatus(access.recordId, integration),
        ),
      ),
      prisma.withingsConnection.findUnique({
        where: { userId: access.recordId },
        select: { id: true },
      }),
      prisma.whoopConnection.findUnique({
        where: { userId: access.recordId },
        select: { whoopUserId: true },
      }),
      prisma.fitbitConnection.findUnique({
        where: { userId: access.recordId },
        select: { id: true },
      }),
      prisma.googleHealthConnection.findUnique({
        where: { userId: access.recordId },
        select: { id: true },
      }),
      // Presence only; the credentials themselves are not on the per-request
      // user and are not read past this null check.
      prisma.user.findUnique({
        where: { id: context.user.id },
        select: {
          nightscoutUrlEncrypted: true,
          polarAccessTokenEncrypted: true,
          ouraAccessTokenEncrypted: true,
          stravaAccessTokenEncrypted: true,
        },
      }),
    ]);
  const connected: Record<IntegrationKey, boolean> = {
    withings: withings !== null,
    whoop: whoop?.whoopUserId != null,
    fitbit: fitbit !== null,
    "google-health": googleHealth !== null,
    nightscout: (credentials?.nightscoutUrlEncrypted ?? null) !== null,
    polar: (credentials?.polarAccessTokenEncrypted ?? null) !== null,
    oura: (credentials?.ouraAccessTokenEncrypted ?? null) !== null,
    strava: (credentials?.stravaAccessTokenEncrypted ?? null) !== null,
    // Not offered on a managed profile (no managed integrations before
    // v1.44); listed so the map stays total.
    dawarich: false,
    // Garmin is a key the record's owner pastes on their own settings page;
    // a managed profile has none to offer.
    garmin: false,
  };
  // The one server-resolved state per connection, from the same loader the
  // owner's own envelope uses, so a guardian reads the record's connections in
  // the words the record's owner would.
  const health = await loadConnectionHealth(
    access.recordId,
    MANAGED_INTEGRATIONS,
  );
  const integrations = statuses.map((status) => ({
    integration: status.integration,
    state: resolveManagedIntegrationState(
      status.state,
      connected,
      status.integration,
    ),
    lastSuccessAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
    health: health[status.integration],
  }));

  annotate({ action: { name: "record-settings.integrations.get" } });

  return apiSuccess({ recordId: access.recordId, integrations });
});
