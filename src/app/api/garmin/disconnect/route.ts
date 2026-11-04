import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { markDisconnected } from "@/lib/integrations/status";
import { clearGarminTokenCache } from "@/lib/garmin/client";

/**
 * Disconnect the caller's Garmin key.
 *
 * Clears the sealed key and everything stored about it (region, expiry,
 * backfill progress) and parks the `garmin` ledger at `disconnected`. Rows
 * already imported stay: disconnecting stops future syncs, it does not
 * delete history. The key stays valid at Garmin until it is revoked there.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "garmin.disconnect" } });

  const rl = await checkRateLimit(`garmin-disconnect:${user.id}`, 20, 60_000);
  if (!rl.allowed) {
    return apiError("Too many requests", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { garminApiKeyEncrypted: true },
  });
  if (!dbUser?.garminApiKeyEncrypted) {
    return apiError("No Garmin connection", 404);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      garminApiKeyEncrypted: null,
      garminRegion: null,
      garminConnectedAt: null,
      garminKeyExpiresAt: null,
      garminBackfillProgress: Prisma.DbNull,
      garminBackfillCompletedAt: null,
    },
  });
  clearGarminTokenCache(user.id);

  await auditLog("garmin.disconnect", { userId: user.id });
  await markDisconnected(user.id, "garmin");

  return apiSuccess({ disconnected: true });
});
