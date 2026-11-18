import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { resolveSyncOutcome } from "@/lib/outcome/written-outcome";
import { syncUserOura } from "@/lib/oura/sync";

/**
 * Manually trigger an Oura sync for the current user (v1.32.28).
 *
 * Until now Oura only ever synced on its hourly cron tick, so a user who could
 * see something was behind had no way to ask for a fresh pull.
 *
 * No body and no `fullSync` flag: `syncUserOura` has no full-history arm, and
 * the window is not the caller's to choose — the sync derives it from the
 * newest row it already holds, which is what makes a catch-up honest. Accepting
 * a `lookbackDays` here would hand an unvalidated cost knob to the client.
 *
 * Rate-limited 5/60s per user, matching the hardened Google Health
 * route; a sync is a fan-out of upstream requests plus a batched write, so a
 * tight retry loop must not be able to pin Prisma or burn the Oura budget.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.sync" } });

  const rl = await checkRateLimit(`oura-sync:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many sync requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  try {
    const result = await syncUserOura(user.id);
    return apiSuccess(resolveSyncOutcome(result));
  } catch {
    // The failure is already on the `oura` ledger, classified by the provider
    // that owns the error shape. Answer generically — an upstream message can
    // carry detail that has no business in a response body.
    return apiError("Oura sync failed", 502);
  }
});
