import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { getClientIp } from "@/lib/api-response";
import { annotate, getEvent } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { s256Challenge } from "@/lib/mcp/oauth/pkce";
import { recentProofMethods } from "@/lib/auth/second-factor";
import { throttleReproof } from "@/lib/auth/existing-factor-proof";
import {
  buildAuthorizationUrl,
  discoverOidcMetadata,
  getOidcConfig,
  getOidcRedirectUri,
  sanitizeOidcNextPath,
} from "@/lib/auth/oidc";
import {
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  OIDC_STATE_TTL_MS,
} from "@/lib/auth/oidc-cookie";
import { OIDC_REPROOF_STAGE, reproofReturnUrl } from "@/lib/auth/oidc-reproof";

export const dynamic = "force-dynamic";

/**
 * Start confirming it is you at the identity provider (#1296).
 *
 * A top-level navigation from the re-proof dialog, cookie session only: a
 * Bearer token never re-proves this way, because a stamp on a session row
 * means nothing to a token (`requireCookieAuth` reads the session cookie and
 * nothing else). Offered only where `recentProofMethods` lists `oidc`, which
 * is an account without a second factor whose identity is linked while a
 * provider is configured; anything else goes straight back with
 * `reproof=failed`.
 *
 * The round trip asks for a fresh authentication (`prompt=login`,
 * `max_age=0`) with its own state, nonce and PKCE verifier, sealed into the
 * same single-use cookie the sign-in uses, together with the account and the
 * session it confirms. The callback stamps that session's `reproofAt` and
 * returns to `next` (a same-origin path) with `reproof=done`. It never mints
 * a session.
 *
 * Draws on the account's shared re-proof budget, like every other proof.
 */
export const GET = apiHandler(async (req: NextRequest) => {
  annotate({ action: { name: "auth.oidc.reproof.start" } });
  const { user, session } = await requireCookieAuth();

  const next = sanitizeOidcNextPath(
    req.nextUrl.searchParams.get("next"),
    req.url,
  );
  const back = (reason: string): NextResponse => {
    annotate({ meta: { reason } });
    return NextResponse.redirect(reproofReturnUrl(next, "failed"));
  };

  const config = getOidcConfig();
  if (!config) return back("oidc_disabled");

  const methods = await recentProofMethods(user);
  if (!methods.includes("oidc")) return back("not_offered");

  const limited = await throttleReproof(
    user.id,
    getClientIp(req),
    OIDC_REPROOF_STAGE,
  );
  if (limited) return back("rate_limited");

  let metadata;
  try {
    metadata = await discoverOidcMetadata(config);
  } catch (err) {
    getEvent()?.setError(err);
    return back("oidc_failed");
  }

  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(64).toString("base64url");

  const response = NextResponse.redirect(
    buildAuthorizationUrl({
      metadata,
      config,
      state,
      nonce,
      codeChallenge: s256Challenge(codeVerifier),
      redirectUri: getOidcRedirectUri(),
      reauthenticate: true,
    }),
  );
  response.cookies.set(
    OIDC_STATE_COOKIE,
    encrypt(
      JSON.stringify({
        state,
        nonce,
        codeVerifier,
        next,
        intent: "reproof" as const,
        reproofUserId: user.id,
        reproofSessionId: session.id,
      }),
    ),
    {
      httpOnly: true,
      secure: shouldEmitSecureCookie(),
      sameSite: "lax",
      maxAge: Math.floor(OIDC_STATE_TTL_MS / 1000),
      path: OIDC_STATE_COOKIE_PATH,
    },
  );
  return response;
});
