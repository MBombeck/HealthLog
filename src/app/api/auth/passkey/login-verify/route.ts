import { verifyAuthentication } from "@/lib/auth/passkey";
import { createSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  safeJson,
} from "@/lib/api-response";
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
} from "@/lib/auth/native-client";
import { issueAccessAndRefresh } from "@/lib/auth/refresh-token";

export const POST = apiHandler(async (request: NextRequest) => {
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

  const { data: body, error: jsonError } =
    await safeJson<Record<string, unknown>>(request);

  if (jsonError) return jsonError;
  const challengeId = body.challengeId as string | undefined;
  const credential = body.credential;

  if (!challengeId || !credential) {
    return apiError("challengeId and credential required", 422);
  }

  const { verification, passkey } = await verifyAuthentication(
    challengeId,
    credential,
  );

  if (!verification.verified) {
    await auditLog("auth.login.failed", {
      ipAddress: ip,
      details: { reason: "passkey_verification_failed" },
    });
    return apiError("Passkey verification failed", 401);
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
  const ua = request.headers.get("user-agent");
  await createSession(user.id, user.onboardingCompletedAt == null, ip, ua);

  await auditLog("auth.login.passkey", {
    userId: user.id,
    ipAddress: ip,
  });

  annotate({ action: { name: "auth.login.passkey" } });

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
