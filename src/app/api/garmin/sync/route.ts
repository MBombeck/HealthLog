import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { syncUserGarmin } from "@/lib/garmin/sync";
import { isGarminKeyRefusal } from "@/lib/garmin/client";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";

/**
 * Manually trigger a Garmin sync for the current user.
 *
 * Reads the recent window of every resource; the history is the backfill's.
 * `imported` counts rows written this run and `outcome` says how that count
 * reads. No body. The error arm answers with a fixed message: the classified
 * failure is already on the `garmin` ledger.
 *
 * Rate-limited 5/60 s per user, like the sibling sync routes.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "garmin.sync" } });

  const rl = await checkRateLimit(`garmin-sync:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many sync requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  try {
    const result = await syncUserGarmin(user.id);
    return apiSuccess(resolveSyncOutcome(result));
  } catch (error) {
    if (isGarminKeyRefusal(error)) {
      return apiError(
        "Garmin no longer accepts the stored key. Create a new one and connect again.",
        422,
        { errorCode: "garmin.key_refused" },
      );
    }
    return apiError("Garmin sync failed", 502);
  }
});
