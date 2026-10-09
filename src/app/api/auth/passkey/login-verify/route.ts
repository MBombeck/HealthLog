import {
  PasskeyAuthError,
  verifyAuthentication,
  type PasskeyAuthErrorKind,
} from "@/lib/auth/passkey";
import { createSession } from "@/lib/auth/session";
import { syncMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";
import { recordSignInDevice } from "@/lib/auth/login-alert";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { issueApiToken, isNativeClientRequest } from "@/lib/auth/issue-token";
import {
  resolveTokenPolicy,
  shouldIssueBearerToken,
  isCookielessNativeCaller,
} from "@/lib/auth/native-client";
import { issueAccessAndRefresh } from "@/lib/auth/refresh-token";
import { isOidcOnly } from "@/lib/auth/oidc";
import { completePendingOidcLink } from "@/lib/auth/oidc-pending-link";

const PASSKEY_VERIFICATION_FAILED_CODE = "passkey.verification.failed";

/**
 * How each passkey refusal answers. The challenge and verification cases are
 * 401 (the sign-in did not prove anything), the unknown credential is 404 (the
 * passkey is not registered on this server), and a malformed body is 422.
 */
const PASSKEY_REFUSALS: Record<
  PasskeyAuthErrorKind,
  { status: number; errorCode: string; message: string; auditReason: string }
> = {
  challenge_expired: {
    status: 401,
    errorCode: "passkey.challenge.expired",
    message: "The sign-in took too long or was already used. Try again.",
    auditReason: "passkey_challenge_expired",
  },
  unknown_passkey: {
    status: 404,
    errorCode: "passkey.unknown",
    message: "This passkey is not registered here.",
    auditReason: "passkey_unknown",
  },
  malformed: {
    status: 422,
    errorCode: "passkey.response.invalid",
    message: "The passkey response could not be read.",
    auditReason: "passkey_response_invalid",
  },
  verification_failed: {
    status: 401,
    errorCode: PASSKEY_VERIFICATION_FAILED_CODE,
    message: "Passkey verification failed",
    auditReason: "passkey_verification_failed",
  },
};

export const POST = apiHandler(async (request: NextRequest) => {
  // OIDC_ONLY must block passkey login too, not just password login — a
  // credential minted before SSO was mandated must not stay a live bypass.
  if (isOidcOnly()) {
    return apiError("Passkey login is disabled. Sign in with SSO.", 403, {
      errorCode: "oidc_only",
    });
  }

  await ensureDbCompatibility();

  // v1.4.43 W13 M-4 — tighter shared bucket on trust-chain misconfig.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:passkey-verify",
    10,
    15 * 60 * 1000,
  );
  const ip = rl.ip;
  if (!rl.allowed) {
    return apiError("Too many attempts. Please wait 15 minutes.", 429);
  }

  const { data: body, error: jsonError } = await safeJson<
    Record<string, unknown>
  >(request, { maxBytes: 64 * 1024 });

  if (jsonError) return jsonError;
  const challengeId = body.challengeId as string | undefined;
  const credential = body.credential;

  if (!challengeId || !credential) {
    return apiError("challengeId and credential required", 422);
  }

  let outcome: Awaited<ReturnType<typeof verifyAuthentication>>;
  try {
    outcome = await verifyAuthentication(challengeId, credential);
  } catch (err) {
    // A known client-side case — an expired challenge, a passkey that is no
    // longer registered here, a malformed or refused assertion — answers
    // with its own status and code (iOS #116, item 20) so the app can tell
    // the person what to do instead of reporting a server error. Anything
    // else is a real fault and keeps propagating.
    if (!(err instanceof PasskeyAuthError)) throw err;
    const refusal = PASSKEY_REFUSALS[err.kind];
    await auditLog("auth.login.failed", {
      ipAddress: ip,
      details: { reason: refusal.auditReason },
    });
    annotate({
      action: { name: "auth.login.passkey.refused" },
      meta: { reason: err.kind },
    });
    return apiError(refusal.message, refusal.status, {
      errorCode: refusal.errorCode,
    });
  }
  const { verification, passkey } = outcome;

  if (!verification.verified) {
    await auditLog("auth.login.failed", {
      ipAddress: ip,
      details: { reason: "passkey_verification_failed" },
    });
    return apiError("Passkey verification failed", 401, {
      errorCode: PASSKEY_VERIFICATION_FAILED_CODE,
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: passkey.userId },
  });

  if (!user) {
    return apiError("User not found", 404);
  }

  // v1.4.22 W5 reconcile (Sr-H1) — `createSession` anchors the
  // `hl_onboarding` cookie itself; pass the user's onboarding state
  // through so the proxy short-circuits the redirect before
  // hydration.
  //
  // v1.23 (M-review M1) — stamp `mfaVerifiedAt` on a primary passkey login. A
  // discoverable passkey is a phishing-resistant possession factor that already
  // cleared user verification (`userVerification: 'required'` on the ceremony),
  // so a passwordless passkey sign-in is itself a satisfied second factor: it
  // meets an MFA-enforcement policy AND passes `requireFreshMfa` step-up,
  // exactly like a completed password+TOTP login. (The password+TOTP path is
  // unchanged — it stamps the session at `/api/auth/mfa/verify`.)
  // The passkey proved this account's own credential, so a single sign-on
  // identity this browser was sent here to confirm may now be linked to it.
  await completePendingOidcLink(user.id, ip ?? null);

  const ua = request.headers.get("user-agent");
  await createSession(
    user.id,
    user.onboardingCompletedAt == null,
    ip,
    ua,
    new Date(),
  );

  // v1.23 — sync the admin-enforced-MFA forced-enrollment hint cookie.
  await syncMfaEnrollCookie(user.id, {
    totpConfirmedAt: user.totpConfirmedAt,
    mfaEnforced: user.mfaEnforced,
  });

  await auditLog("auth.login.passkey", {
    userId: user.id,
    ipAddress: ip,
  });

  // v1.23 — new-device / new-location alert, fire-and-forget (see finishLogin).
  void recordSignInDevice({ userId: user.id, ip, userAgent: ua });

  annotate({ action: { name: "auth.login.passkey" } });

  if (
    shouldIssueBearerToken(request.headers) ||
    isNativeClientRequest(request.headers)
  ) {
    const policy = resolveTokenPolicy(request.headers);
    const deviceId = request.headers.get("x-device-id");

    // M-3 hardening: only a genuinely cookie-less native caller receives a
    // 60-day refresh token; a browser spoofing `X-Client-Type: native`
    // falls through to the plain access-token path below.
    if (
      policy.refreshTokenDays !== null &&
      isCookielessNativeCaller(request.headers)
    ) {
      const bundle = await issueAccessAndRefresh({
        userId: user.id,
        policy,
        deviceId,
        userAgent: ua,
        ipAddress: ip ?? null,
        source: "login.passkey",
      });
      await auditLog("auth.token.autoissue.native", {
        userId: user.id,
        ipAddress: ip,
        details: { source: "login.passkey", policy: "native" },
      });
      annotate({
        action: { name: "auth.token.autoissue.native" },
        meta: { token_policy: "native" },
      });
      return apiSuccess({
        user: { id: user.id, username: user.username },
        token: bundle.accessToken,
        tokenExpiresAt: bundle.accessTokenExpiresAt.toISOString(),
        refreshToken: bundle.refreshToken,
        refreshTokenExpiresAt: bundle.refreshTokenExpiresAt.toISOString(),
      });
    }

    const issued = await issueApiToken({
      userId: user.id,
      name: `web auto-login ${new Date().toISOString()}`,
      permissions: ["*"],
      expiresInDays: policy.accessTokenDays,
    });
    await auditLog("auth.token.autoissue.native", {
      userId: user.id,
      ipAddress: ip,
      details: {
        tokenId: issued.tokenId,
        source: "login.passkey",
        policy: "web",
      },
    });
    annotate({
      action: { name: "auth.token.autoissue.native" },
      meta: { token_policy: "web" },
    });
    return apiSuccess({
      user: { id: user.id, username: user.username },
      token: issued.token,
      tokenExpiresAt: issued.expiresAt.toISOString(),
    });
  }

  return apiSuccess({
    user: { id: user.id, username: user.username },
  });
});
