/**
 * Shared "issue the authenticated response" tail used by both the password
 * login route and the `/api/auth/mfa/verify` route.
 *
 * Keeping one implementation guarantees the transport contract is identical
 * whether or not a second factor sat in the middle: a web caller gets a
 * session cookie, a cookie-less native caller gets the access + refresh
 * bundle, and a legacy `X-Client-Type: native` caller gets a plain access
 * token. The only behavioural difference the second factor introduces is the
 * `mfaVerifiedAt` stamp threaded onto the issued session (cookie path) so
 * step-up freshness can read it.
 *
 * Bearer-issuing branches do not carry an `mfaVerifiedAt` equivalent — the
 * step-up primitive (`requireFreshMfa`) is cookie-only by construction, the
 * same structural boundary as `requireAdmin`, so a token transport can never
 * satisfy step-up regardless.
 */
import type { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { createSession } from "@/lib/auth/session";
import { issueApiToken, isNativeClientRequest } from "@/lib/auth/issue-token";
import {
  resolveTokenPolicy,
  shouldIssueBearerToken,
  isCookielessNativeCaller,
} from "@/lib/auth/native-client";
import { issueAccessAndRefresh } from "@/lib/auth/refresh-token";
import { recordSignInDevice } from "@/lib/auth/login-alert";
import { detectInsecureCookieTransport } from "@/lib/auth/secure-cookie";
import { annotate } from "@/lib/logging/context";
import { completePendingOidcLink } from "@/lib/auth/oidc-pending-link";
import type { User } from "@/generated/prisma/client";
import { refuseIfPendingDeletion } from "@/lib/account-deletion/pending";

export interface FinishLoginParams {
  user: Pick<
    User,
    | "id"
    | "username"
    | "onboardingCompletedAt"
    | "deletionRequestedAt"
    | "deletionPurgeAt"
  >;
  request: NextRequest;
  ip: string;
  userAgent: string | null;
  /** Audit `source` discriminator, e.g. `"login.password"` / `"mfa.verify"`. */
  source: string;
  /**
   * When true the issued session is stamped `mfaVerifiedAt = now()` so
   * step-up gates treat it as freshly second-factor-verified. Only the
   * cookie path carries the stamp.
   */
  mfaVerified?: boolean;
}

/**
 * Mint the session/token for an already-authenticated user and return the
 * client response. Caller is responsible for the prior factor checks and for
 * its own `auth.login.*` / `auth.mfa.*` audit entries; this writes only the
 * token-issuance audit rows.
 */
export async function finishLogin(
  params: FinishLoginParams,
): Promise<Response> {
  const { user, request, ip, userAgent, source, mfaVerified } = params;

  // Every sign-in completes here (password, second factor, the native and
  // single sign-on token exchanges), so no credential leaves for an account
  // pending deletion. A credential minted in the moment before a deletion
  // commits is refused on its first use by the session and Bearer resolvers.
  refuseIfPendingDeletion(user);

  // v1.23 — new-device / new-location alert. Fire-and-forget: never let the
  // device ledger or the dispatcher add latency to — or fail — a sign-in. Runs
  // for every transport (web cookie + native bundle) since the factor checks
  // are already done by the time finishLogin is reached.
  void recordSignInDevice({ userId: user.id, ip, userAgent });

  if (
    shouldIssueBearerToken(request.headers) ||
    isNativeClientRequest(request.headers)
  ) {
    const policy = resolveTokenPolicy(request.headers);
    const deviceId = request.headers.get("x-device-id");

    // A 60-day refresh token is only ever delivered to a genuinely
    // cookie-less native caller — a browser spoofing `X-Client-Type: native`
    // falls through to the plain access-token path below.
    if (
      policy.refreshTokenDays !== null &&
      isCookielessNativeCaller(request.headers)
    ) {
      const bundle = await issueAccessAndRefresh({
        userId: user.id,
        policy,
        deviceId,
        userAgent,
        ipAddress: ip,
        source,
      });
      await auditLog("auth.token.autoissue.native", {
        userId: user.id,
        ipAddress: ip,
        details: { source, policy: "native" },
      });
      return apiSuccess({
        user: { id: user.id, username: user.username },
        token: bundle.accessToken,
        tokenExpiresAt: bundle.accessTokenExpiresAt.toISOString(),
        refreshToken: bundle.refreshToken,
        refreshTokenExpiresAt: bundle.refreshTokenExpiresAt.toISOString(),
      });
    }

    // Web policy with explicit X-Client-Type:native (legacy iOS auto-login).
    const issued = await issueApiToken({
      userId: user.id,
      name: `web auto-login ${new Date().toISOString()}`,
      permissions: ["*"],
      expiresInDays: policy.accessTokenDays,
    });
    await auditLog("auth.token.autoissue.native", {
      userId: user.id,
      ipAddress: ip,
      details: { tokenId: issued.tokenId, source, policy: "web" },
    });
    return apiSuccess({
      user: { id: user.id, username: user.username },
      token: issued.token,
      tokenExpiresAt: issued.expiresAt.toISOString(),
    });
  }

  // Browser path — session cookie. Before minting it, surface the single
  // most common self-host snag: a Secure cookie about to be set on a plain-HTTP
  // request drops silently and loops the login. Warn-log + wide-event so an
  // operator sees the cause; the login still completes.
  const transportWarning = detectInsecureCookieTransport(request);
  if (transportWarning) {
    console.warn(
      `[auth] session-cookie transport mismatch: ${transportWarning}`,
    );
    annotate({ meta: { session_cookie_secure_transport_mismatch: true } });
  }

  // A browser sign-in that proved the account's own credential confirms a
  // single sign-on link the callback left pending for this very account. An
  // SSO sign-in is not such a proof, so it never completes one.
  if (!source.startsWith("login.oidc") && source !== "login.web_handoff") {
    await completePendingOidcLink(user.id, ip);
  }

  // `createSession` anchors the onboarding cookie itself; thread the user's
  // onboarding state through.
  await createSession(
    user.id,
    user.onboardingCompletedAt == null,
    ip,
    userAgent,
    mfaVerified ? new Date() : null,
  );

  return apiSuccess({
    user: { id: user.id, username: user.username },
  });
}
