import { prisma } from "@/lib/db";
import { loginPasswordSchema } from "@/lib/validations/auth";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  safeJson,
} from "@/lib/api-response";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { issueApiToken, isNativeClientRequest } from "@/lib/auth/issue-token";
import {
  resolveTokenPolicy,
  shouldIssueBearerToken,
} from "@/lib/auth/native-client";
import { issueAccessAndRefresh } from "@/lib/auth/refresh-token";

export const POST = apiHandler(async (request: NextRequest) => {
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

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = loginPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return apiError("Invalid credentials", 422);
  }

  const { email, password } = parsed.data;
  const identifier = email.trim();

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: identifier, mode: "insensitive" } },
        { username: { equals: identifier, mode: "insensitive" } },
      ],
    },
  });

  if (!user || !user.passwordHash) {
    // v1.4.43 W3-SECURITY (H-1): never write the typed identifier into
    // the audit row — `reason` already tells the operator what
    // happened, and PII must not land in operator artefacts.
    await auditLog("auth.login.failed", {
      ipAddress: ip,
      details: { reason: "user_not_found_or_no_password" },
    });
    return apiError("Invalid credentials", 401);
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    await auditLog("auth.login.failed", {
      userId: user.id,
      ipAddress: ip,
      details: { reason: "invalid_password" },
    });
    return apiError("Invalid credentials", 401);
  }

  const ua = request.headers.get("user-agent");
  // v1.4.22 W5 reconcile (Sr-H1) — `createSession` now anchors the
  // `hl_onboarding` cookie itself; pass the user's onboarding state
  // through so the proxy can short-circuit the redirect before the
  // page hydrates.
  await createSession(user.id, user.onboardingCompletedAt == null, ip, ua);

  await auditLog("auth.login.password", {
    userId: user.id,
    ipAddress: ip,
  });

  annotate({ action: { name: "auth.login.password" } });

  // v1.4 G4: Native callers (iOS, n8n, Health-Connect, unrecognised UAs)
  // get a 24h access token + 60d rotating refresh token. Web UAs keep the
  // legacy 90d Bearer (issued only when X-Client-Type: native is set —
  // browser flows continue to use the session cookie).
  if (
    shouldIssueBearerToken(request.headers) ||
    isNativeClientRequest(request.headers)
  ) {
    const policy = resolveTokenPolicy(request.headers);
    const deviceId = request.headers.get("x-device-id");

    if (policy.refreshTokenDays !== null) {
      const bundle = await issueAccessAndRefresh({
        userId: user.id,
        policy,
        deviceId,
        userAgent: ua,
        ipAddress: ip,
        source: "login.password",
      });
      await auditLog("auth.token.autoissue.native", {
        userId: user.id,
        ipAddress: ip,
        details: { source: "login.password", policy: "native" },
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

    // Web policy with explicit X-Client-Type:native (legacy iOS auto-login)
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
        source: "login.password",
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
