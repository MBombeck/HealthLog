import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { readSyncTriggerBody } from "@/lib/integrations/sync-request";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { NextRequest } from "next/server";

/**
 * Manually trigger a Withings sync for the current user.
 *
 * Rate-limited on both arms, matching the Google Health sibling.
 * This route and the WHOOP one were the two that never got a limiter, while
 * `fullSync` drives the full measure-history walk against Withings' per-user
 * budget: a tight loop or a stolen native token could exhaust it and pin
 * Prisma. A baseline 5/60s bucket gates the route and the expensive `fullSync`
 * path carries a tighter 1/hour bucket of its own.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.sync" } });

  const rl = await checkRateLimit(`withings-sync:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many sync requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const body = await readSyncTriggerBody(request);
  if (body.error) return body.error;
  const { fullSync } = body;

  if (fullSync) {
    const fullRl = await checkRateLimit(
      `withings-sync-full:${user.id}`,
      1,
      60 * 60_000,
    );
    if (!fullRl.allowed) {
      return apiError("Full sync is limited to once per hour", 429, {
        errorCode: "rate_limited_self",
      });
    }
  }

  const result = await syncUserMeasurements(user.id, { fullSync });
  return apiSuccess({ ...resolveSyncOutcome(result), fullSync });
});
