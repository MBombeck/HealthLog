/**
 * v1.4.43 W14 — manual resume endpoint for a parked Withings
 * integration.
 *
 * Background: B4 introduced the `parked` state in
 * `src/lib/integrations/status.ts`. Once a Withings persistent-failure
 * streak (contract-mismatch 293/294) has been running for more than
 * 24h, the status writer flips the row to `parked` and the sync
 * entry-point short-circuits via `isReauthRequired`. The user (or an
 * operator) calls this endpoint to clear the park and let the next
 * cron tick attempt the sync again.
 *
 * Rate-limited (5/min per user) to match the existing
 * `/api/integrations/withings/test` endpoint — there's no upstream
 * call here, but a misbehaving client tab loop would still rack up
 * audit-log rows if the limit was absent.
 *
 * Returns 200 with `{ resumed: true, wasParked: boolean }`. The
 * `wasParked` flag lets the caller decide whether to surface a "you
 * resumed it" toast or treat the action as a no-op (the row was
 * already connected / disconnected). Either way the endpoint is
 * idempotent — a second click in the same second sees the same
 * post-state and writes no extra audit row.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { resumeIntegrationFromPark } from "@/lib/integrations/status";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.withings.resume" } });

  const rl = await checkRateLimit(
    `withings-resume:${user.id}`,
    5,
    60_000,
  );
  if (!rl.allowed) {
    return apiError("Too many resume requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const result = await resumeIntegrationFromPark(user.id, "withings");
  annotate({
    meta: {
      withings_resume_was_parked: result.wasParked,
    },
  });

  return apiSuccess({ resumed: true, wasParked: result.wasParked });
});
