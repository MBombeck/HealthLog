import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { loadOneConnectionHealth } from "@/lib/integrations/connection-health-load";
import { getIntegrationStatus } from "@/lib/integrations/status";
import {
  INTEGRATION_CADENCE,
  resolveSyncVerdict,
} from "@/lib/integrations/sync-verdict";
import { resolveGarminKeyExpiry } from "@/lib/garmin/key-expiry";
import {
  garminBackfillShare,
  garminUnavailableResources,
  readGarminBackfillProgress,
} from "@/lib/garmin/backfill-progress";
import { isGarminRegion } from "@/lib/garmin/client";

/**
 * Garmin connection status for the current user.
 *
 * `configured` is whether a key is stored. The ledger snapshot and the
 * server-resolved health come off the shared `garmin` IntegrationKey, the
 * same as every sibling. `keyExpiry` is the one Garmin-specific fact: when
 * the key stops working, and whether that is close, resolved here so web and
 * iOS warn alike. The key itself is never returned.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "garmin.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      garminApiKeyEncrypted: true,
      garminRegion: true,
      garminKeyExpiresAt: true,
      garminBackfillProgress: true,
      garminBackfillCompletedAt: true,
    },
  });
  if (!dbUser?.garminApiKeyEncrypted) {
    return apiSuccess({ connected: false, configured: false });
  }

  const status = await getIntegrationStatus(user.id, "garmin");
  const progress = readGarminBackfillProgress(dbUser.garminBackfillProgress);
  return apiSuccess({
    connected: true,
    configured: true,
    region: isGarminRegion(dbUser.garminRegion)
      ? dbUser.garminRegion
      : "global",
    keyExpiry: resolveGarminKeyExpiry(dbUser.garminKeyExpiresAt),
    backfill: {
      complete: dbUser.garminBackfillCompletedAt !== null,
      share: dbUser.garminBackfillCompletedAt
        ? 1
        : garminBackfillShare(progress),
    },
    unavailableResources: garminUnavailableResources(progress),
    state: status.state,
    lastSuccessAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
    lastError: status.lastError,
    syncHealth: resolveSyncVerdict({
      connected: true,
      configured: true,
      state: status.state,
      lastSuccessAt: status.lastSuccessAt,
      lastAttemptAt: status.lastAttemptAt,
      failingSinceAt: status.failingSince,
      cadence: INTEGRATION_CADENCE["garmin"],
    }),
    health: await loadOneConnectionHealth(user.id, "garmin"),
  });
});
