/**
 * POST /api/auth/step-up/options
 *
 * Begin an assertion ceremony for the step-up mint. Two kinds:
 *
 *   `passkey`  — against the account's PRIMARY passkeys. At parity with
 *                `/api/auth/passkey/login-verify`, which the web treats as a
 *                second-factor-grade proof.
 *   `webauthn` — against the account's registered SECOND-FACTOR security keys.
 *
 * Returns SimpleWebAuthn assertion options plus the server-issued challenge id
 * to present back at `POST /api/auth/step-up`.
 *
 * Bearer-only (`requireBearerAuth`) — a browser has no use for this surface; it
 * re-proves a factor at login and carries the result on its session row. The
 * allow-list is never empty by construction: an account with no credential of
 * the requested kind gets a 409 so the client can offer another arm.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireBearerAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { createAuthenticationOptions } from "@/lib/auth/passkey";
import { createMfaAuthenticationOptions } from "@/lib/auth/mfa/webauthn";
import { stepUpOptionsSchema } from "@/lib/validations/step-up";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireBearerAuth();

  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:step-up",
    20,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Too many attempts. Please try again later.", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = stepUpOptionsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid request", 422);
  }

  if (parsed.data.method === "webauthn") {
    const result = await createMfaAuthenticationOptions(user.id);
    if (!result) {
      annotate({ action: { name: "auth.stepup.webauthn.no_key" } });
      return apiError("No security key registered", 409);
    }
    annotate({ action: { name: "auth.stepup.webauthn.options" } });
    return apiSuccess({
      options: result.options,
      challengeId: result.challengeId,
    });
  }

  const passkeyCount = await prisma.passkey.count({
    where: { userId: user.id },
  });
  if (passkeyCount === 0) {
    annotate({ action: { name: "auth.stepup.passkey.none" } });
    return apiError("No passkey registered", 409);
  }

  const { options, challengeId } = await createAuthenticationOptions(user.id);

  annotate({ action: { name: "auth.stepup.passkey.options" } });
  return apiSuccess({ options, challengeId });
});
