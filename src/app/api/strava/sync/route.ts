import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";
import { syncUserStrava } from "@/lib/strava/sync";

/**
 * Manually trigger a Strava sync for the current user (v1.32.28).
 *
 * Incremental by nature: Strava already carries a real cursor
 * (`stravaLastActivityAt` minus an overlap), so a manual run picks up wherever
 * the last one stopped. No `fullSync` flag — deep history belongs to the
 * connect-time backfill queue, which is self-converging and already gated.
 *
 * Rate-limited 5/60s per user, matching the hardened Google Health
 * route; Strava's 200-req / 15-min cap leaves no room for a retry loop.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "strava.sync" } });

  const rl = await checkRateLimit(`strava-sync:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many sync requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  try {
    const imported = await syncUserStrava(user.id);
    // `failed: false` is a statement, not a placeholder: the Strava walk has no
    // settled-but-partial arm. `upsertStravaWorkouts` rethrows the first row
    // error after attempting the batch and the page walk rethrows its own, so
    // reaching this line means every fetched activity was written.
    return apiSuccess(resolveSyncOutcome({ imported, failed: false }));
  } catch {
    // Already recorded on the `strava` ledger with its classification. Answer
    // generically so no upstream detail rides the response body.
    return apiError("Strava sync failed", 502);
  }
});
