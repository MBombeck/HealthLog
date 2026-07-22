import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { syncUserGoogleHealth } from "@/lib/google-health/sync";
import { NextRequest } from "next/server";

/**
 * Manually trigger a Google Health sync for the current user (v1.26.0).
 *
 * Mirrors the Fitbit manual-sync route: incremental by default, full history
 * when `{ fullSync: true }` is posted.
 *
 * Rate-limited: a baseline 5/60s bucket gates the route, and the expensive
 * `fullSync` path (which drives paginated Google Health walkers across every
 * data type, each capped at 1000 pages) carries a tighter 1/hour bucket of its
 * own so a re-trigger loop cannot pin Prisma or churn the Google Health quota.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "google_health.sync" } });

  const rl = await checkRateLimit(`google-health-sync:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many sync requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  let fullSync = false;
  try {
    const raw = await request.text();
    // Flag-only payload — cap the parse cost (mirrors safeJson maxBytes).
    if (raw.length > 64 * 1024) {
      return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
    }
    const body = JSON.parse(raw);
    fullSync = body?.fullSync === true;
  } catch {
    // no body provided -> default incremental sync
  }

  // The full-history walk is the expensive path; cap it well below the
  // incremental bucket so a re-trigger loop cannot churn the Google quota.
  if (fullSync) {
    const fullRl = await checkRateLimit(
      `google-health-sync-full:${user.id}`,
      1,
      60 * 60_000,
    );
    if (!fullRl.allowed) {
      return apiError("Full sync is limited to once per hour", 429, {
        errorCode: "rate_limited_self",
      });
    }
  }

  const { imported, failed } = await syncUserGoogleHealth(user.id, {
    fullSync,
  });
  if (failed) {
    return apiError("Google Health sync failed", 502);
  }
  return apiSuccess({ imported, fullSync });
});
