/**
 * POST /api/auth/refresh — exchange a one-time-use refresh token for a new
 * access + refresh pair. Audited on every call (success + failure).
 */
import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import {
  apiSuccess,
  apiError,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import {
  resolveTokenPolicy,
  NATIVE_REFRESH_TOKEN_DAYS,
} from "@/lib/auth/native-client";
import {
  rotateRefreshToken,
  revokeRefreshToken,
} from "@/lib/auth/refresh-token";

export const POST = apiHandler(async (request: NextRequest) => {
  // v1.4.43 W13 M-4 — tighter shared bucket on trust-chain misconfig.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:refresh",
    60,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    return apiError("Too many refresh attempts. Please retry later.", 429);
  }

  const { data: body, error: jsonError } = await safeJson<{
    refreshToken?: string;
    revoke?: boolean;
  }>(request);
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
    //   - `auth.refresh.invalid` — not found / expired. The client drops
    //     the token and re-authenticates.
    if (result.reason === "already_used") {
      return apiError(
        "Refresh token reuse detected — please log in again.",
        401,
        { errorCode: "auth.refresh.reuse" },
      );
    }
    if (result.reason === "revoked") {
      return apiError(
        "Refresh token has been revoked — please log in again.",
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
