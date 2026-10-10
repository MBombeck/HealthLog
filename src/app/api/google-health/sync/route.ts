import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { readSyncTriggerBody } from "@/lib/integrations/sync-request";
import { syncUserGoogleHealth } from "@/lib/google-health/sync";
import type {
  GoogleHealthReasonCode,
  GoogleHealthResourceOutcome,
  GoogleHealthResourceStatus,
} from "@/lib/google-health/sync-progress";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";
import { NextRequest } from "next/server";

const RESOURCE_STATUSES = new Set<GoogleHealthResourceStatus>([
  "pending",
  "complete",
  "partial",
  "empty",
  "truncated",
  "failed",
]);
const REASON_CODES = new Set<GoogleHealthReasonCode>([
  "collection_failed",
  "token_failed",
  "upsert_failed",
  "rollup_failed",
  "existing_page_limit",
]);

function boundedInteger(value: unknown, maximum = 2_147_483_647): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.trunc(value)))
    : 0;
}

function publicResourceOutcome(value: unknown): GoogleHealthResourceOutcome {
  const item =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    resource:
      typeof item.resource === "string"
        ? item.resource
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .slice(0, 48)
        : "unknown",
    pages: boundedInteger(item.pages),
    fetched: boundedInteger(item.fetched),
    mapped: boundedInteger(item.mapped),
    written: boundedInteger(item.written),
    status: RESOURCE_STATUSES.has(item.status as GoogleHealthResourceStatus)
      ? (item.status as GoogleHealthResourceStatus)
      : "failed",
    durationMs: boundedInteger(item.durationMs, 86_400_000),
    truncated: item.truncated === true,
    reasonCode: REASON_CODES.has(item.reasonCode as GoogleHealthReasonCode)
      ? (item.reasonCode as GoogleHealthReasonCode)
      : null,
  };
}

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

  const body = await readSyncTriggerBody(request);
  if (body.error) return body.error;
  const { fullSync } = body;

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

  const result = await syncUserGoogleHealth(user.id, { fullSync });
  // Another run of this account holds it (the history backfill after a
  // reconnect, or the hourly poll). Starting a second one beside it is what
  // pushed accounts over Google's per-minute quota; the card follows the
  // running one through the status route instead.
  if (result.busy) {
    return apiError("A Google Health sync is already running", 409, {
      errorCode: "sync_in_progress",
    });
  }
  // A run that failed AND wrote nothing is an error, as it always was. A run
  // that failed after writing some of its resources is a partial, and answering
  // 502 for it threw away the honest half of the result.
  if (result.failed && result.imported === 0) {
    return apiError("Google Health sync failed", 502);
  }
  const resources = Array.isArray(result.resources)
    ? result.resources.slice(0, 16).map(publicResourceOutcome)
    : undefined;
  return apiSuccess({
    ...resolveSyncOutcome(result),
    ...(result.runId ? { runId: result.runId.slice(0, 128) } : {}),
    ...(result.state ? { state: result.state } : {}),
    fullSync,
    ...(resources ? { resources } : {}),
  });
});
