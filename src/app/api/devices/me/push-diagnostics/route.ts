/**
 * GET /api/devices/me/push-diagnostics
 *
 * The calling device's push state for the app's push diagnostics screen: its
 * route, relay binding, silent budget, owed sync, last delivery per kind,
 * last envelope receipt and masked APNs token. The device is the one the
 * request names in `X-Device-Id`, as for `push.device` on `/api/auth/me`; a
 * header that names none of the caller's devices answers 404, whether the
 * device belongs to another account or to none. Everything is computed in
 * `src/lib/push-relay/diagnostics.ts`, which the admin diagnostic shares.
 *
 * A cookie session or a wildcard token (the native sign-in mints one); a
 * narrow token is refused by the default scope.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { devicePushDiagnostics } from "@/lib/push-relay/diagnostics";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "devices.push_diagnostics.read" } });

  const rl = await checkRateLimit(
    `push-diagnostics:${user.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    const limited = apiError("Too many diagnostics requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      limited.headers.set(k, v);
    }
    return limited;
  }

  const diagnostics = await devicePushDiagnostics(
    user.id,
    request.headers.get("x-device-id"),
  );
  const response = diagnostics
    ? apiSuccess(diagnostics)
    : apiError("Device not found", 404);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
});
