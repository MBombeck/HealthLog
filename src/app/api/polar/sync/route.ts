import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { syncUserPolarLegs } from "@/lib/jobs/reminder/polar-sync";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";

/**
 * Manually trigger a Polar sync for the current user (v1.32.28).
 *
 * Calls `syncUserPolarLegs` — the same entry point the hourly poll uses — so
 * both Polar legs run with the attribution rules that were built for them
 * (vitals then workouts, independent failure recording, one success stamp).
 * Reaching past it into `@/lib/polar/*` would run half the provider and get the
 * ledger wrong. The module graph behind this import bottoms out in the shared
 * Prisma client and constants, so it is safe on the request path.
 *
 * No body and no `fullSync` flag: there is no full-history arm to call.
 *
 * Rate-limited 5/60s per user, matching the hardened Google Health
 * route.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.sync" } });

  const rl = await checkRateLimit(`polar-sync:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many sync requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  try {
    const result = await syncUserPolarLegs(user.id);
    return apiSuccess(resolveSyncOutcome(result));
  } catch {
    // Both legs record their own classified failure on the `polar` ledger.
    // Answer generically so no upstream detail rides the response body.
    return apiError("Polar sync failed", 502);
  }
});
