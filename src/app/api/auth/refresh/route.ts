/**
 * POST /api/auth/refresh — exchange a one-time-use refresh token for a new
 * access + refresh pair. Audited on every call (success + failure).
 */
import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { hashToken } from "@/lib/auth/hmac";
import {
  checkAuthSurfaceRateLimit,
  checkRateLimit,
  peekRateLimit,
} from "@/lib/rate-limit";
import {
  resolveTokenPolicy,
  NATIVE_REFRESH_TOKEN_DAYS,
} from "@/lib/auth/native-client";
import {
  rotateRefreshToken,
  revokeRefreshToken,
} from "@/lib/auth/refresh-token";

/**
 * A refresh refused for a missing second factor leaves the token live, and a
 * client that answers every refusal with another refresh would ask for ever.
 * After this many refusals of one token in the window, the same answer comes
 * without looking the token up again, and `Retry-After` says when to ask.
 */
const MFA_REFUSAL_LIMIT = 3;
const MFA_REFUSAL_WINDOW_MS = 5 * 60 * 1000;

function mfaEnrollmentRefusal(resetAt: number): Response {
  const response = apiError(
    "This account needs two-factor sign-in. Set it up in the web app under Settings > Security, then sign in here again.",
    403,
    { errorCode: "auth.mfa.enrollment_required" },
  );
  const seconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  response.headers.set("Retry-After", String(seconds));
  return response;
}

export const POST = apiHandler(async (request: NextRequest) => {
  // v1.4.43 — tighter shared bucket on trust-chain misconfig.
  // Refresh is a high-value rotation endpoint; align it with the
  // passkey-verify tier (10/15min) rather than the looser 60/15min. A
  // legitimate device rotates well under this — the 24h access token only
  // forces a refresh roughly daily — while reuse-detection still caps
  // genuine abuse.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:refresh",
    10,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    return apiError("Too many refresh attempts. Please retry later.", 429);
  }

  const { data: body, error: jsonError } = await safeJson<{
    refreshToken?: string;
    revoke?: boolean;
  }>(request, { maxBytes: 64 * 1024 });
  if (jsonError) return jsonError;
  if (!body.refreshToken || typeof body.refreshToken !== "string") {
    return apiError("refreshToken required", 422);
  }

  // logout-on-device path: client wants to invalidate the refresh token.
  if (body.revoke) {
    const ok = await revokeRefreshToken(body.refreshToken);
    annotate({
      action: { name: "auth.token.refresh.revoke" },
      meta: { refresh_revoked: ok },
    });
    await auditLog("auth.token.refresh.revoke", {
      ipAddress: ip,
      details: { ok },
    });
    return apiSuccess({ revoked: ok });
  }

  const policy = resolveTokenPolicy(request.headers);
  // Refresh always uses the native policy: a refresh token only exists for
  // native callers, and we never want to upgrade it back to a 90d token.
  if (policy.refreshTokenDays === null) {
    policy.refreshTokenDays = NATIVE_REFRESH_TOKEN_DAYS;
    policy.accessTokenDays = 1;
  }

  // The token's earlier refusals for a missing factor, keyed on its hash: a
  // token that keeps being refused is answered without another lookup.
  const refusalKey = `auth:refresh-mfa:${hashToken(body.refreshToken)}`;
  const refusals = await peekRateLimit(refusalKey);
  if (refusals && refusals.count >= MFA_REFUSAL_LIMIT) {
    annotate({
      action: { name: "auth.token.refresh.failed" },
      meta: { refresh_failure: "mfa_enrollment_required_repeat" },
    });
    return mfaEnrollmentRefusal(refusals.resetAt);
  }

  const result = await rotateRefreshToken({
    refreshToken: body.refreshToken,
    policy,
    deviceId: request.headers.get("x-device-id"),
    userAgent: request.headers.get("user-agent"),
    ipAddress: ip,
  });

  if (!result.ok) {
    await auditLog("auth.token.refresh.failed", {
      ipAddress: ip,
      details: { reason: result.reason },
    });
    annotate({
      action: { name: "auth.token.refresh.failed" },
      meta: { refresh_failure: result.reason },
    });
    // v1.7.0 — stable machine `errorCode` so native clients can branch
    // re-auth-required from a transient blip without string-matching the
    // human-prose `error`:
    //   - `auth.refresh.reuse`   — a consumed token was presented again;
    //     the device's refresh family is now revoked (stolen-token
    //     signal). The client must re-pair, not retry.
    //   - `auth.refresh.revoked` — the family was revoked out-of-band
    //     (explicit logout, or reuse detected on another device). Also
    //     terminal: re-auth required.
    //   - `auth.refresh.invalid` — not found / expired, or the family has
    //     reached its absolute lifetime (`family_ended`,
    //     REFRESH_TOKEN_MAX_LIFETIME_DAYS from its sign-in). The client drops
    //     the token and re-authenticates; the code is the same for both
    //     because the client's answer is the same.
    //   - `auth.refresh.superseded` (409) — a concurrent refresh with the
    //     same token won; nothing is revoked. Not terminal: the client reads
    //     the pair the winner stored and carries on. It must not present
    //     this token again, which would be a replay.
    if (result.reason === "already_used") {
      return apiError(
        "Refresh token reuse detected. Please log in again.",
        401,
        { errorCode: "auth.refresh.reuse" },
      );
    }
    if (result.reason === "superseded") {
      return apiError(
        "This refresh token was rotated by a concurrent request. Use the newest stored credentials; do not retry with this token.",
        409,
        { errorCode: "auth.refresh.superseded" },
      );
    }
    //   - `auth.mfa.enrollment_required` (403) — a second-factor policy
    //     covers the account, it has none, and its grace period is over. The
    //     token is not consumed: the person adds a factor in a browser and the
    //     same token refreshes again.
    if (result.reason === "mfa_enrollment_required") {
      const charged = await checkRateLimit(
        refusalKey,
        MFA_REFUSAL_LIMIT,
        MFA_REFUSAL_WINDOW_MS,
      );
      return mfaEnrollmentRefusal(charged.resetAt);
    }
    if (result.reason === "revoked") {
      return apiError(
        "Refresh token has been revoked. Please log in again.",
        401,
        { errorCode: "auth.refresh.revoked" },
      );
    }
    return apiError("Invalid refresh token", 401, {
      errorCode: "auth.refresh.invalid",
    });
  }

  await auditLog("auth.token.refresh", {
    ipAddress: ip,
    details: { policy: policy.policy },
  });
  annotate({
    action: { name: "auth.token.refresh" },
    meta: { token_policy: policy.policy },
  });

  return apiSuccess({
    token: result.bundle.accessToken,
    tokenExpiresAt: result.bundle.accessTokenExpiresAt.toISOString(),
    refreshToken: result.bundle.refreshToken,
    refreshTokenExpiresAt: result.bundle.refreshTokenExpiresAt.toISOString(),
  });
});
