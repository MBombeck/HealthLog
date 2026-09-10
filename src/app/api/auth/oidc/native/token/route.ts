/**
 * POST /api/auth/oidc/native/token
 *
 * The cookie-less native leg of the OIDC SSO flow (design spec §4). The app
 * presents the one-time handoff code it received on
 * `healthlog://oidc-callback?code=` plus its PKCE `codeVerifier`; on success it
 * receives the SAME native token bundle password login issues
 * (`{ token, tokenExpiresAt, refreshToken, refreshTokenExpiresAt }`).
 *
 * Security-critical invariants:
 * - It IS the credential mint (same class as `/api/auth/mfa/verify`): no
 *   session or Bearer is required to reach it.
 * - The transport gate (`isCookielessNativeCaller`) makes the endpoint
 *   structurally incapable of minting a web session or handing a 60-day refresh
 *   token into a browser context — a Mozilla UA or an inbound session cookie is
 *   rejected before any state is touched.
 * - `userId` is derived SOLELY from the server-side handoff row — the request
 *   carries no identity field.
 * - A single generic 401 covers not-found / expired / used / PKCE-mismatch /
 *   deleted-user so a code-guesser learns nothing; distinct `annotate` names
 *   keep the wide events diagnosable.
 * - `mfaVerifiedAt` is never set — a Bearer transport can never satisfy
 *   `requireFreshMfa` step-up, so an SSO login can never satisfy step-up.
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
import { isCookielessNativeCaller } from "@/lib/auth/native-client";
import { isNativeClientRequest } from "@/lib/auth/issue-token";
import { finishLogin } from "@/lib/auth/login-response";
import {
  consumeNativeHandoff,
  stampIssuedRefreshToken,
} from "@/lib/auth/oidc-native-handoff";
import { oidcNativeTokenSchema } from "@/lib/validations/oidc-native";

export const dynamic = "force-dynamic";

/** The single generic rejection for every invalid-code class (steps 4–9). */
function invalidCode() {
  return apiError("Invalid or expired code", 401);
}

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "auth.oidc.native.token" } });

  // (1) Rate limit — byte-for-byte the MFA-verify surface's posture, including
  // the trust-violation collapse semantics.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:oidc:native-token",
    10,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    return apiError("Too many attempts. Please try again later.", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  // (2) Transport gate — this endpoint only ever hands a native token bundle.
  // A browser (Mozilla UA or an inbound session cookie) is rejected, AND the
  // caller must present an explicit native marker (`isNativeClientRequest`, the
  // SAME predicate `finishLogin` uses to pick its bearer branch) — otherwise a
  // blank-UA caller could slip past `isCookielessNativeCaller` into the cookie
  // branch and be handed a `Set-Cookie` session instead of the bundle. Both
  // together make the cookie path structurally unreachable here.
  if (
    !isCookielessNativeCaller(request.headers) ||
    !isNativeClientRequest(request.headers)
  ) {
    annotate({ action: { name: "auth.oidc.native.token.wrong_transport" } });
    return invalidCode();
  }

  await ensureDbCompatibility();

  // (3) Body — bounded, then the exact wire contract.
  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = oidcNativeTokenSchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(
      "Invalid request",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }
  const { code, codeVerifier } = parsed.data;

  // (4–8) Lookup + replay/expiry/PKCE + atomic single-use consume.
  const result = await consumeNativeHandoff(code, codeVerifier);
  if (result.status !== "ok") {
    switch (result.status) {
      case "not_found":
        annotate({ action: { name: "auth.oidc.native.token.not_found" } });
        break;
      case "replayed":
        // Containment + the audit row already ran inside `consumeNativeHandoff`;
        // report whether the issued pair was actually revoked (false only in the
        // sub-ms pre-stamp window).
        annotate({
          action: { name: "auth.oidc.native.handoff_replay" },
          meta: { revoked_issued_pair: result.revokedIssuedPair },
        });
        break;
      case "expired":
        annotate({ action: { name: "auth.oidc.native.token.expired" } });
        break;
      case "pkce_mismatch":
        annotate({ action: { name: "auth.oidc.native.pkce_failed" } });
        break;
      case "race_lost":
        annotate({ action: { name: "auth.oidc.native.token.race_lost" } });
        break;
    }
    return invalidCode();
  }

  // (9) Load the user (may have been deleted mid-flight).
  const user = await prisma.user.findUnique({
    where: { id: result.userId },
    select: { id: true, username: true, onboardingCompletedAt: true },
  });
  if (!user) {
    annotate({ action: { name: "auth.oidc.native.token.user_missing" } });
    return invalidCode();
  }

  // (10) Mint the native bundle. Step (2) guarantees the cookie-less-native
  // branch of `finishLogin`, i.e. the 24h access + 60d rotating refresh with
  // the `auth.token.autoissue.native` audit row. `mfaVerified` is deliberately
  // unset — the SSO login can never satisfy step-up.
  const ua = request.headers.get("user-agent");
  const response = await finishLogin({
    user,
    request,
    ip,
    userAgent: ua,
    source: "login.oidc.native",
  });

  // (11) Stamp the issued refresh token's hash for replay-containment
  // reach-back, then audit the completed SSO login. Reading the bundle off a
  // clone leaves the client's response stream intact. Best-effort: the code is
  // already single-use-consumed, so a stamping hiccup only forgoes the
  // replay-revoke for this one row.
  try {
    const bundle = (await response.clone().json()) as {
      data?: { refreshToken?: unknown };
    };
    const refreshToken = bundle.data?.refreshToken;
    if (typeof refreshToken === "string") {
      await stampIssuedRefreshToken(result.handoffId, refreshToken);
    }
  } catch {
    // Non-fatal — see comment above.
  }

  await auditLog("auth.oidc.login", {
    userId: user.id,
    ipAddress: ip,
    details: { transport: "native" },
  });

  return response;
});
