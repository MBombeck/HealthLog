/**
 * POST /api/auth/mfa/verify
 *
 * Complete a second-factor login challenge. The caller presents the opaque
 * `mfaTicket` from the `meta.mfaRequired` login response plus a TOTP or
 * recovery code. On success the **same** session/token bundle the password
 * path issues is returned (web → session cookie; native → access+refresh),
 * with the session stamped `mfaVerifiedAt`.
 *
 * Security-critical invariants:
 * - No session or token exists until the factor passes — the partial state
 *   lived in the ticket, never in a half-built session.
 * - The ticket is **claimed once, atomically**, only AFTER the factor
 *   verifies; two concurrent valid submissions can mint at most one session.
 * - Wrong factors increment the ticket attempt counter and burn it at the
 *   cap (NIST throttle, not an account lock). Anonymous surface is rate-
 *   limited per IP on top of the per-ticket cap.
 */
import { NextRequest } from "next/server";
import {
  apiError,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
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
import { verifyMfaFactor } from "@/lib/auth/mfa/verify-factor";
import { mfaVerifySchema } from "@/lib/validations/mfa";
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
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = mfaVerifySchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(
      "Invalid request",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }
  const { mfaTicket, method, code, rememberDevice } = parsed.data;

  // Resolve the ticket. A single generic 401 covers unknown / expired /
  // consumed / over-cap so a ticket-guesser learns nothing.
  const challenge = await loadActiveChallenge(mfaTicket);
  if (!challenge) {
    annotate({ action: { name: "auth.mfa.verify.invalid_ticket" } });
    return apiError("Invalid or expired challenge", 401);
  }

  // Only a login-issued challenge may be redeemed for a session here. A future
  // step-up or webauthn challenge kind must never mint a login session through
  // this endpoint, so reject anything but "login" with the same generic 401.
  if (challenge.kind !== "login") {
    annotate({ action: { name: "auth.mfa.verify.invalid_ticket" } });
    return apiError("Invalid or expired challenge", 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: challenge.userId },
    select: {
      id: true,
      username: true,
      email: true,
      onboardingCompletedAt: true,
      totpConfirmedAt: true,
      totpSecretEncrypted: true,
      totpLastStep: true,
    },
  });

  // The factor must still be active (it could have been disabled between the
  // password step and this call). Treat anything else as a failed attempt.
  if (!user || !user.totpConfirmedAt) {
    await recordChallengeFailure(challenge.id);
    annotate({ action: { name: "auth.mfa.verify.no_active_factor" } });
    return apiError("Invalid or expired challenge", 401);
  }

  const factor = await verifyMfaFactor(user, method, code);
  if (!factor.ok) {
    const { exhausted } = await recordChallengeFailure(challenge.id);
    await auditLog("auth.mfa.failed", {
      userId: user.id,
      ipAddress: ip,
      details: { stage: "login", method, replay: factor.replay, exhausted },
    });
    annotate({
      action: { name: "auth.mfa.failed" },
      meta: { method, replay: factor.replay, exhausted },
    });
    return apiError("Invalid code", 401);
  }

  // Factor verified — claim the ticket atomically. Only the single winning
  // caller proceeds to mint a session; a concurrent claim loses here.
  const claimed = await claimChallenge(challenge.id);
  if (!claimed) {
    annotate({ action: { name: "auth.mfa.verify.claim_lost" } });
    return apiError("Invalid or expired challenge", 401);
  }

  await auditLog("auth.mfa.verified", {
    userId: user.id,
    ipAddress: ip,
    details: { method },
  });
  if (method === "recovery") {
    await auditLog("auth.mfa.recovery_used", {
      userId: user.id,
      ipAddress: ip,
    });
  }
  annotate({ action: { name: "auth.mfa.verified" }, meta: { method } });

  const ua = request.headers.get("user-agent");

  // The user just completed a second factor, so any forced-enrollment redirect
  // must clear immediately.
  await setMfaEnrollCookie(false);

  // v1.23 — "remember this device". Mint the trusted-device token + cookie
  // (only its hash is stored) so subsequent logins from this browser skip the
  // second factor for 30 days. Set BEFORE finishLogin so both cookies land on
  // the same response. A recovery-code login is excluded: it signals the user
  // lost their device, so trusting the current browser would be unsafe.
  if (rememberDevice && method !== "recovery") {
    await mintTrustedDevice(user.id, coarseDeviceLabel(ua));
  }

  return finishLogin({
    user,
    request,
    ip,
    userAgent: ua,
    source: "mfa.verify",
    mfaVerified: true,
  });
});
