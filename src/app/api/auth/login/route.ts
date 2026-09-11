import { prisma } from "@/lib/db";
import { loginPasswordSchema } from "@/lib/validations/auth";
import { verifyPasswordOrDummy } from "@/lib/auth/password";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";
import {
  apiError,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { finishLogin } from "@/lib/auth/login-response";
import { createMfaChallenge } from "@/lib/auth/mfa/challenge";
import { consumeTrustedDevice } from "@/lib/auth/trusted-device";
import { syncMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";
import { isOidcOnly } from "@/lib/auth/oidc";

export const POST = apiHandler(async (request: NextRequest) => {
  // OIDC_ONLY means password login must be a dead end, not just a hidden
  // button — otherwise a pre-existing password (or a leaked/reused one)
  // stays a live bypass of the operator's SSO-only policy.
  if (isOidcOnly()) {
    return apiError("Password login is disabled. Sign in with SSO.", 403, {
      errorCode: "oidc_only",
    });
  }

  // v1.4.43 W13 M-4 — `checkAuthSurfaceRateLimit` swaps to a tighter
  // global bucket when the trust chain is misconfigured; otherwise it
  // is byte-equivalent to the previous per-IP `auth:login:{ip}` key.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:login",
    5,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    return NextResponse.json(
      {
        data: null,
        error: "Too many login attempts. Please try again later.",
      },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  await ensureDbCompatibility();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = loginPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return apiValidationError(
      "Invalid credentials",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }

  const { email, password } = parsed.data;
  const identifier = email.trim();
  // HMAC of the typed identifier — keyed by `API_TOKEN_HMAC_KEY`. The
  // raw identifier stays out of the audit row (H-1 contract); the hash
  // gives a future spray-detector a forensic anchor it can correlate
  // across IPs without having to look up users by email.
  const identifierHash = hashToken(identifier);

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: identifier, mode: "insensitive" } },
        { username: { equals: identifier, mode: "insensitive" } },
      ],
    },
  });

  // One verification for every outcome. An unknown identifier and an
  // account carrying no password hash (a passkey-only account) used to
  // return here before any hashing, so the three answers cost one indexed
  // SELECT, one indexed SELECT, and a full Argon2id verification
  // respectively — identical bodies, three different durations, which is a
  // readable answer to "is this address registered, and does it have a
  // password". `verifyPasswordOrDummy` verifies against a fixed dummy hash
  // minted at the same cost parameters when there is no stored hash, and
  // returns false. Keep the call ahead of the branch: moving it back under
  // an `if` restores the channel.
  const valid = await verifyPasswordOrDummy(user?.passwordHash, password);

  if (!user || !user.passwordHash) {
    // v1.4.43 W3-SECURITY (H-1): never write the typed identifier into
    // the audit row — `reason` already tells the operator what
    // happened, and PII must not land in operator artefacts. The
    // HMAC anchor below is one-way — recoverable only with the HMAC
    // key (operator secret), used purely to group same-identifier
    // attempts across IPs.
    await auditLog("auth.login.failed", {
      ipAddress: ip,
      details: { reason: "user_not_found_or_no_password", identifierHash },
    });
    return apiError("Invalid credentials", 401);
  }

  if (!valid) {
    await auditLog("auth.login.failed", {
      userId: user.id,
      ipAddress: ip,
      details: { reason: "invalid_password", identifierHash },
    });
    return apiError("Invalid credentials", 401);
  }

  const ua = request.headers.get("user-agent");

  await auditLog("auth.login.password", {
    userId: user.id,
    ipAddress: ip,
  });

  // v1.23 — second-factor gate. The password is correct, but an account with
  // a confirmed second factor (a TOTP secret and/or a registered WebAuthn
  // security key) is NOT yet authenticated: no `Session` row and no token
  // bundle is minted here. Instead a single-use, ~5-minute MFA ticket is
  // returned (the partial state lives in the ticket, never in a half-built
  // session) and the client completes the login at `/api/auth/mfa/verify`
  // (TOTP / recovery) or `/api/auth/mfa/webauthn/verify` (security key).
  //
  // Enumeration note: `meta.mfaRequired` is only ever returned AFTER a valid
  // password, and the invalid-credentials response above is identical
  // regardless of MFA state — an attacker without the password cannot learn
  // whether an account has MFA.
  const hasTotp = Boolean(user.totpConfirmedAt);
  const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
    where: { userId: user.id },
  });
  const hasWebauthn = webauthnKeyCount > 0;

  if (hasTotp || hasWebauthn) {
    // v1.23 — "remember this device". A browser the user previously trusted
    // skips factor 2 within the 30-day window. The password (factor 1) has
    // already been verified above, so a trusted device only ever drops the
    // second challenge — it never replaces the password. The minted session is
    // deliberately NOT stamped `mfaVerifiedAt` (mfaVerified omitted below), so a
    // trusted-device login can never satisfy step-up (`requireFreshMfa`): a
    // stolen device cookie cannot reach a destructive action.
    if (await consumeTrustedDevice(user.id)) {
      await auditLog("auth.mfa.trusted_device", {
        userId: user.id,
        ipAddress: ip,
      });
      annotate({
        action: { name: "auth.mfa.trusted_device" },
        meta: { mfa_skipped: true },
      });
      // The account has a second factor, so the enforcement gate is satisfied;
      // keep the hint cookie honest.
      await syncMfaEnrollCookie(user.id, {
        totpConfirmedAt: user.totpConfirmedAt,
        mfaEnforced: user.mfaEnforced,
      });
      return finishLogin({
        user,
        request,
        ip,
        userAgent: ua,
        source: "login.password.trusted_device",
      });
    }

    const challenge = await createMfaChallenge(user.id, "login");
    // Recovery codes are only ever issued alongside TOTP enrollment, so the
    // recovery method is offered exactly when TOTP is active.
    const methods: ("totp" | "recovery" | "webauthn")[] = [];
    if (hasTotp) methods.push("totp", "recovery");
    if (hasWebauthn) methods.push("webauthn");
    await auditLog("auth.mfa.challenge", {
      userId: user.id,
      ipAddress: ip,
      details: { source: "login.password" },
    });
    annotate({
      action: { name: "auth.mfa.challenge" },
      meta: { mfa_required: true },
    });
    return NextResponse.json(
      {
        data: null,
        error: null,
        meta: {
          mfaRequired: true,
          mfaTicket: challenge.ticket,
          methods,
        },
      },
      { status: 200 },
    );
  }

  annotate({ action: { name: "auth.login.password" } });

  // v1.23 — admin-enforced MFA policy. A single-factor account under the policy
  // is sent to forced enrollment after sign-in; the proxy reads this hint
  // cookie without a DB round-trip. Cheap (short-circuits when not enforced).
  await syncMfaEnrollCookie(user.id, {
    totpConfirmedAt: user.totpConfirmedAt,
    mfaEnforced: user.mfaEnforced,
  });

  // No second factor — issue the session/token exactly as before.
  return finishLogin({
    user,
    request,
    ip,
    userAgent: ua,
    source: "login.password",
  });
});
