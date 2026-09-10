/**
 * POST /api/auth/mfa/webauthn/verify/options
 *
 * Begin a mid-login second-factor security-key assertion. The caller presents
 * the opaque `mfaTicket` from the `meta.mfaRequired` login response; the server
 * resolves the password-identified user and returns assertion options scoped to
 * that user's registered MFA security keys (never an empty allow-list — a
 * non-resident credential is not discoverable).
 *
 * Anonymous surface (no session yet), rate-limited per IP. A single generic
 * 401 covers every unknown / expired / consumed ticket so a guesser learns
 * nothing.
 */
import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { loadActiveChallenge } from "@/lib/auth/mfa/challenge";
import { createMfaAuthenticationOptions } from "@/lib/auth/mfa/webauthn";
import { mfaWebauthnLoginOptionsSchema } from "@/lib/validations/mfa";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:mfa-verify",
    10,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Too many attempts. Please try again later.", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  await ensureDbCompatibility();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = mfaWebauthnLoginOptionsSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(
      "Invalid request",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }

  const challenge = await loadActiveChallenge(parsed.data.mfaTicket);
  if (!challenge) {
    annotate({ action: { name: "auth.mfa.verify.invalid_ticket" } });
    return apiError("Invalid or expired challenge", 401);
  }

  // Only a login-issued challenge may begin a login assertion here. Reject any
  // other challenge kind with the same generic 401.
  if (challenge.kind !== "login") {
    annotate({ action: { name: "auth.mfa.verify.invalid_ticket" } });
    return apiError("Invalid or expired challenge", 401);
  }

  const result = await createMfaAuthenticationOptions(challenge.userId);
  if (!result) {
    // No registered security key for this account — the client should fall
    // back to a TOTP / recovery code.
    annotate({ action: { name: "auth.mfa.webauthn.no_key" } });
    return apiError("No security key registered", 409);
  }

  annotate({ action: { name: "auth.mfa.webauthn.verify-options" } });
  return apiSuccess({
    options: result.options,
    challengeId: result.challengeId,
  });
});
