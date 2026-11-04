import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { getGarminCredentials } from "@/lib/garmin/credentials";
import { exchangeGarminKey, GarminApiError } from "@/lib/garmin/client";
import { SafeFetchError } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

/**
 * Cheap live probe of the stored Garmin key: buy one token with it,
 * through the same exchange the sync uses. Nothing is written; the token is
 * dropped.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "garmin.test" } });

  const rl = await checkRateLimit(`garmin-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const creds = await getGarminCredentials(user.id);
  if (!creds) {
    return apiError("Garmin not connected", 422, {
      errorCode: "not_configured",
    });
  }

  const start = performance.now();
  try {
    await exchangeGarminKey(creds.apiKey, creds.region);
    return apiSuccess({
      ok: true,
      latencyMs: Math.round(performance.now() - start),
    });
  } catch (e) {
    if (e instanceof GarminApiError) {
      const code = e.keyRefused
        ? "credentials_rejected"
        : e.httpStatus === 429
          ? "rate_limited"
          : e.httpStatus !== undefined && e.httpStatus >= 500
            ? "upstream_error"
            : "connection_failed";
      annotate({
        meta: { garmin_test_status: e.httpStatus, garmin_test_code: code },
      });
      return apiError(
        code === "credentials_rejected"
          ? "Garmin rejected the key"
          : code === "rate_limited"
            ? "Garmin rate-limited the request"
            : code === "upstream_error"
              ? "Garmin returned an error"
              : "Garmin connection failed",
        502,
        { errorCode: code },
      );
    }
    const isTimeout = e instanceof SafeFetchError && e.kind === "timeout";
    annotate({
      meta: { garmin_test_code: isTimeout ? "timeout" : "connection_failed" },
    });
    return apiError(
      isTimeout ? "Garmin request timed out" : "Garmin connection failed",
      502,
      { errorCode: isTimeout ? "timeout" : "connection_failed" },
    );
  }
});
