import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { readSyncTriggerBody } from "@/lib/integrations/sync-request";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";
import { syncUserWhoop } from "@/lib/whoop/sync";
import { NextRequest } from "next/server";
import { withDataChangeOrigin } from "@/lib/push-relay/data-changed";

/**
 * Manually trigger a WHOOP sync for the current user (v1.11.0).
 *
 * Mirrors the Withings manual-sync route: incremental by default, full
 * history when `{ fullSync: true }` is posted.
 *
 * Rate-limited on both arms, matching the Google Health sibling.
 * This route and the Withings one were the two that never got a limiter, while
 * `fullSync` drives the full four-resource history walk against WHOOP's
 * per-user budget: a tight loop or a stolen native token could exhaust it and
 * pin Prisma. A baseline 5/60s bucket gates the route and the expensive
 * `fullSync` path carries a tighter 1/hour bucket of its own.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.sync" } });

  const rl = await checkRateLimit(`whoop-sync:${user.id}`, 5, 60_000);
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
      `whoop-sync-full:${user.id}`,
      1,
      60 * 60_000,
    );
    if (!fullRl.allowed) {
      return apiError("Full sync is limited to once per hour", 429, {
        errorCode: "rate_limited_self",
      });
    }
  }

  // Resolved server-side so the card and the native client cannot disagree on
  // how the same run reads.
  const result = await withDataChangeOrigin(
    request.headers.get("x-device-id"),
    () => syncUserWhoop(user.id, { fullSync }),
  );
  return apiSuccess({ ...resolveSyncOutcome(result), fullSync });
});
