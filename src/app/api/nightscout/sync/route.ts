import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { syncUserNightscout } from "@/lib/nightscout/sync";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";

/**
 * Manually trigger a Nightscout sync for the current user (v1.32.28).
 *
 * Pulls the recent SGV window from the configured instance; `imported` counts
 * the readings that were genuinely new this run, not the ones re-confirmed,
 * and `outcome` says how that count reads — a window in which every row was
 * refused by a constraint imports 0 and must not answer like a quiet night.
 *
 * No body and no `fullSync` flag: there is no full-history arm to call.
 *
 * The error arm answers with a fixed message and NEVER the caught error's own.
 * A Nightscout base URL carries the API token as a query parameter, so an
 * upstream message can contain the user's secret; echoing it here would put it
 * in a response body, a browser devtools panel, and any proxy log in between.
 * The classified failure is already on the `nightscout` ledger, recorded by the
 * provider with its redaction rules applied.
 *
 * Rate-limited 5/60s per user, matching the hardened Google Health
 * route; every run is an outbound call to a user-supplied host.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "nightscout.sync" } });

  const rl = await checkRateLimit(`nightscout-sync:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many sync requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  try {
    const result = await syncUserNightscout(user.id);
    return apiSuccess(resolveSyncOutcome(result));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "reasonCode" in error &&
      error.reasonCode === "private_origin_not_approved"
    ) {
      return apiError(
        "Private Nightscout access requires server operator approval",
        422,
        { errorCode: "private_origin_not_approved" },
      );
    }
    return apiError("Nightscout sync failed", 502);
  }
});
