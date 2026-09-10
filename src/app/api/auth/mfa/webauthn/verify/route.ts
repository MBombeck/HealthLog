/**
 * POST /api/auth/mfa/webauthn/verify
 *
 * Complete a mid-login second-factor login challenge with a WebAuthn security
 * key. The caller presents the login `mfaTicket` plus the assertion from
 * /verify/options. On success the SAME session/token bundle the password path
 * issues is returned (web → cookie; native → access+refresh), with the session
 * stamped `mfaVerifiedAt`.
 *
 * Security invariants mirror /api/auth/mfa/verify (the TOTP path):
 * - No session/token exists until the assertion verifies — the partial state
 *   lives in the ticket, never in a half-built session.
 * - The ticket is claimed once, atomically, only AFTER the assertion verifies.
 * - A failed assertion increments the ticket attempt counter and burns it at
 *   the cap. Anonymous surface is rate-limited per IP on top of the cap.
 */
import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import {
  apiError,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { finishLogin } from "@/lib/auth/login-response";
import {
  loadActiveChallenge,
  recordChallengeFailure,
  claimChallenge,
} from "@/lib/auth/mfa/challenge";
import { verifyMfaAuthentication } from "@/lib/auth/mfa/webauthn";
import { mfaWebauthnLoginVerifySchema } from "@/lib/validations/mfa";
import { mintTrustedDevice } from "@/lib/auth/trusted-device";
import { coarseDeviceLabel } from "@/lib/auth/device-fingerprint";
import { setMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:mfa-verify",
    10,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    return apiError("Too many attempts. Please try again later.", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  await ensureDbCompatibility();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = mfaWebauthnLoginVerifySchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(
      "Invalid request",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }
  const { mfaTicket, challengeId, credential, rememberDevice } = parsed.data;

  const challenge = await loadActiveChallenge(mfaTicket);
  if (!challenge) {
    annotate({ action: { name: "auth.mfa.verify.invalid_ticket" } });
    return apiError("Invalid or expired challenge", 401);
  }

  // Only a login-issued challenge may be redeemed for a session here. A future
  // step-up or non-login challenge kind must never mint a login session through
  // this endpoint, so reject anything but "login" with the same generic 401.
  if (challenge.kind !== "login") {
    annotate({ action: { name: "auth.mfa.verify.invalid_ticket" } });
    return apiError("Invalid or expired challenge", 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: challenge.userId },
    select: { id: true, username: true, onboardingCompletedAt: true },
  });
  if (!user) {
    await recordChallengeFailure(challenge.id);
    return apiError("Invalid or expired challenge", 401);
  }

  let verified = false;
  try {
    verified = await verifyMfaAuthentication(challengeId, user.id, credential);
  } catch {
    // A malformed / expired WebAuthn challenge is a failed attempt, not a 500.
    verified = false;
  }

  if (!verified) {
    const { exhausted } = await recordChallengeFailure(challenge.id);
    await auditLog("auth.mfa.failed", {
      userId: user.id,
      ipAddress: ip,
      details: { stage: "login", method: "webauthn", exhausted },
    });
    annotate({
      action: { name: "auth.mfa.failed" },
      meta: { method: "webauthn", exhausted },
    });
    return apiError("Security key verification failed", 401);
  }

  // Assertion verified — claim the ticket atomically. Only the single winning
  // caller proceeds to mint a session.
  const claimed = await claimChallenge(challenge.id);
  if (!claimed) {
    annotate({ action: { name: "auth.mfa.verify.claim_lost" } });
    return apiError("Invalid or expired challenge", 401);
  }

  await auditLog("auth.mfa.verified", {
    userId: user.id,
    ipAddress: ip,
    details: { method: "webauthn" },
  });
  annotate({
    action: { name: "auth.mfa.verified" },
    meta: { method: "webauthn" },
  });

  const ua = request.headers.get("user-agent");

  // The user just completed a second factor — clear any forced-enrollment hint.
  await setMfaEnrollCookie(false);

  // v1.23 — "remember this device": skip the second factor on this browser for
  // 30 days. Set before finishLogin so both cookies share the response.
  if (rememberDevice) {
    await mintTrustedDevice(user.id, coarseDeviceLabel(ua));
  }

  return finishLogin({
    user,
    request,
    ip,
    userAgent: ua,
    source: "mfa.webauthn.verify",
    mfaVerified: true,
  });
});
